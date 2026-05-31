/**
 * ConfigSetupService — admin-side init for the config DB.
 *
 * Mirror of `SetupService` (`src/sync/setup.ts`) for vault sync, but
 * targeting the separate config CouchDB (`couchdbConfigDbName`). Owns
 * the destructive "clean slate" sequence:
 *
 *   1. Wipe local: `ConfigLocalDB.destroy()` removes the IndexedDB store
 *      entirely (docs + meta + vclock baselines + cursors), then re-open.
 *   2. Wipe remote: `DELETE /<configDb>` then `PUT /<configDb>`. Requires
 *      CouchDB admin permission. This is the symmetric counterpart to
 *      vault sync's `SetupService.init` and produces a real rev tree
 *      reset (rev=1- instead of the legacy "snapshot push on top of an
 *      existing rev tree" that left tombstones forever).
 *   3. Scan vault → seed local DB. Same `ConfigSync.scan()` as the
 *      regular push path; with cleared lastSynced, the short-circuit
 *      naturally lets every file through on this first pass.
 *   4. Push all to empty remote via `ConfigPushPipeline`. No conflicts
 *      possible (remote is empty), so the cursor advances cleanly.
 *
 * Caller (ConfigSync.init) supplies the live CouchClient and AbortSignal
 * from its ConfigOperation epoch — we don't allocate clients ourselves.
 *
 * No reconcile step (vault sync's SetupService has one): config data
 * lives in the .obsidian/ tree and is reapplied to the filesystem via
 * `ConfigSync.write()` on a subsequent pull, not during init.
 */

import type { ICouchClient } from "../db/interfaces.ts";
import type { ConfigLocalDB } from "../db/config-local-db.ts";
import type { CouchSyncSettings } from "../settings.ts";
import * as remoteCouch from "../db/remote-couch.ts";
import { makeCouchClient } from "../db/couch-client.ts";
import {
    buildInitialConfigMeta, pushConfigMeta, type ConfigMetaDoc,
} from "../db/vault-meta.ts";
import type { CryptoProvider } from "../db/crypto-provider.ts";
import { codecFingerprint } from "./config-codec-policy.ts";
import { logWarn } from "../ui/log.ts";
import { ConfigCheckpoints } from "../db/sync/config-checkpoints.ts";
import { ConfigPushPipeline } from "../db/sync/config-push-pipeline.ts";

export interface ConfigSetupResult {
    scanned: number;
    pushed: number;
    /** The freshly-built config:meta. Returned so the host can store
     *  the doc reference for diagnostics / future re-Init paths. */
    meta: ConfigMetaDoc;
    /** New `CryptoProvider` derived from the freshly-generated salt.
     *  Null when `opts.encryption === false`. The host (main.ts)
     *  installs this onto `configCryptoProvider` so subsequent
     *  `wrapConfigClient` calls pick it up (invariant 18). */
    crypto: CryptoProvider | null;
}

/** Phase 2 init options: an explicit codec policy passed to
 *  ConfigSetupService.init. Phase 1 cloned silently from vault:meta;
 *  Phase 2 makes the choice explicit at the call site (ConfigSync.init
 *  forwards user settings here). */
export interface ConfigSetupInitOpts {
    encryption: boolean;
    passphrase?: string;
    compression: boolean;
}

/** Local-state callbacks the host ConfigSync exposes. After local DB
 *  destroy, in-memory caches in the host need to be reset so subsequent
 *  ops re-derive from the new (empty) DB. */
export interface ConfigSetupHostHooks {
    /** Drop in-memory lastSynced cache (mirrors disk wipe). */
    clearLastSynced: () => void;
    /** Force checkpoint reload on next ensureCheckpointsLoaded(). */
    invalidateCheckpoints: () => void;
    /** Run the host's vault scan. ConfigSync owns scan(); we delegate
     *  to it so SKIP_FILES / SKIP_PATHS / size limits stay in one place. */
    scan: (
        onProgress: (path: string, index: number, total: number) => void,
    ) => Promise<number>;
    /** Hand the freshly-built cryptoProvider back to the host so it
     *  takes effect for downstream `wrapConfigClient` / chunk hasher
     *  calls. Called from inside the init flow once `buildInitialMeta`
     *  resolves. Null = encryption disabled. */
    onCryptoProviderReady: (crypto: CryptoProvider | null) => void;
    /** Build a RAW config-DB client (no codec wrapping) for pushing
     *  the meta doc, which is itself never encrypted or compressed.
     *  Production omits this and the meta push falls back to
     *  `makeCouchClient(settings)`; tests inject a FakeCouchClient so the
     *  meta push runs against the same in-memory remote as the rest of
     *  the test fixture. */
    makeRawConfigClient?: () => ICouchClient;
    /** Persist the config-setup-in-progress flag (Invariant C, config side).
     *  Called with `true` immediately before the destructive local+remote
     *  wipe and `false` only after a fully-successful init. A mid-flight
     *  failure leaves it `true` so the host blocks sync against the half-built
     *  config DB (#err-9). Optional: omitted in tests that don't exercise
     *  crash atomicity. */
    markSettingUp?: (active: boolean) => Promise<void>;
    /** Build a config client wrapped with the CURRENT crypto provider. Called
     *  AFTER `onCryptoProviderReady`, so the push uses the freshly-derived
     *  config keys. Without this the push reused the client captured at init
     *  start (old/plaintext provider), encrypting docs under a DIFFERENT key
     *  than config:meta — making every config doc undecryptable on all devices
     *  (#config-codec). Optional: tests that don't exercise encryption omit it
     *  and fall back to the init-time client. */
    makeEncryptingClient?: () => ICouchClient;
    /** Record the codec fingerprint this Init applied, on full success
     *  (#config-codec). The host persists it as `settings.configCodecApplied`;
     *  a later live op compares the live resolved codec against it and refuses
     *  to sync when they drift (the config-side equivalent of vault sync's
     *  "codec change ⇒ re-init"). Optional: omitted in tests that don't
     *  exercise the dirty gate. */
    recordCodecApplied?: (fingerprint: string) => Promise<void>;
}

export class ConfigSetupService {
    constructor(
        private db: ConfigLocalDB,
        private getSettings: () => CouchSyncSettings,
        private host: ConfigSetupHostHooks,
    ) {}

    async init(
        client: ICouchClient,
        signal: AbortSignal,
        onProgress: (msg: string) => void,
        opts: ConfigSetupInitOpts,
    ): Promise<ConfigSetupResult> {
        // 0. Derive the crypto root FIRST — a SELF-CONTAINED config:meta
        //    (Phase 2: invariants 17 + 18): fresh salt + own keyCheck derived
        //    from `opts.passphrase`. This is a PURE computation (no remote
        //    I/O), so deriving it BEFORE any destruction means a key-derivation
        //    failure leaves both the local and remote DBs untouched — nothing
        //    to recover (M-2). The crypto is fed back to the host after the
        //    meta is pinned on the remote (step 4) so subsequent
        //    `wrapConfigClient` / chunk-hasher calls use the correct keys.
        if (!this.getSettings().couchdbConfigDbName) {
            throw new Error("ConfigSetup: couchdbConfigDbName not configured");
        }
        const { meta, crypto } = await buildInitialConfigMeta(opts);

        // 1. Persist the setup-in-progress flag BEFORE the destructive wipe
        //    (Invariant C, config side). If the process dies after this point
        //    the flag stays true and the host refuses to sync the half-built
        //    config DB until a fresh Init clears it (#err-9). The crypto
        //    derivation above is pre-destructive, so a failure there never
        //    reaches this latch.
        await this.host.markSettingUp?.(true);

        // 2. Wipe local DB completely (meta + docs in one go).
        onProgress("Wiping local config database...");
        await this.db.destroy();
        this.db.open();
        this.host.clearLastSynced();
        this.host.invalidateCheckpoints();

        // 3. Wipe remote. DELETE /<db> + PUT /<db> — true rev-tree reset
        //    so the next push lands at rev=1- instead of stacking on top.
        //    Requires admin permission; tolerates 404 (DB already gone).
        onProgress("Destroying remote config database...");
        await remoteCouch.destroyRemote(client, signal);
        onProgress("Recreating remote config database...");
        await client.ensureDb(signal);

        // 4. Pin the crypto root: push config:meta as the FIRST operation
        //    after ensureDb, with nothing between, so the window in which the
        //    remote config DB exists WITHOUT an authoritative meta is as small
        //    as possible (M-2). A failure here leaves the remote freshly
        //    recreated but meta-less; the setup latch (step 1) keeps THIS
        //    device fail-closed, and a peer reading the DB in that window sees
        //    a no-meta DB it treats as un-/mid-setup rather than corrupt.
        await this.pushConfigMetaRaw(meta);
        this.host.onCryptoProviderReady(crypto);

        // 5. Scan vault → local DB. lastSynced is empty so nothing
        //    short-circuits; every file gets a fresh write with vclock={device:1}.
        const scanned = await this.host.scan((path, i, total) => {
            onProgress(`Scanning: ${path} (${i}/${total})`);
        });

        // 6. Push everything to the now-empty remote. Conflicts are
        //    impossible (no remote rev tree to clash with), so this is
        //    effectively a one-shot bulk write.
        const checkpoints = new ConfigCheckpoints(this.db);
        await checkpoints.load(); // both seqs are 0 after destroy
        // Push with a client wrapped by the just-derived crypto provider (set
        // via onCryptoProviderReady above), NOT the `client` captured at init
        // start — otherwise docs encrypt under a different key than config:meta
        // and become undecryptable everywhere (#config-codec).
        //
        // Fail-closed, symmetric with wrapConfigClient / wrapVaultClient (L-1):
        // when the codec is ENCRYPTED the encrypting client is mandatory.
        // Falling back to the raw init-time `client` here would silently push
        // PLAINTEXT config bodies into an encrypted config DB. Only the
        // plaintext path may fall back to the raw client (used by tests that
        // don't wire the hook; in production the wrapped client also carries
        // the compression layer, so the hook is still preferred there).
        let pushClient: ICouchClient;
        if (opts.encryption) {
            if (!this.host.makeEncryptingClient) {
                throw new Error(
                    "ConfigSetup: encrypted init requires an encrypting client " +
                        "(makeEncryptingClient hook missing) — refusing to push " +
                        "plaintext config bodies into an encrypted config DB.",
                );
            }
            pushClient = this.host.makeEncryptingClient();
        } else {
            pushClient = this.host.makeEncryptingClient?.() ?? client;
        }
        const pipeline = new ConfigPushPipeline({
            db: this.db,
            client: pushClient,
            checkpoints,
            getDeviceId: () => this.getSettings().deviceId,
            signal,
        });
        const pushResult = await pipeline.run((msg) => onProgress(msg));

        // Init fully succeeded — record the codec this Init applied so live ops
        // can detect a later policy drift (#config-codec), then clear the
        // setup-in-progress flag (#err-9). Order: record the applied codec
        // BEFORE clearing settingUp, so an interruption between the two still
        // leaves the DB blocked (settingUp true) rather than wrongly readable.
        await this.host.recordCodecApplied?.(codecFingerprint({
            encryption: opts.encryption,
            passphrase: opts.passphrase ?? "",
            compression: opts.compression,
        }));
        await this.host.markSettingUp?.(false);

        return { scanned, pushed: pushResult.stats.pushed, meta, crypto };
    }

    /** Push an already-built self-contained config:meta via a RAW client so
     *  the meta itself bypasses the envelope codec stack (a fresh-Clone device
     *  can read it before unlocking the passphrase). Network errors surface up
     *  — this write is **load-bearing** (it pins the crypto root) and must
     *  succeed before Init can proceed. The meta is built separately, before
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
            // descriptor. Re-throw so the user sees the Init failure rather
            // than a silent corrupt state.
            logWarn(`ConfigSetup: config:meta push failed: ${e?.message ?? e}`);
            throw e;
        }
    }
}
