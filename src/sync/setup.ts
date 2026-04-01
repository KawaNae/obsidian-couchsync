import type { App } from "obsidian";
import type { LocalDB } from "../db/local-db.ts";
import type { Replicator } from "../db/replicator.ts";
import type { VaultSync } from "./vault-sync.ts";

export interface SetupResult {
    vaultFiles: number;
    totalDocs: number;
}

export class SetupService {
    constructor(
        private app: App,
        private localDb: LocalDB,
        private replicator: Replicator,
        private vaultSync: VaultSync,
    ) {}

    /** Init: clean slate (local + remote) → scan vault → push */
    async init(onProgress: (msg: string) => void): Promise<SetupResult> {
        return this.withWakeLock(async () => {
            onProgress("Initializing local database...");
            await this.localDb.destroy();
            this.localDb.open();

            onProgress("Initializing remote database...");
            await this.replicator.destroyRemote();

            onProgress("Scanning vault files...");
            const vaultFiles = await this.scanVaultToDb(onProgress);

            onProgress("Pushing to remote...");
            const totalDocs = await this.replicator.pushToRemote((docId, n) => {
                onProgress(`Pushing: ${docId} (${n})`);
            });

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
            const totalDocs = await this.replicator.pullFromRemote((docId, n) => {
                onProgress(`Pulling: ${docId} (${n})`);
            });

            const allFiles = await this.localDb.allFileDocs();
            onProgress(`Writing ${allFiles.length} vault files...`);
            let vaultFiles = 0;
            for (const fileDoc of allFiles) {
                try {
                    onProgress(`Writing: ${fileDoc._id} (${vaultFiles + 1}/${allFiles.length})`);
                    await this.vaultSync.dbToFile(fileDoc);
                    vaultFiles++;
                } catch (e) {
                    console.error(`CouchSync: Failed to write ${fileDoc._id}:`, e);
                }
            }

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
        const files = this.app.vault.getFiles();
        let synced = 0;
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            try {
                onProgress(`Scanning: ${file.path} (${i + 1}/${files.length})`);
                await this.vaultSync.fileToDb(file);
                synced++;
            } catch (e) {
                console.error(`CouchSync: Failed to scan ${file.path}:`, e);
            }
        }
        return synced;
    }
}
