import type { App, TFile } from "obsidian";
import type { LocalDB } from "../db/local-db.ts";
import type { FileDoc } from "../types.ts";
import type { CouchSyncSettings } from "../settings.ts";
import type { HistoryCapture } from "../history/history-capture.ts";
import { splitIntoChunks, joinChunks } from "../db/chunker.ts";

export class VaultSync {
    private pullInProgress = false;
    private historyCapture: HistoryCapture | null = null;

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

    setPullInProgress(value: boolean): void {
        this.pullInProgress = value;
    }

    async fileToDb(file: TFile): Promise<void> {
        if (this.pullInProgress) return;
        const settings = this.getSettings();
        const sizeMB = file.stat.size / (1024 * 1024);
        if (sizeMB > settings.maxFileSizeMB) return;
        if (!this.shouldSync(file.path)) return;

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
            const skip = await this.checkSkipWrite(fileDoc, existing as TFile);
            if (skip) return;
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
     * Determines whether a remote doc write should be skipped. Used by both
     * the live `dbToFile` path and the cold-path `Reconciler` for case A/B
     * (vault and DB both have the file).
     *
     * Step 1: Content comparison — skip if chunk IDs match (identical content).
     * Step 2: Freshness comparison — skip if local mtime is newer than remote
     *         editedAt (the actual user-edit timestamp, not relay mtime).
     */
    async checkSkipWrite(fileDoc: FileDoc, localFile: TFile): Promise<boolean> {
        // Step 1: Content comparison (chunk IDs). Size mismatch implies
        // content mismatch, so we can skip the disk read + chunking entirely.
        if (localFile.stat.size === fileDoc.size) {
            const localContent = await this.app.vault.readBinary(localFile);
            const localChunks = await splitIntoChunks(localContent);
            const localChunkIds = localChunks.map((c) => c._id);

            if (
                localChunkIds.length === fileDoc.chunks.length &&
                localChunkIds.every((id, i) => id === fileDoc.chunks[i])
            ) {
                console.debug(`CouchSync: dbToFile skipped (content identical): ${fileDoc._id}`);
                return true;
            }
        }

        // Step 2: Freshness comparison
        // editedAt = user-edit timestamp (set only by fileToDb, never by relay)
        // localFile.stat.mtime = OS disk-write timestamp
        // These are semantically different clocks. A relay device's mtime may be
        // later than editedAt due to network/processing delay. This is safe under
        // the "one device edits at a time" assumption because Step 1 (content
        // comparison) catches identical content first; Step 2 only fires when
        // content differs, meaning a real edit occurred.
        const remoteEditedAt = fileDoc.editedAt ?? fileDoc.mtime;
        if (localFile.stat.mtime > remoteEditedAt) {
            console.debug(`CouchSync: dbToFile skipped (local fresher): ${fileDoc._id} local=${localFile.stat.mtime} remote=${remoteEditedAt}`);
            return true;
        }

        return false;
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
