/**
 * ConfigSetupService — Create for the config DB (formerly "Config Init").
 *
 * Mirror of `SetupService` (`src/sync/setup.ts`) for vault sync, but
 * targeting the separate config CouchDB (`couchdbConfigDbName`). Owns
 * the destructive "clean slate" sequence — and ONLY that. Create is purely
 * structural: it establishes an empty, correctly-rooted config DB. It does
 * NOT seed content. Sending this device's `.obsidian/` is a separate
 * `ConfigSync.push()` the user runs afterwards (and which is governed by
 * the meaning-unit filter). Splitting the two keeps a single push concept
 * and makes Create free of any filter/content semantics:
 *
 *   1. Derive the crypto root (`config:meta`) — pure, pre-destructive.
 *   2. Flag the binding as mid-setup, so an interrupted Create blocks
 *      live ops until a fresh Create completes.
 *   3. Wipe local: the binding's store is destroyed and re-opened (docs +
 *      meta + vclock baselines + cursors).
 *   4. Wipe remote: `DELETE /<configDb>` then `PUT /<configDb>`. Requires
 *      CouchDB admin permission. The symmetric counterpart to vault sync's
 *      `SetupService.init`: a real rev tree reset.
 *   5. Pin the crypto root: push `config:meta` (raw, never encrypted) as
 *      the FIRST and ONLY write to the fresh remote.
 *   6. Commit: record the root on the binding (this device is now joined),
 *      save the passphrase Create encrypted with as the explicit config
 *      passphrase, and keep the new key for this session, so the next
 *      `push()` encrypts under the new root.
 *
 * After Create the remote holds only `config:meta` (an empty config DB);
 * the user clicks Push to seed it from the current vault, filtered. Every
 * other device's record now names the old root, so they must Join again.
 *
 * Caller (ConfigSync.create) supplies the raw CouchClient and AbortSignal
 * from its ConfigOperation epoch — we don't allocate clients ourselves.
 */

import type { ICouchClient } from "../db/interfaces.ts";
import type { CouchSyncSettings } from "../settings.ts";
import * as remoteCouch from "../db/remote-couch.ts";
import { makeCouchClient } from "../db/couch-client.ts";
import {
    buildInitialConfigMeta, pushConfigMeta, type ConfigMetaDoc,
} from "../db/vault-meta.ts";
import type { CryptoProvider } from "../db/crypto-provider.ts";
import { logWarn } from "../ui/log.ts";

export interface ConfigSetupResult {
    /** The freshly-built config:meta. */
    meta: ConfigMetaDoc;
    /** New `CryptoProvider` derived from the freshly-generated salt.
     *  Null when `opts.encryption === false`. */
    crypto: CryptoProvider | null;
}

/** The codec Create applies: the resolved config codec of the settings
 *  (ConfigSync passes `resolveConfigCodec(settings)`). */
export interface ConfigSetupCreateOpts {
    encryption: boolean;
    passphrase?: string;
    compression: boolean;
}

/** Binding-side callbacks. Create never touches settings or the local
 *  store directly: the binding owns both. */
export interface ConfigSetupHostHooks {
    /** Persist the mid-setup flag on this binding's record. Called
     *  immediately before the destructive local+remote wipe. A mid-flight
     *  failure leaves it set, so live ops against this DB refuse to run
     *  until a fresh Create completes. */
    beginSetup: () => Promise<void>;
    /** Empty and re-open this binding's local store. */
    resetLocal: () => Promise<void>;
    /** Build a RAW config-DB client (no codec wrapping) for pushing the
     *  meta doc, which is itself never encrypted or compressed. Omitted →
     *  `makeCouchClient(settings)`. */
    makeRawConfigClient?: () => ICouchClient;
    /** Create fully succeeded: record the new root (clearing the setup
     *  flag, saving the passphrase) and keep its key — one commit. */
    commit: (meta: ConfigMetaDoc, crypto: CryptoProvider | null) => Promise<void>;
}

export class ConfigSetupService {
    constructor(
        private getSettings: () => CouchSyncSettings,
        private host: ConfigSetupHostHooks,
    ) {}

    async create(
        client: ICouchClient,
        signal: AbortSignal,
        onProgress: (msg: string) => void,
        opts: ConfigSetupCreateOpts,
    ): Promise<ConfigSetupResult> {
        // 1. Derive the crypto root FIRST — a SELF-CONTAINED config:meta
        //    (its own crypto root, independent of the vault DB): fresh salt +
        //    own keyCheck. PURE (no remote I/O), so a key-derivation failure
        //    leaves both the local and remote DBs untouched — nothing to recover.
        if (!this.getSettings().couchdbConfigDbName) {
            throw new Error("ConfigSetup: couchdbConfigDbName not configured");
        }
        const { meta, crypto } = await buildInitialConfigMeta(opts);

        // 2. Flag BEFORE the destructive wipe.
        await this.host.beginSetup();

        // 3. Wipe local.
        onProgress("Wiping local config database...");
        await this.host.resetLocal();

        // 4. Wipe remote. DELETE /<db> + PUT /<db> — true rev-tree reset so
        //    the next push lands at rev=1- instead of stacking on top.
        //    Requires admin permission; tolerates 404 (DB already gone).
        onProgress("Recreating remote config database...");
        await remoteCouch.recreateRemote(client, signal);

        // 5. Pin the crypto root: config:meta is the FIRST and ONLY write
        //    after ensureDb, so the window in which the remote config DB
        //    exists WITHOUT an authoritative meta is as small as possible.
        //    A failure here leaves the setup flag set (this device
        //    stays fail-closed), and a peer sees a meta-less DB it reports
        //    as uninitialized rather than corrupt.
        await this.pushConfigMetaRaw(meta);

        // 6. Commit. Create is structural only — seeding is the user's next,
        //    filter-governed Push, which encrypts under the root committed
        //    here (the fail-closed "no plaintext into an encrypted DB" guard
        //    lives in ConfigBinding.wrapClient).
        await this.host.commit(meta, crypto);

        return { meta, crypto };
    }

    /** Push an already-built self-contained config:meta via a RAW client so
     *  the meta itself bypasses the envelope codec stack (a joining device
     *  can read it before unlocking the passphrase). Network errors surface up
     *  — this write is **load-bearing** (it pins the crypto root) and must
     *  succeed before Create can proceed. The meta is built separately, before
     *  any destruction, so this method only does the (post-ensureDb) push. */
    private async pushConfigMetaRaw(meta: ConfigMetaDoc): Promise<void> {
        const settings = this.getSettings();
        // The meta doc bypasses the codec stack (never encrypted or
        // compressed). Tests inject a raw client; production builds it from
        // settings.
        const rawConfigClient = this.host.makeRawConfigClient?.()
            ?? makeCouchClient(
                settings.couchdbUri, settings.couchdbConfigDbName,
                settings.couchdbUser, settings.couchdbPassword,
            );
        try {
            await pushConfigMeta(rawConfigClient, meta);
        } catch (e: any) {
            // Network errors here are visible — the meta is the crypto root and
            // a failed write would leave the config DB without an authoritative
            // descriptor. Re-throw so the user sees the Create failure rather
            // than a silent corrupt state.
            logWarn(`ConfigSetup: config:meta push failed: ${e?.message ?? e}`);
            throw e;
        }
    }
}
