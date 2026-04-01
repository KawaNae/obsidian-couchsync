import Dexie, { type Table } from "dexie";
import type { DiffRecord, FileSnapshot } from "./types.ts";

class HistoryDB extends Dexie {
    diffs!: Table<DiffRecord, string>;
    snapshots!: Table<FileSnapshot, string>;

    constructor(vaultName: string) {
        super(`couchsync-history-${vaultName}`);
        this.version(1).stores({
            diffs: "++id, [filePath+timestamp], filePath, timestamp",
            snapshots: "filePath",
        });
    }
}

export class HistoryStorage {
    private db: HistoryDB;

    constructor(vaultName: string) {
        this.db = new HistoryDB(vaultName);
    }

    async saveDiff(
        filePath: string,
        patches: string,
        baseHash: string,
        added: number,
        removed: number,
        conflict = false,
    ): Promise<void> {
        await this.db.diffs.add({
            filePath,
            timestamp: Date.now(),
            patches,
            baseHash,
            added,
            removed,
            conflict: conflict || undefined,
        });
    }

    async getSnapshot(filePath: string): Promise<FileSnapshot | undefined> {
        return this.db.snapshots.get(filePath);
    }

    async saveSnapshot(filePath: string, content: string): Promise<void> {
        await this.db.snapshots.put({
            filePath,
            content,
            lastModified: Date.now(),
        });
    }

    async getDiffs(filePath: string, since?: number): Promise<DiffRecord[]> {
        const lowerBound = [filePath, since ?? Dexie.minKey];
        const upperBound = [filePath, Dexie.maxKey];
        return this.db.diffs
            .where("[filePath+timestamp]")
            .between(lowerBound, upperBound)
            .sortBy("timestamp");
    }

    async deleteBefore(timestamp: number): Promise<number> {
        return this.db.diffs.where("timestamp").below(timestamp).delete();
    }

    async deleteByFile(filePath: string): Promise<number> {
        const count = await this.db.diffs.where("filePath").equals(filePath).delete();
        await this.db.snapshots.delete(filePath);
        return count;
    }

    async deleteAll(): Promise<void> {
        await this.db.diffs.clear();
        await this.db.snapshots.clear();
    }

    async renamePath(oldPath: string, newPath: string): Promise<void> {
        await this.db.transaction("rw", this.db.diffs, this.db.snapshots, async () => {
            const diffs = await this.db.diffs.where("filePath").equals(oldPath).toArray();
            for (const diff of diffs) {
                await this.db.diffs.update(diff.id!, { filePath: newPath });
            }
            const snapshot = await this.db.snapshots.get(oldPath);
            if (snapshot) {
                await this.db.snapshots.delete(oldPath);
                await this.db.snapshots.put({ ...snapshot, filePath: newPath });
            }
        });
    }

    async getStorageEstimate(): Promise<{ count: number; oldest?: number }> {
        const count = await this.db.diffs.count();
        const oldest = await this.db.diffs.orderBy("timestamp").first();
        return { count, oldest: oldest?.timestamp };
    }

    close(): void {
        this.db.close();
    }
}
