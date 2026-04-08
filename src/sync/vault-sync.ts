import type { App, TFile } from "obsidian";
import type { LocalDB } from "../db/local-db.ts";
import type { FileDoc } from "../types.ts";
import type { CouchSyncSettings } from "../settings.ts";
import type { HistoryCapture } from "../history/history-capture.ts";
import { splitIntoChunks, joinChunks } from "../db/chunker.ts";
import { showNotice } from "../ui/notices.ts";

/**
 * Result of comparing a vault file against a DB file doc.
 *  - identical:    same chunk IDs → no action needed
 *  - local-newer:  vault edit is newer than the DB doc → push (case B local-win)
 *  - remote-newer: DB doc is newer than the vault file → pull (case B remote-win)
 */
export type CompareResult = "identical" | "local-newer" | "remote-newer";

export class VaultSync {
    private historyCapture: HistoryCapture | null = null;
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

        const fileDoc: FileDoc = {
            _id: file.path,
            type: "file",
            chunks: chunkIds,
            mtime: file.stat.mtime,
            ctime: file.stat.ctime,
            size: file.stat.size,
            editedAt: Date.now(),
            editedBy: this.getSettings().deviceId,
        };
        await this.db.put(fileDoc);
    }

    async dbToFile(fileDoc: FileDoc): Promise<void> {
        if (fileDoc.deleted) {
            const existing = this.app.vault.getAbstractFileByPath(fileDoc._id);
            if (existing) {
                await this.app.vault.delete(existing);
            }
            return;
        }

        const existing = this.app.vault.getAbstractFileByPath(fileDoc._id);

        if (existing && "stat" in existing) {
            const cmp = await this.compareFileToDoc(fileDoc, existing as TFile);
            if (cmp !== "remote-newer") return;
        }

        // Apply remote content to vault
        const chunks = await this.db.getChunks(fileDoc.chunks);

        const chunkMap = new Map(chunks.map((c) => [c._id, c]));
        const orderedChunks = fileDoc.chunks
            .map((id) => chunkMap.get(id))
            .filter((c): c is NonNullable<typeof c> => c != null);

        if (orderedChunks.length !== fileDoc.chunks.length) {
            console.warn(`CouchSync: Missing chunks for ${fileDoc._id}`);
            return;
        }

        const content = joinChunks(orderedChunks);

        let writtenFile: TFile | null = null;
        if (existing) {
            await this.app.vault.modifyBinary(existing as TFile, content);
            writtenFile = existing as TFile;
        } else {
            await this.ensureParentDir(fileDoc._id);
            await this.app.vault.createBinary(fileDoc._id, content);
            const created = this.app.vault.getAbstractFileByPath(fileDoc._id);
            if (created && "extension" in created) writtenFile = created as TFile;
        }

        // Record this sync-driven write as a history entry. captureSyncWrite
        // sniffs the bytes itself and skips non-text files, so we can call it
        // unconditionally here.
        if (writtenFile && this.historyCapture) {
            await this.historyCapture.captureSyncWrite(writtenFile);
        }
    }

    /**
     * Compare a local vault file against a remote/DB file doc.
     *
     * Step 1: Content — chunk IDs match → identical
     * Step 2: Freshness — local mtime vs editedAt (the user-edit timestamp,
     *         not the relay mtime that gets laundered through intermediates)
     *
     * `dbToFile` and the Reconciler both branch on this 3-value result.
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
        const remoteEditedAt = fileDoc.editedAt ?? fileDoc.mtime;
        return localFile.stat.mtime > remoteEditedAt ? "local-newer" : "remote-newer";
    }

    async markDeleted(path: string): Promise<void> {
        const existing = await this.db.getFileDoc(path);
        if (existing) {
            existing.deleted = true;
            existing.mtime = Date.now();
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
