import type { App, TFile } from "obsidian";
import type { LocalDB } from "../db/local-db.ts";
import type { FileDoc } from "../types.ts";
import type { CouchSyncSettings } from "../settings.ts";
import { splitIntoChunks, joinChunks } from "../db/chunker.ts";
import { isBinaryFile } from "../utils/binary.ts";

const RECONCILE_MIN_INTERVAL = 30000; // 30s minimum between reconcile runs

export class VaultSync {
    private pullInProgress = false;
    private reconciling = false;
    private lastReconcileTime = 0;

    constructor(
        private app: App,
        private db: LocalDB,
        private getSettings: () => CouchSyncSettings
    ) {}

    setPullInProgress(value: boolean): void {
        this.pullInProgress = value;
    }

    async fileToDb(file: TFile): Promise<void> {
        if (this.pullInProgress) return;
        const settings = this.getSettings();
        const sizeMB = file.stat.size / (1024 * 1024);
        if (sizeMB > settings.maxFileSizeMB) return;
        if (!this.shouldSync(file.path)) return;

        const binary = isBinaryFile(file.path);
        const content = binary
            ? await this.app.vault.readBinary(file)
            : await this.app.vault.read(file);

        const chunks = await splitIntoChunks(content, binary);
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
        const binary = isBinaryFile(fileDoc._id);

        if (existing && "stat" in existing) {
            const skip = await this.shouldSkipWrite(fileDoc, existing as TFile, binary);
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

        const content = joinChunks(orderedChunks, binary);

        if (binary) {
            if (existing) {
                await this.app.vault.modifyBinary(existing as TFile, content as ArrayBuffer);
            } else {
                await this.ensureParentDir(fileDoc._id);
                await this.app.vault.createBinary(fileDoc._id, content as ArrayBuffer);
            }
        } else {
            if (existing) {
                await this.app.vault.modify(existing as TFile, content as string);
            } else {
                await this.ensureParentDir(fileDoc._id);
                await this.app.vault.create(fileDoc._id, content as string);
            }
        }
    }

    /**
     * Determines whether a remote doc write should be skipped.
     * Step 1: Content comparison — skip if chunk IDs match (identical content).
     * Step 2: Freshness comparison — skip if local mtime is newer than remote
     *         editedAt (the actual user-edit timestamp, not relay mtime).
     */
    private async shouldSkipWrite(fileDoc: FileDoc, localFile: TFile, binary: boolean): Promise<boolean> {
        // Step 1: Content comparison (chunk IDs)
        const localContent = binary
            ? await this.app.vault.readBinary(localFile)
            : await this.app.vault.read(localFile);
        const localChunks = await splitIntoChunks(localContent, binary);
        const localChunkIds = localChunks.map((c) => c._id);

        if (
            localChunkIds.length === fileDoc.chunks.length &&
            localChunkIds.every((id, i) => id === fileDoc.chunks[i])
        ) {
            console.debug(`CouchSync: dbToFile skipped (content identical): ${fileDoc._id}`);
            return true;
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

    /**
     * Reconcile: scan local PouchDB for FileDocs that are missing or stale
     * in the vault, and apply them if all chunks are available. This is the
     * Apply layer's safety net — catches anything the event-driven onChange
     * path missed (e.g., FileDoc arrived before its chunks during live sync,
     * or dbToFile was interrupted).
     *
     * @param force - bypass the 30s throttle (used after reconnectWithPullFirst)
     */
    async reconcile(force = false): Promise<number> {
        if (this.reconciling) return 0;
        const now = Date.now();
        if (!force && now - this.lastReconcileTime < RECONCILE_MIN_INTERVAL) return 0;
        this.reconciling = true;
        this.lastReconcileTime = now;
        try {
            const allFileDocs = await this.db.allFileDocs();
            let applied = 0;
            for (const doc of allFileDocs) {
                if (doc.deleted) continue;
                if (!this.shouldSync(doc._id)) continue;
                const existing = this.app.vault.getAbstractFileByPath(doc._id);

                if (!existing) {
                    // File missing from vault — check chunk readiness, then apply
                    const chunks = await this.db.getChunks(doc.chunks);
                    if (chunks.length !== doc.chunks.length) continue;
                    await this.dbToFile(doc);
                    applied++;
                } else if ("stat" in existing) {
                    // File exists — check if content is stale
                    const binary = isBinaryFile(doc._id);
                    const skip = await this.shouldSkipWrite(doc, existing as TFile, binary);
                    if (!skip) {
                        await this.dbToFile(doc);
                        applied++;
                    }
                }
            }
            return applied;
        } finally {
            this.reconciling = false;
        }
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
