import type { App, TFile } from "obsidian";
import type { LocalDB } from "../db/local-db.ts";
import type { FileDoc } from "../types.ts";
import type { CouchSyncSettings } from "../settings.ts";
import type { HistoryCapture } from "../history/history-capture.ts";
import type { ChangeTracker } from "./change-tracker.ts";
import { splitIntoChunks, joinChunks } from "../db/chunker.ts";
import { showNotice } from "../ui/notices.ts";
import { compareVC, incrementVC } from "./vector-clock.ts";
import type { VectorClock } from "./vector-clock.ts";
import { makeFileId, filePathFromId } from "../types/doc-id.ts";
import { logError } from "../ui/log.ts";

/**
 * Result of comparing a vault file against its local DB record.
 *
 * This answers *local drift* ("has the vault diverged from what the DB
 * thinks?"), NOT cross-device ordering. Cross-device ordering lives in
 * Vector Clocks and is decided by ConflictResolver via resolveOnPull().
 *
 *  - identical:       chunk IDs match → no action needed
 *  - local-unpushed:  chunks differ, vclock unchanged since last sync → push
 *  - remote-pending:  chunks differ, vclock advanced since last sync → pull
 */
export type CompareResult = "identical" | "local-unpushed" | "remote-pending";

export class VaultSync {
    private historyCapture: HistoryCapture | null = null;
    private changeTracker: ChangeTracker | null = null;
    /**
     * In-memory map of vault path → vclock at the time of the last
     * successful sync write (dbToFile or fileToDb). Used by
     * compareFileToDoc to detect local drift without relying on
     * cross-device mtime comparison (which breaks under clock skew).
     */
    private lastSyncedVclock = new Map<string, VectorClock>();
    /** Timer handle for debounced persistence of lastSyncedVclock. */
    private vclockFlushTimer: ReturnType<typeof setTimeout> | null = null;
    /** Whether the in-memory map has unflushed changes. */
    private vclockDirty = false;
    /**
     * In-memory mirror of `_local/skipped-files` paths. Initialised lazily on
     * the first `fileToDb` that might touch it, then kept in sync with the
     * doc. Lets the hot path skip a DB read on every successful file
     * sync (which is ~every file edit via ChangeTracker).
     */
    private skippedPaths: Set<string> | null = null;

    constructor(
        private app: App,
        private db: LocalDB,
        private getSettings: () => CouchSyncSettings
    ) {}

    /**
     * Inject HistoryCapture after construction to avoid circular wiring at
     * plugin init time. Once set, dbToFile() records a history entry for
     * every sync-driven vault write so the timeline reflects true state
     * changes, not just local edits.
     */
    setHistoryCapture(historyCapture: HistoryCapture): void {
        this.historyCapture = historyCapture;
    }

    /**
     * Inject the ChangeTracker so dbToFile() can mark sync-driven writes as
     * self-inflicted. Without this wiring, every remote pull would re-enter
     * fileToDb via Obsidian's modify event and echo back to the peer.
     */
    setChangeTracker(changeTracker: ChangeTracker): void {
        this.changeTracker = changeTracker;
    }

    /**
     * Load persisted lastSyncedVclock from `_local/last-synced-vclocks`.
     * Called once during plugin init, before reconciliation starts.
     */
    async loadLastSyncedVclocks(): Promise<void> {
        const stored = await this.db.getLastSyncedVclocks();
        if (!stored) return;
        this.lastSyncedVclock.clear();
        for (const [path, vc] of Object.entries(stored)) {
            this.lastSyncedVclock.set(path, vc);
        }
    }

    /**
     * Flush lastSyncedVclock to the local DB. Debounced — only the latest
     * snapshot is persisted, at most once every 5 seconds.
     */
    async flushLastSyncedVclocks(): Promise<void> {
        this.vclockDirty = false;
        const obj: Record<string, VectorClock> = {};
        for (const [path, vc] of this.lastSyncedVclock) {
            obj[path] = vc;
        }
        await this.db.putLastSyncedVclocks(obj);
    }

    private scheduleVclockFlush(): void {
        this.vclockDirty = true;
        if (this.vclockFlushTimer) return;
        this.vclockFlushTimer = setTimeout(() => {
            this.vclockFlushTimer = null;
            this.flushLastSyncedVclocks().catch((e) =>
                logError(`CouchSync: failed to persist lastSyncedVclocks: ${e?.message ?? e}`),
            );
        }, 5_000);
    }

    /**
     * Cancel pending flush timer and persist if dirty. Call from plugin
     * unload to avoid losing recent vclock state.
     */
    async teardown(): Promise<void> {
        if (this.vclockFlushTimer) {
            clearTimeout(this.vclockFlushTimer);
            this.vclockFlushTimer = null;
        }
        if (this.vclockDirty) {
            await this.flushLastSyncedVclocks();
        }
    }

    async fileToDb(file: TFile): Promise<void> {
        const settings = this.getSettings();
        const sizeMB = file.stat.size / (1024 * 1024);
        if (sizeMB > settings.maxFileSizeMB) {
            await this.recordSkipped(file.path, sizeMB, settings.maxFileSizeMB);
            return;
        }
        if (!this.shouldSync(file.path)) return;

        if (await this.wasSkipped(file.path)) {
            await this.forgetSkipped(file.path);
        }

        const content = await this.app.vault.readBinary(file);
        const chunks = await splitIntoChunks(content);
        const chunkIds = chunks.map((c) => c._id);

        const quickCheck = await this.db.getFileDoc(file.path);
        if (quickCheck &&
            quickCheck.chunks.length === chunkIds.length &&
            quickCheck.chunks.every((id, i) => id === chunkIds[i])) {
            return;
        }

        await this.db.bulkPut(chunks);

        const deviceId = this.getSettings().deviceId;
        let pushedVclock: VectorClock | undefined;
        await this.db.update<FileDoc>(makeFileId(file.path), (existing) => {
            if (existing &&
                existing.chunks.length === chunkIds.length &&
                existing.chunks.every((id, i) => id === chunkIds[i])) {
                return null;
            }
            const vc = incrementVC(existing?.vclock, deviceId);
            pushedVclock = vc;
            return {
                _id: makeFileId(file.path),
                type: "file",
                chunks: chunkIds,
                mtime: file.stat.mtime,
                ctime: file.stat.ctime,
                size: file.stat.size,
                vclock: vc,
            } as FileDoc;
        });
        if (pushedVclock) {
            this.lastSyncedVclock.set(file.path, pushedVclock);
            this.scheduleVclockFlush();
        }
    }

    async dbToFile(fileDoc: FileDoc): Promise<void> {
        // fileDoc._id is "file:<vaultPath>"; vault operations need the bare
        // path. Extract it once at the top so the rest of the body isn't
        // littered with slice() calls.
        const vaultPath = filePathFromId(fileDoc._id);

        if (fileDoc.deleted) {
            const existing = this.app.vault.getAbstractFileByPath(vaultPath);
            if (existing) {
                this.changeTracker?.ignoreDelete(vaultPath);
                await this.app.vault.delete(existing);
            }
            return;
        }

        const existing = this.app.vault.getAbstractFileByPath(vaultPath);

        // Skip only when vault content is already identical to the doc.
        // The old guard also skipped "local-unpushed" based on cross-device
        // mtime comparison, but that breaks under clock skew. Since this
        // method is called from the pull path (onChange), the sync engine
        // already guarantees the doc is causally newer. ChangeTracker +
        // ignoreWrite prevent echo loops for sync-driven writes.
        if (existing && "stat" in existing) {
            const localFile = existing as TFile;
            if (localFile.stat.size === fileDoc.size) {
                const localContent = await this.app.vault.readBinary(localFile);
                const localChunks = await splitIntoChunks(localContent);
                const localChunkIds = localChunks.map((c) => c._id);
                if (
                    localChunkIds.length === fileDoc.chunks.length &&
                    localChunkIds.every((id, i) => id === fileDoc.chunks[i])
                ) {
                    return; // Content identical, skip
                }
            }
        }

        // Apply remote content to vault
        const chunks = await this.db.getChunks(fileDoc.chunks);

        const chunkMap = new Map(chunks.map((c) => [c._id, c]));
        const orderedChunks = fileDoc.chunks
            .map((id) => chunkMap.get(id))
            .filter((c): c is NonNullable<typeof c> => c != null);

        if (orderedChunks.length !== fileDoc.chunks.length) {
            const missing = fileDoc.chunks.filter(id => !chunkMap.has(id));
            throw new Error(
                `Missing ${missing.length} chunk(s) for ${vaultPath}: ${missing.join(", ")}`,
            );
        }

        const content = joinChunks(orderedChunks);

        // Mark the upcoming write as sync-driven so ChangeTracker drops the
        // resulting modify event instead of echoing it back into fileToDb.
        // clearIgnore in the finally block handles the no-op write case.
        this.changeTracker?.ignoreWrite(vaultPath);

        let writtenFile: TFile | null = null;
        try {
            if (existing) {
                await this.app.vault.modifyBinary(existing as TFile, content);
                writtenFile = existing as TFile;
            } else {
                await this.ensureParentDir(vaultPath);
                await this.app.vault.createBinary(vaultPath, content);
                const created = this.app.vault.getAbstractFileByPath(vaultPath);
                if (created && "extension" in created) writtenFile = created as TFile;
            }
        } finally {
            // If the modify event never fired (e.g. the write was a no-op
            // because content matched), drop the stale fingerprint so a
            // later unrelated edit isn't silently ignored.
            this.changeTracker?.clearIgnore(vaultPath);
        }

        if (writtenFile) {
            this.lastSyncedVclock.set(vaultPath, { ...(fileDoc.vclock ?? {}) });
            this.scheduleVclockFlush();
        }

        // Record this sync-driven write as a history entry. captureSyncWrite
        // sniffs the bytes itself and skips non-text files, so we can call it
        // unconditionally here.
        if (writtenFile && this.historyCapture) {
            await this.historyCapture.captureSyncWrite(writtenFile);
        }
    }

    /**
     * Compare a vault file against its local DB record to detect drift.
     *
     * Step 1 — chunk equality: if every chunk ID matches, the content is
     * identical and no further comparison is needed.
     *
     * Step 2 — vclock comparison: if the doc's vclock has advanced beyond
     * what was recorded at the last sync write for this path, a remote
     * device pushed new content → "remote-pending". If the vclock is
     * unchanged, the vault file was edited locally since the last sync
     * but not yet pushed → "local-unpushed". This replaces the old
     * cross-device mtime comparison which broke under clock skew.
     */
    async compareFileToDoc(fileDoc: FileDoc, localFile: TFile): Promise<CompareResult> {
        if (localFile.stat.size === fileDoc.size) {
            const localContent = await this.app.vault.readBinary(localFile);
            const localChunks = await splitIntoChunks(localContent);
            const localChunkIds = localChunks.map((c) => c._id);
            if (
                localChunkIds.length === fileDoc.chunks.length &&
                localChunkIds.every((id, i) => id === fileDoc.chunks[i])
            ) {
                return "identical";
            }
        }
        const lastSynced = this.lastSyncedVclock.get(filePathFromId(fileDoc._id));
        if (lastSynced) {
            const rel = compareVC(fileDoc.vclock ?? {}, lastSynced);
            return rel === "equal" ? "local-unpushed" : "remote-pending";
        }
        // No record (e.g. plugin just loaded) — conservatively pull.
        return "remote-pending";
    }

    async markDeleted(path: string): Promise<void> {
        this.lastSyncedVclock.delete(path);
        this.scheduleVclockFlush();
        await this.db.update<FileDoc>(makeFileId(path), (existing) => {
            if (!existing) return null;
            return {
                ...existing,
                deleted: true,
                mtime: Date.now(),
                vclock: incrementVC(existing.vclock, this.getSettings().deviceId),
            } as FileDoc;
        });
    }

    async handleRename(file: TFile, oldPath: string): Promise<void> {
        await this.markDeleted(oldPath); // also clears lastSyncedVclock for oldPath
        await this.fileToDb(file);
    }

    /** Lazily populate the skipped-paths cache from the persisted doc. */
    private async loadSkippedCache(): Promise<Set<string>> {
        if (this.skippedPaths) return this.skippedPaths;
        const doc = await this.db.getSkippedFiles();
        this.skippedPaths = new Set(Object.keys(doc.files));
        return this.skippedPaths;
    }

    private async wasSkipped(path: string): Promise<boolean> {
        const cache = await this.loadSkippedCache();
        return cache.has(path);
    }

    /**
     * Remember a file the size limit rejected, and notify the user only the
     * first time (or when the size noticeably changes). Notice spam is avoided
     * by keying the dedup on path + rounded sizeMB.
     */
    private async recordSkipped(path: string, sizeMB: number, limitMB: number): Promise<void> {
        const doc = await this.db.getSkippedFiles();
        const existing = doc.files[path];
        const roundedSize = Math.round(sizeMB * 10) / 10;
        const isNew = !existing || Math.round(existing.sizeMB * 10) / 10 !== roundedSize;
        doc.files[path] = { sizeMB: roundedSize, skippedAt: Date.now() };
        await this.db.putSkippedFiles(doc);
        (await this.loadSkippedCache()).add(path);
        if (isNew) {
            showNotice(
                `Skipped "${path}" — ${roundedSize} MB exceeds ${limitMB} MB limit. ` +
                    `Raise the limit in settings to sync it.`,
                8000,
            );
        }
    }

    private async forgetSkipped(path: string): Promise<void> {
        const doc = await this.db.getSkippedFiles();
        if (!(path in doc.files)) return;
        delete doc.files[path];
        await this.db.putSkippedFiles(doc);
        this.skippedPaths?.delete(path);
    }

    private shouldSync(path: string): boolean {
        const settings = this.getSettings();
        if (path.startsWith(".")) return false;

        if (settings.syncFilter) {
            try {
                const re = new RegExp(settings.syncFilter);
                if (!re.test(path)) return false;
            } catch { /* invalid regex, sync all */ }
        }
        if (settings.syncIgnore) {
            try {
                const re = new RegExp(settings.syncIgnore);
                if (re.test(path)) return false;
            } catch { /* invalid regex, ignore nothing */ }
        }
        return true;
    }

    private async ensureParentDir(filePath: string): Promise<void> {
        const parts = filePath.split("/");
        if (parts.length <= 1) return;
        const dir = parts.slice(0, -1).join("/");
        if (!this.app.vault.getAbstractFileByPath(dir)) {
            await this.app.vault.createFolder(dir);
        }
    }
}
