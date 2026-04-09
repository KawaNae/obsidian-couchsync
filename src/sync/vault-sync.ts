import type { App, TFile } from "obsidian";
import type { LocalDB } from "../db/local-db.ts";
import type { FileDoc } from "../types.ts";
import type { CouchSyncSettings } from "../settings.ts";
import type { HistoryCapture } from "../history/history-capture.ts";
import type { ChangeTracker } from "./change-tracker.ts";
import { splitIntoChunks, joinChunks } from "../db/chunker.ts";
import { showNotice } from "../ui/notices.ts";
import { incrementVC } from "./vector-clock.ts";
import { makeFileId, filePathFromId } from "../types/doc-id.ts";

/**
 * Result of comparing a vault file against its local DB record.
 *
 * This answers *local drift* ("has the vault diverged from what the DB
 * thinks?"), NOT cross-device ordering. Cross-device ordering lives in
 * Vector Clocks and is decided by ConflictResolver against PouchDB's
 * _conflicts tree. Here, `doc.mtime` is the file's mtime at the moment
 * of the last fileToDb/dbToFile for this path — a purely local signal
 * that's safe to compare against `file.stat.mtime`.
 *
 *  - identical:       chunk IDs match → no action needed
 *  - local-unpushed:  chunks differ, vault mtime newer → push
 *  - remote-pending:  chunks differ, DB mtime newer  → pull
 */
export type CompareResult = "identical" | "local-unpushed" | "remote-pending";

export class VaultSync {
    private historyCapture: HistoryCapture | null = null;
    private changeTracker: ChangeTracker | null = null;
    /**
     * In-memory mirror of `_local/skipped-files` paths. Initialised lazily on
     * the first `fileToDb` that might touch it, then kept in sync with the
     * doc. Lets the hot path skip a PouchDB read on every successful file
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

    async fileToDb(file: TFile): Promise<void> {
        const settings = this.getSettings();
        const sizeMB = file.stat.size / (1024 * 1024);
        if (sizeMB > settings.maxFileSizeMB) {
            await this.recordSkipped(file.path, sizeMB, settings.maxFileSizeMB);
            return;
        }
        if (!this.shouldSync(file.path)) return;

        // Only hit the DB if this path was previously skipped. In steady
        // state the cache is an empty set and this costs one Set.has().
        if (await this.wasSkipped(file.path)) {
            await this.forgetSkipped(file.path);
        }

        const content = await this.app.vault.readBinary(file);
        const chunks = await splitIntoChunks(content);
        const chunkIds = chunks.map((c) => c._id);

        // Skip if content unchanged (same chunk IDs = same content)
        const existing = await this.db.getFileDoc(file.path);
        if (existing &&
            existing.chunks.length === chunkIds.length &&
            existing.chunks.every((id, i) => id === chunkIds[i])) {
            return;
        }

        await this.db.bulkPut(chunks);

        const deviceId = this.getSettings().deviceId;
        const fileDoc: FileDoc = {
            _id: makeFileId(file.path),
            type: "file",
            chunks: chunkIds,
            mtime: file.stat.mtime,
            ctime: file.stat.ctime,
            size: file.stat.size,
            vclock: incrementVC(existing?.vclock, deviceId),
        };
        await this.db.put(fileDoc);
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

        if (existing && "stat" in existing) {
            const cmp = await this.compareFileToDoc(fileDoc, existing as TFile);
            // Skip if identical or if the vault has unpushed local edits
            // ChangeTracker will catch. Only overwrite when the remote doc
            // is ahead of what the local vault currently holds.
            if (cmp !== "remote-pending") return;
        }

        // Apply remote content to vault
        const chunks = await this.db.getChunks(fileDoc.chunks);

        const chunkMap = new Map(chunks.map((c) => [c._id, c]));
        const orderedChunks = fileDoc.chunks
            .map((id) => chunkMap.get(id))
            .filter((c): c is NonNullable<typeof c> => c != null);

        if (orderedChunks.length !== fileDoc.chunks.length) {
            console.warn(`CouchSync: Missing chunks for ${vaultPath}`);
            return;
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
     * Step 2 — mtime comparison as a *local* signal: `fileDoc.mtime` is
     * the vault file's mtime at the moment of the last fileToDb/dbToFile
     * for this path. Comparing it against the vault file's current
     * `stat.mtime` answers "has anything touched this file locally since
     * we last synced it?". This is NOT cross-device ordering (VCs do
     * that); it's purely local filesystem drift detection.
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
        return localFile.stat.mtime > fileDoc.mtime ? "local-unpushed" : "remote-pending";
    }

    async markDeleted(path: string): Promise<void> {
        const existing = await this.db.getFileDoc(path);
        if (existing) {
            existing.deleted = true;
            existing.mtime = Date.now();
            existing.vclock = incrementVC(existing.vclock, this.getSettings().deviceId);
            await this.db.put(existing);
        }
    }

    async handleRename(file: TFile, oldPath: string): Promise<void> {
        await this.markDeleted(oldPath);
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
