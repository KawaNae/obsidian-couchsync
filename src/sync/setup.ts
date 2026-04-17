import type { IVaultIO } from "../types/vault-io.ts";
import type { LocalDB } from "../db/local-db.ts";
import type { SyncEngine } from "../db/sync-engine.ts";
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
    vaultFiles: number;
    totalDocs: number;
}

export class SetupService {
    constructor(
        private vault: IVaultIO,
        private localDb: LocalDB,
        private replicator: SyncEngine,
        private vaultSync: VaultSync,
        private reconciler: Reconciler,
    ) {}

    /** Init: clean slate (local + remote) → scan vault → push */
    async init(onProgress: (msg: string) => void): Promise<SetupResult> {
        return this.withWakeLock(async () => {
            onProgress("Initializing local database...");
            await this.localDb.destroy();
            this.localDb.open();

            onProgress("Initializing remote database...");
            await this.replicator.destroyRemote();
            await this.replicator.ensureRemoteDb();

            onProgress("Scanning vault files...");
            const vaultFiles = await this.scanVaultToDb(onProgress);

            onProgress("Pushing to remote...");
            const totalDocs = await this.replicator.pushToRemote((docId, n) => {
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

            onProgress("Pulling from remote...");
            const { written: totalDocs } = await this.replicator.pullFromRemote((docId, n) => {
                onProgress(`Pulling: ${formatDocIdForProgress(docId)} (${n})`);
            });

            const allFiles = await this.localDb.allFileDocs();
            onProgress(`Writing ${allFiles.length} vault files...`);
            let vaultFiles = 0;
            for (const fileDoc of allFiles) {
                const vaultPath = filePathFromId(fileDoc._id);
                try {
                    onProgress(`Writing: ${vaultPath} (${vaultFiles + 1}/${allFiles.length})`);
                    await this.vaultSync.dbToFile(fileDoc);
                    vaultFiles++;
                } catch (e) {
                    logError(`CouchSync: Failed to write ${vaultPath}: ${e?.message ?? e}`);
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
                logError(`CouchSync: Failed to scan ${file.path}: ${e?.message ?? e}`);
            }
        }
        return synced;
    }
}
