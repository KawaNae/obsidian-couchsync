import type { App, TAbstractFile, TFile } from "obsidian";
import type { VaultSync, IWriteIgnore } from "./vault-sync.ts";
import type { CouchSyncSettings } from "../settings.ts";
import { logError } from "../ui/log.ts";

/** Narrow TAbstractFile to TFile by checking for the `stat` property. */
function isTFile(file: TAbstractFile): file is TFile {
    return "stat" in file;
}

export class ChangeTracker implements IWriteIgnore {
    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    private pendingMinInterval = new Map<string, ReturnType<typeof setTimeout>>();
    private lastSyncTime = new Map<string, number>();
    private eventRefs: ReturnType<App["vault"]["on"]>[] = [];
    /**
     * Paths whose next `modify` / `create` event should be treated as a
     * sync-driven echo and dropped. VaultSync.dbToFile registers the path
     * before calling vault.modifyBinary; Obsidian fires the resulting modify
     * event synchronously during the write, so by the time modifyBinary's
     * promise resolves the token has already been consumed. If the event
     * never fires (e.g. the write was a no-op), dbToFile's finally block
     * clears the stale token to avoid suppressing a later user edit.
     */
    private pendingWriteIgnores = new Set<string>();
    /** Paths whose next `delete` event should be treated as sync-driven. */
    private pendingDeleteIgnores = new Set<string>();

    constructor(
        private app: App,
        private vaultSync: VaultSync,
        private getSettings: () => CouchSyncSettings
    ) {}

    start(): void {
        this.eventRefs.push(
            this.app.vault.on("modify", (file) => {
                if (!isTFile(file)) return;
                if (this.pendingWriteIgnores.delete(file.path)) return;
                this.scheduleSync(file);
            })
        );

        this.eventRefs.push(
            this.app.vault.on("create", (file) => {
                if (!isTFile(file)) return;
                if (this.pendingWriteIgnores.delete(file.path)) return;
                this.scheduleSync(file);
            })
        );

        this.eventRefs.push(
            this.app.vault.on("delete", (file) => {
                this.cancelPending(file.path);
                this.lastSyncTime.delete(file.path);
                if (this.pendingDeleteIgnores.delete(file.path)) return;
                this.vaultSync.markDeleted(file.path).catch((e) =>
                    logError(`CouchSync: markDeleted failed: ${file.path} ${e?.message ?? e}`),
                );
            })
        );

        this.eventRefs.push(
            this.app.vault.on("rename", (file, oldPath) => {
                this.cancelPending(oldPath);
                this.lastSyncTime.delete(oldPath);
                if (isTFile(file)) {
                    this.vaultSync.handleRename(file, oldPath).catch((e) =>
                        logError(`CouchSync: handleRename failed: ${oldPath} → ${file.path} ${e?.message ?? e}`),
                    );
                }
            })
        );
    }

    stop(): void {
        for (const ref of this.eventRefs) {
            this.app.vault.offref(ref);
        }
        this.eventRefs = [];
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        for (const timer of this.pendingMinInterval.values()) clearTimeout(timer);
        this.pendingMinInterval.clear();
    }


    /**
     * Mark the next `modify` / `create` event on `path` as sync-driven so
     * the change handler drops it instead of enqueuing a push. Callers MUST
     * pair this with clearIgnore() in a finally block to avoid leaking a
     * stale token when the write is a no-op (content unchanged, no event).
     */
    ignoreWrite(path: string): void {
        this.pendingWriteIgnores.add(path);
    }

    /** Register that the next `delete` event on `path` is sync-driven. */
    ignoreDelete(path: string): void {
        this.pendingDeleteIgnores.add(path);
    }

    /** Drop any pending write ignore for `path`. Safe to call redundantly. */
    clearIgnore(path: string): void {
        this.pendingWriteIgnores.delete(path);
    }

    private scheduleSync(file: TFile): void {
        this.cancelPending(file.path);

        const debounceMs = this.getSettings().syncDebounceMs;
        const timer = setTimeout(() => {
            this.timers.delete(file.path);
            this.trySync(file);
        }, debounceMs);

        this.timers.set(file.path, timer);
    }

    private trySync(file: TFile): void {
        const minIntervalMs = this.getSettings().syncMinIntervalMs;
        if (minIntervalMs > 0) {
            const last = this.lastSyncTime.get(file.path) ?? 0;
            const elapsed = Date.now() - last;
            if (elapsed < minIntervalMs) {
                const existing = this.pendingMinInterval.get(file.path);
                if (existing) clearTimeout(existing);
                const delay = minIntervalMs - elapsed;
                const t = setTimeout(() => {
                    this.pendingMinInterval.delete(file.path);
                    this.runSync(file);
                }, delay);
                this.pendingMinInterval.set(file.path, t);
                return;
            }
        }
        this.runSync(file);
    }

    private runSync(file: TFile): void {
        this.lastSyncTime.set(file.path, Date.now());
        this.vaultSync.fileToDb(file).catch((e) => {
            logError(`CouchSync: Failed to sync ${file.path}: ${e?.message ?? e}`);
        });
    }

    private cancelPending(path: string): void {
        const existing = this.timers.get(path);
        if (existing) {
            clearTimeout(existing);
            this.timers.delete(path);
        }
        const pending = this.pendingMinInterval.get(path);
        if (pending) {
            clearTimeout(pending);
            this.pendingMinInterval.delete(path);
        }
    }
}
