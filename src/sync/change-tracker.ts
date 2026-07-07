import type { IVaultEvents, VaultEventRef } from "../types/vault-events.ts";
import type { VaultSync, IWriteIgnore, IPendingProbe } from "./vault-sync.ts";
import type { CouchSyncSettings } from "../settings.ts";
import { logError } from "../ui/log.ts";

export class ChangeTracker implements IWriteIgnore, IPendingProbe {
    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    private pendingMinInterval = new Map<string, ReturnType<typeof setTimeout>>();
    private lastSyncTime = new Map<string, number>();
    private eventRefs: VaultEventRef[] = [];
    /** Paths whose next `delete` event should be treated as sync-driven. */
    private pendingDeleteIgnores = new Set<string>();
    /** Paths whose `modify` events should be treated as sync-driven until the
     *  deadline (epoch ms). Extends the old one-shot `pendingModifyIgnores` to
     *  a time-window model: Obsidian's stale-buffer flush on resume/hidden can
     *  fire multiple modify events seconds after a pull-apply, which a one-shot
     *  ignore misses. The 5 s window absorbs these while staying short enough
     *  that genuine user edits (which trigger the next reconcile anyway) are
     *  not delayed materially. */
    private modifyIgnoreUntil = new Map<string, number>();
    private static readonly MODIFY_IGNORE_WINDOW_MS = 5000;

    constructor(
        private events: IVaultEvents,
        private vaultSync: VaultSync,
        private getSettings: () => CouchSyncSettings
    ) {}

    start(): void {
        this.eventRefs.push(
            this.events.on("modify", (path) => {
                const until = this.modifyIgnoreUntil.get(path);
                if (until !== undefined) {
                    if (Date.now() <= until) return;
                    this.modifyIgnoreUntil.delete(path);
                }
                this.scheduleSync(path);
            }),
        );

        this.eventRefs.push(
            this.events.on("create", (path) => this.scheduleSync(path)),
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

        // Folder delete (invariant S1/S6): Obsidian fires one event for the
        // folder, not per descendant file. Desugar into per-file markDeleted
        // by enumerating the children from the DB (they are already gone from
        // the vault FS). The reconcile backstop (invariant S2) recovers any
        // children missed here (e.g. an event dropped on mobile).
        this.eventRefs.push(
            this.events.on("folder-delete", (path) => {
                this.vaultSync.handleFolderDelete(path).catch((e) =>
                    logError(`CouchSync: handleFolderDelete failed: ${path} ${e?.message ?? e}`),
                );
            })
        );
        // NB: folder-rename live desugaring is Phase 2. Until then a folder
        // rename converges via reconcile (old paths → delete, new paths →
        // push); no live handler is wired, but the event is surfaced so a
        // folder path never reaches the file `rename` handler (S6).
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

    /** Register that the next `delete` event on `path` is sync-driven. */
    ignoreDelete(path: string): void {
        this.pendingDeleteIgnores.add(path);
    }

    /** Suppress modify events on `path` for the next MODIFY_IGNORE_WINDOW_MS.
     *  Each call resets the deadline — rapid pull-applies extend the window. */
    ignoreNextModify(path: string): void {
        this.modifyIgnoreUntil.set(
            path,
            Date.now() + ChangeTracker.MODIFY_IGNORE_WINDOW_MS,
        );
    }

    /**
     * **Invariant 4 (Pending-edit oracle).** True iff a debounced or
     * min-interval-deferred `fileToDb` is scheduled for `path`. Echo
     * suppressors (`pendingDeleteIgnores` / `pendingModifyIgnores`) do
     * NOT count — those mark sync-driven events, not user edits.
     *
     * Used by `VaultSync.hasUnpushedChanges` to decide whether the
     * `pull-delete` query handler should defer a remote deletion (= the
     * user has work in flight that hasn't reached LocalDB yet).
     */
    hasPending(path: string): boolean {
        return this.timers.has(path) || this.pendingMinInterval.has(path);
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
