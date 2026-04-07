import type { App } from "obsidian";
import type { LocalDB } from "../db/local-db.ts";
import type { VaultSync } from "./vault-sync.ts";
import type { StatusBar } from "../ui/status-bar.ts";

const CLOCK_SKEW_MARGIN_MS = 5000;

export type CatchUpReason = "onload" | "startSync" | "reconnect" | "manual";

export type CatchUpNotify = (message: string) => void;

/**
 * Scans the vault for files modified since the last cursor position and pushes
 * them through fileToDb. This catches edits the plugin couldn't see in real time:
 * sync was off, plugin was disabled, app was closed, network was down.
 *
 * Cost is near-zero when nothing changed: vault.getFiles() is in-memory and
 * the mtime filter eliminates all candidates before any DB I/O happens.
 */
export class CatchUpScanner {
    private running = false;

    constructor(
        private app: App,
        private localDb: LocalDB,
        private vaultSync: VaultSync,
        private statusBar: StatusBar,
        private notify: CatchUpNotify = () => {},
    ) {}

    /** True while a scan is in progress (used to coordinate with other ops). */
    isRunning(): boolean {
        return this.running;
    }

    /**
     * Run a catch-up scan. Returns the number of files synced (0 if nothing
     * changed or already running). Safe to call repeatedly — concurrent calls
     * are dropped, and unchanged vaults skip all DB I/O.
     */
    async scan(reason: CatchUpReason): Promise<number> {
        if (this.running) return 0;
        this.running = true;
        const startedAt = Date.now();

        try {
            const cursor = await this.localDb.getScanCursor();
            const threshold = (cursor?.lastScanStartedAt ?? 0) - CLOCK_SKEW_MARGIN_MS;

            const files = this.app.vault.getFiles();
            const candidates = files.filter((f) => f.stat.mtime > threshold);

            if (candidates.length === 0) {
                await this.localDb.putScanCursor({
                    lastScanStartedAt: startedAt,
                    lastScanCompletedAt: Date.now(),
                });
                return 0;
            }

            console.log(
                `CouchSync: catch-up scan (${reason}) — ${candidates.length}/${files.length} candidates`,
            );

            // Bulk-fetch existing FileDocs in one allDocs call to avoid an N+1
            // pattern on large migration scans.
            const existingDocs = await this.localDb.getFileDocs(
                candidates.map((f) => f.path),
            );

            let synced = 0;
            for (let i = 0; i < candidates.length; i++) {
                const file = candidates[i];
                // Yield every 50 files so the UI stays responsive on large vaults.
                if (i % 50 === 0) await new Promise<void>((r) => setTimeout(r, 0));
                try {
                    const existing = existingDocs.get(file.path);
                    if (!existing || existing.mtime < file.stat.mtime) {
                        await this.vaultSync.fileToDb(file);
                        synced++;
                        this.statusBar.update(
                            "syncing",
                            `Catch-up: ${i + 1}/${candidates.length}`,
                        );
                    }
                } catch (e) {
                    console.error(`CouchSync: catch-up failed for ${file.path}:`, e);
                }
            }

            await this.localDb.putScanCursor({
                lastScanStartedAt: startedAt,
                lastScanCompletedAt: Date.now(),
            });

            if (synced > 0) {
                console.log(`CouchSync: catch-up (${reason}) synced ${synced} file(s)`);
                this.notify(`Catch-up: synced ${synced} missed edit(s)`);
            }
            return synced;
        } finally {
            this.running = false;
        }
    }
}
