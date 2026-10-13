import type { IVaultIO } from "../types/vault-io.ts";
import type { LocalDB } from "../db/local-db.ts";
import type { VaultRemoteOps } from "../db/sync/vault-remote-ops.ts";
import type { VaultSync } from "./vault-sync.ts";
import type { Reconciler } from "./reconciler.ts";
import { filePathFromId, parseDocId } from "../types/doc-id.ts";
import { logError } from "../ui/log.ts";

/**
 * Format a doc `_id` for progress display. Files show their vault path,
 * chunks show a truncated hash, configs show their config path. Keeps
 * the replicator's progress callbacks unopinionated (they pass the raw
 * `_id`) while still giving users meaningful text in the notice.
 */
function formatDocIdForProgress(id: string): string {
    const parsed = parseDocId(id);
    switch (parsed.kind) {
        case "file":   return parsed.path;
        case "config": return parsed.path;
        case "chunk":  return `chunk ${parsed.hash.slice(0, 8)}`;
        default:       return id;
    }
}

export interface SetupResult {
    /** Init: vault files scanned into the local DB. Clone: vault files
     *  written from the remote (deletions and declined docs excluded). */
    vaultFiles: number;
    totalDocs: number;
}

export class SetupService {
    constructor(
        private vault: IVaultIO,
        private localDb: LocalDB,
        private remoteOps: VaultRemoteOps,
        private vaultSync: VaultSync,
        private reconciler: Reconciler,
    ) {}

    /**
     * Init: clean slate (local + remote) → publish the new vault:meta → scan
     * vault → push.
     *
     * `publishMeta` writes the new `vault:meta` into the re-created remote
     * DB before anything else. A device still live-syncing with the DB this
     * Init replaced tells the replacement by that meta (the pull wakes on
     * it; the agreement check compares it), so the sooner it is there, the
     * shorter the time that device can push into the new DB unnoticed.
     */
    async init(
        onProgress: (msg: string) => void,
        publishMeta: () => Promise<void>,
    ): Promise<SetupResult> {
        return this.withWakeLock(async () => {
            onProgress("Initializing local database...");
            await this.localDb.destroy();
            this.localDb.open();
            await this.localDb.ensureSchemaVersion();

            onProgress("Initializing remote database...");
            await this.remoteOps.recreateRemote();
            onProgress("Writing vault metadata...");
            await publishMeta();

            onProgress("Scanning vault files...");
            const vaultFiles = await this.scanVaultToDb(onProgress);

            onProgress("Pushing to remote...");
            const totalDocs = await this.remoteOps.pushAll((docId, n) => {
                onProgress(`Pushing: ${formatDocIdForProgress(docId)} (${n})`);
            });

            // Initialise manifest + cursor for the new vault state.
            onProgress("Reconciling...");
            await this.reconciler.reconcile("setup");

            return { vaultFiles, totalDocs };
        });
    }

    /** Clone: clean slate (local) → pull all → write vault files */
    async clone(onProgress: (msg: string) => void): Promise<SetupResult> {
        return this.withWakeLock(async () => {
            onProgress("Initializing local database...");
            await this.localDb.destroy();
            this.localDb.open();
            await this.localDb.ensureSchemaVersion();

            onProgress("Pulling from remote...");
            const totalDocs = await this.remoteOps.pullAll((docId, n) => {
                onProgress(`Pulling: ${formatDocIdForProgress(docId)} (${n})`);
            });

            // Every FileDoc goes through dbToFile, tombstones included (they
            // establish the deleted baseline). Only an alive doc that landed
            // in the vault counts as a file written: a tombstone is a file
            // deleted elsewhere, and a doc dbToFile declines (filtered,
            // unsafe path, collision) or fails on is not in the vault.
            const allFiles = await this.localDb.allFileDocs();
            const alive = allFiles.filter((d) => !d.deleted).length;
            onProgress(`Writing ${alive} vault files...`);
            let vaultFiles = 0;
            let done = 0;
            for (const fileDoc of allFiles) {
                const vaultPath = filePathFromId(fileDoc._id);
                try {
                    if (!fileDoc.deleted) {
                        onProgress(`Writing: ${vaultPath} (${++done}/${alive})`);
                    }
                    const result = await this.vaultSync.dbToFile(fileDoc);
                    if (!fileDoc.deleted && result.applied) vaultFiles++;
                } catch (e) {
                    logError(`Failed to write ${vaultPath}: ${e?.message ?? e}`);
                }
            }

            // Reconcile resolves any leftover drift (vault contained files
            // before clone, chunk arrival races, etc.) and seeds the manifest.
            onProgress("Reconciling...");
            await this.reconciler.reconcile("setup");

            return { vaultFiles, totalDocs };
        });
    }

    /** Keep screen on during long-running operations (mobile) */
    private async withWakeLock<T>(fn: () => Promise<T>): Promise<T> {
        let wakeLock: any = null;
        try {
            if ("wakeLock" in navigator) {
                wakeLock = await (navigator as any).wakeLock.request("screen");
            }
        } catch {
            // WakeLock not available or permission denied
        }
        try {
            return await fn();
        } finally {
            try { await wakeLock?.release(); } catch { /* already released */ }
        }
    }

    /** Scan all vault files to local DB (no mtime check — clean start) */
    private async scanVaultToDb(onProgress: (msg: string) => void): Promise<number> {
        const files = this.vault.getFiles();
        let synced = 0;
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            try {
                onProgress(`Scanning: ${file.path} (${i + 1}/${files.length})`);
                await this.vaultSync.fileToDb(file.path);
                synced++;
            } catch (e) {
                logError(`Failed to scan ${file.path}: ${e?.message ?? e}`);
            }
        }
        return synced;
    }
}
