import type { App, TFile } from "obsidian";
import type { LocalDB } from "../db/local-db.ts";
import type { FileDoc } from "../types.ts";
import type { CouchSyncSettings } from "../settings.ts";
import { splitIntoChunks, joinChunks } from "../db/chunker.ts";
import { isBinaryFile } from "../utils/binary.ts";

export class VaultSync {
    constructor(
        private app: App,
        private db: LocalDB,
        private getSettings: () => CouchSyncSettings
    ) {}

    async fileToDb(file: TFile): Promise<void> {
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

        await this.db.bulkPut(chunks);

        const fileDoc: FileDoc = {
            _id: file.path,
            type: "file",
            chunks: chunkIds,
            mtime: file.stat.mtime,
            ctime: file.stat.ctime,
            size: file.stat.size,
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

        const binary = isBinaryFile(fileDoc._id);
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
        const existing = this.app.vault.getAbstractFileByPath(fileDoc._id);

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
