import type { IVaultEvents, VaultEventRef } from "../types/vault-events.ts";
import type { VaultSync, IWriteIgnore } from "./vault-sync.ts";
import type { CouchSyncSettings } from "../settings.ts";
import { logError } from "../ui/log.ts";

export class ChangeTracker implements IWriteIgnore {
    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    private pendingMinInterval = new Map<string, ReturnType<typeof setTimeout>>();
    private lastSyncTime = new Map<string, number>();
    private eventRefs: VaultEventRef[] = [];
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
        private events: IVaultEvents,
        private vaultSync: VaultSync,
        private getSettings: () => CouchSyncSettings
    ) {}

    start(): void {
        this.eventRefs.push(
            this.events.on("modify", (path) => {
                if (this.pendingWriteIgnores.delete(path)) return;
                this.scheduleSync(path);
            })
        );

        this.eventRefs.push(
            this.events.on("create", (path) => {
                if (this.pendingWriteIgnores.delete(path)) return;
                this.scheduleSync(path);
            })
        );

        this.eventRefs.push(
            this.events.on("delete", (path) => {
                this.cancelPending(path);
                this.lastSyncTime.delete(path);
                if (this.pendingDeleteIgnores.delete(path)) return;
                this.vaultSync.markDeleted(path).catch((e) =>
                    logError(`CouchSync: markDeleted failed: ${path} ${e?.message ?? e}`),
                );
            })
        );

        this.eventRefs.push(
            this.events.on("rename", (path, oldPath) => {
                this.cancelPending(oldPath);
                this.lastSyncTime.delete(oldPath);
                this.vaultSync.handleRename(path, oldPath).catch((e) =>
                    logError(`CouchSync: handleRename failed: ${oldPath} → ${path} ${e?.message ?? e}`),
                );
            })
        );
    }

    stop(): void {
        for (const ref of this.eventRefs) {
            this.events.offref(ref);
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

    private scheduleSync(path: string): void {
        this.cancelPending(path);

        const debounceMs = this.getSettings().syncDebounceMs;
        const timer = setTimeout(() => {
            this.timers.delete(path);
            this.trySync(path);
        }, debounceMs);

        this.timers.set(path, timer);
    }

    private trySync(path: string): void {
        const minIntervalMs = this.getSettings().syncMinIntervalMs;
        if (minIntervalMs > 0) {
            const last = this.lastSyncTime.get(path) ?? 0;
            const elapsed = Date.now() - last;
            if (elapsed < minIntervalMs) {
                const existing = this.pendingMinInterval.get(path);
                if (existing) clearTimeout(existing);
                const delay = minIntervalMs - elapsed;
                const t = setTimeout(() => {
                    this.pendingMinInterval.delete(path);
                    this.runSync(path);
                }, delay);
                this.pendingMinInterval.set(path, t);
                return;
            }
        }
        this.runSync(path);
    }

    private runSync(path: string): void {
        this.lastSyncTime.set(path, Date.now());
        this.vaultSync.fileToDb(path).catch((e) => {
            logError(`CouchSync: Failed to sync ${path}: ${e?.message ?? e}`);
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
