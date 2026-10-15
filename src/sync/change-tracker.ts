import type { IVaultEvents, VaultEventRef } from "../types/vault-events.ts";
import type { FileStat, IVaultIO } from "../types/vault-io.ts";
import type { VaultSync, IWriteIgnore, IPendingProbe } from "./vault-sync.ts";
import type { CouchSyncSettings } from "../settings.ts";
import { computeHash } from "../db/chunker.ts";
import { logError } from "../ui/log.ts";

/** What sync wrote to a path, compared with the disk on each modify. */
interface Written {
    size: number;
    hash: Promise<string>;
}

export class ChangeTracker implements IWriteIgnore, IPendingProbe {
    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    private pendingMinInterval = new Map<string, ReturnType<typeof setTimeout>>();
    private lastSyncTime = new Map<string, number>();
    private eventRefs: VaultEventRef[] = [];
    /** Paths whose next `delete` event should be treated as sync-driven. */
    private pendingDeleteIgnores = new Set<string>();
    /**
     * Per path, the bytes sync last wrote there, while the disk is not
     * known to hold anything else. A modify that finds these bytes is the
     * write itself, or Obsidian writing the same content again; neither is
     * an edit. The first modify that finds other bytes ends the entry: the
     * disk has moved on, and every later modify is a candidate edit.
     */
    private written = new Map<string, Written>();
    /** Modify events whose disk read is in progress, per path. */
    private checking = new Map<string, number>();
    private running = false;

    constructor(
        private events: IVaultEvents,
        private vault: IVaultIO,
        private vaultSync: VaultSync,
        private getSettings: () => CouchSyncSettings
    ) {}

    start(): void {
        this.running = true;
        this.eventRefs.push(
            this.events.on("modify", (path, stat) => this.onModify(path, stat)),
        );

        this.eventRefs.push(
            this.events.on("create", (path) => this.scheduleSync(path)),
        );

        this.eventRefs.push(
            this.events.on("delete", (path) => {
                this.written.delete(path);
                this.cancelPending(path);
                this.lastSyncTime.delete(path);
                if (this.pendingDeleteIgnores.delete(path)) return;
                this.vaultSync.markDeleted(path).catch((e) =>
                    logError(`markDeleted failed: ${path} ${e?.message ?? e}`),
                );
            })
        );

        this.eventRefs.push(
            this.events.on("rename", (path, oldPath) => {
                this.written.delete(oldPath);
                this.cancelPending(oldPath);
                this.lastSyncTime.delete(oldPath);
                this.vaultSync.handleRename(path, oldPath).catch((e) =>
                    logError(`handleRename failed: ${oldPath} → ${path} ${e?.message ?? e}`),
                );
            })
        );

        // Folder delete: Obsidian fires one event for the folder, not per
        // descendant file, and folders have no document of their own. Desugar
        // into per-file markDeleted by enumerating the children from the DB
        // (they are already gone from the vault FS). Reconcile recovers any
        // children missed here (e.g. an event dropped on mobile).
        this.eventRefs.push(
            this.events.on("folder-delete", (path) => {
                this.vaultSync.handleFolderDelete(path).catch((e) =>
                    logError(`handleFolderDelete failed: ${path} ${e?.message ?? e}`),
                );
            })
        );
        // NB: folder renames are not desugared live yet; a folder rename
        // converges via reconcile (old paths → delete, new paths → push). No
        // live handler is wired, but the event is surfaced so a folder path
        // never reaches the file `rename` handler.
    }

    stop(): void {
        this.running = false;
        for (const ref of this.eventRefs) {
            this.events.offref(ref);
        }
        this.eventRefs = [];
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        for (const timer of this.pendingMinInterval.values()) clearTimeout(timer);
        this.pendingMinInterval.clear();
        this.written.clear();
        this.checking.clear();
    }

    /** Register that the next `delete` event on `path` is sync-driven. */
    ignoreDelete(path: string): void {
        this.pendingDeleteIgnores.add(path);
    }

    ignoreModifyTo(path: string, content: ArrayBuffer): void {
        const hash = computeHash(new Uint8Array(content));
        // An entry may be dropped before any modify awaits its hash; a
        // failed hash only makes `diskHolds` answer false.
        hash.catch(() => {});
        this.written.set(path, { size: content.byteLength, hash });
    }

    /**
     * A modify on a path sync wrote is compared with what it wrote: the
     * size from the event first, then the bytes on disk. Only a modify
     * that finds something else reaches `fileToDb`, at once rather than
     * after a fixed delay, so an edit right after a sync write (such as
     * Obsidian saving its merge of typing with the written version) is
     * pushed like any other.
     */
    private onModify(path: string, stat: FileStat): void {
        const written = this.written.get(path);
        if (!written) {
            this.scheduleSync(path);
            return;
        }
        if (stat.size !== written.size) {
            this.written.delete(path);
            this.scheduleSync(path);
            return;
        }
        this.checking.set(path, (this.checking.get(path) ?? 0) + 1);
        this.diskHolds(path, written)
            .then((same) => {
                if (!this.running || same) return;
                // A write after this event's may have replaced the entry;
                // its own modify decides about that one.
                if (this.written.get(path) === written) this.written.delete(path);
                this.scheduleSync(path);
            })
            .finally(() => {
                const n = (this.checking.get(path) ?? 1) - 1;
                if (n > 0) this.checking.set(path, n);
                else this.checking.delete(path);
            });
    }

    /** True when the disk at `path` holds the bytes of `written`. A read
     *  that fails (the file went) is not a match: `fileToDb` decides. */
    private async diskHolds(path: string, written: Written): Promise<boolean> {
        try {
            const data = await this.vault.readBinary(path);
            if (data.byteLength !== written.size) return false;
            return (await computeHash(new Uint8Array(data))) === (await written.hash);
        } catch {
            return false;
        }
    }

    /**
     * **Pending-edit oracle.** True iff a debounced or
     * min-interval-deferred `fileToDb` is scheduled for `path`, or a modify
     * on it is being compared with what sync wrote (it may be an edit).
     * What sync wrote, and deletes it caused, do NOT count: those are
     * sync-driven, not user edits.
     *
     * Used by `VaultSync.hasUnpushedChanges` to decide whether the
     * `pull-delete` query handler should defer a remote deletion (= the
     * user has work in flight that hasn't reached LocalDB yet).
     */
    hasPending(path: string): boolean {
        return this.timers.has(path) || this.pendingMinInterval.has(path)
            || this.checking.has(path);
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
            logError(`Failed to sync ${path}: ${e?.message ?? e}`);
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
