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
     *  Production wires this to `makeCouchClient`; tests can inject a
     *  FakeCouchClient so the meta push runs against the same in-memory
     *  remote as the rest of the test fixture. Optional — when absent,
     *  the meta push falls back to `makeCouchClient(settings)` which
     *  hits the real network. */
    makeRawConfigClient?: () => ICouchClient;
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
        // 1. Wipe local DB completely (meta + docs in one go).
        onProgress("Wiping local config database...");
        await this.db.destroy();
        this.db.open();
        this.host.clearLastSynced();
        this.host.invalidateCheckpoints();

        // 2. Wipe remote. DELETE /<db> + PUT /<db> — true rev-tree reset
        //    so the next push lands at rev=1- instead of stacking on top.
        //    Requires admin permission; tolerates 404 (DB already gone).
        onProgress("Destroying remote config database...");
        await remoteCouch.destroyRemote(client, signal);
        onProgress("Recreating remote config database...");
        await client.ensureDb(signal);

        // 2b. Build the config:meta as a SELF-CONTAINED crypto root
        //     (Phase 2: invariants 17 + 18). Fresh salt + own keyCheck
        //     means this config DB is verifiable on any device that
        //     holds `opts.passphrase` — vault DB sharing is no longer
        //     required. The new cryptoProvider is fed back to the host
        //     so subsequent `wrapConfigClient` / chunk hasher calls in
        //     this same Init flow use the correct keys.
        const { meta, crypto } = await this.buildAndPushConfigMeta(opts);
        this.host.onCryptoProviderReady(crypto);

        // 3. Scan vault → local DB. lastSynced is empty so nothing
        //    short-circuits; every file gets a fresh write with vclock={device:1}.
        const scanned = await this.host.scan((path, i, total) => {
            onProgress(`Scanning: ${path} (${i}/${total})`);
        });

        // 4. Push everything to the now-empty remote. Conflicts are
        //    impossible (no remote rev tree to clash with), so this is
        //    effectively a one-shot bulk write.
        const checkpoints = new ConfigCheckpoints(this.db);
        await checkpoints.load(); // both seqs are 0 after destroy
        const pipeline = new ConfigPushPipeline({
            db: this.db,
            client,
            checkpoints,
            getDeviceId: () => this.getSettings().deviceId,
            signal,
        });
        const pushResult = await pipeline.run((msg) => onProgress(msg));

        return { scanned, pushed: pushResult.stats.pushed, meta, crypto };
    }

    /** Build a fresh self-contained config:meta (own salt, own keyCheck)
     *  and push it via a RAW client so the meta itself bypasses the
     *  envelope codec stack. Network errors surface up — unlike Phase 1
     *  this write is **load-bearing** (it pins the crypto root) and
     *  must succeed before the Init can return. */
    private async buildAndPushConfigMeta(
        opts: ConfigSetupInitOpts,
    ): Promise<{ meta: ConfigMetaDoc; crypto: CryptoProvider | null }> {
        const settings = this.getSettings();
        if (!settings.couchdbConfigDbName) {
            throw new Error("ConfigSetup: couchdbConfigDbName not configured");
        }
        const rawConfigClient = this.host.makeRawConfigClient?.()
            ?? makeCouchClient(
                settings.couchdbUri, settings.couchdbConfigDbName,
                settings.couchdbUser, settings.couchdbPassword,
            );
        const { meta, crypto } = await buildInitialConfigMeta(opts);
        try {
            await pushConfigMeta(rawConfigClient, meta);
        } catch (e: any) {
            // Network errors here are visible — the meta is the crypto
            // root and a failed write would leave the config DB without
            // an authoritative descriptor. Re-throw so the user sees
            // the Init failure rather than a silent corrupt state.
            logWarn(`ConfigSetup: config:meta push failed: ${e?.message ?? e}`);
            throw e;
        }
        return { meta, crypto };
    }
}
