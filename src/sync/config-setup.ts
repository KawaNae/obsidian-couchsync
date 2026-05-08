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
import { ConfigCheckpoints } from "../db/sync/config-checkpoints.ts";
import { ConfigPushPipeline } from "../db/sync/config-push-pipeline.ts";

export interface ConfigSetupResult {
    scanned: number;
    pushed: number;
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

        return { scanned, pushed: pushResult.stats.pushed };
    }
}
