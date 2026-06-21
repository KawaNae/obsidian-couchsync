import Dexie, { type Table } from "dexie";
import type { DiffRecord, FileSnapshot, HistorySource } from "./types.ts";
import { logDebug, logError } from "../ui/log.ts";

const HISTORY_SCHEMA_VERSION = 2 as const;

interface MetaRow { key: string; value: number }

class HistoryDB extends Dexie {
    diffs!: Table<DiffRecord, number>;
    snapshots!: Table<FileSnapshot, string>;
    _meta!: Table<MetaRow, string>;

    constructor(vaultName: string) {
        super(`couchsync-history-${vaultName}`);
        this.version(1).stores({
            diffs: "++id, [filePath+timestamp], filePath, timestamp",
            snapshots: "filePath",
        });
        this.version(2).stores({
            diffs: "++id, [filePath+timestamp], filePath, timestamp",
            snapshots: "filePath",
            _meta: "&key",
        });
        this.version(3).stores({
            diffs: "++id, [filePath+timestamp], filePath, timestamp, parentId",
            snapshots: "filePath",
            _meta: "&key",
        });
    }
}

export class HistoryStorage {
    private db: HistoryDB;

    constructor(vaultName: string) {
        this.db = new HistoryDB(vaultName);
    }

    async ensureSchemaVersion(): Promise<void> {
        const existing = await this.db._meta.get("schemaVersion");
        if (existing === undefined) {
            await this.db._meta.put({ key: "schemaVersion", value: HISTORY_SCHEMA_VERSION });
            return;
        }
        if (existing.value === 1) {
            await this.migrateV1toV2();
            return;
        }
        if (existing.value !== HISTORY_SCHEMA_VERSION) {
            throw new Error(
                `HistoryStorage schema version mismatch (stored=${existing.value}, expected=${HISTORY_SCHEMA_VERSION})`,
            );
        }
    }

    private async migrateV1toV2(): Promise<void> {
        logDebug("History: migrating schema v1 → v2 (parentId chain)");
        await this.db.transaction("rw", this.db.diffs, this.db.snapshots, this.db._meta, async () => {
            const filePaths = new Set<string>();
            await this.db.diffs.each((d) => filePaths.add(d.filePath));

            for (const fp of filePaths) {
                const diffs = await this.db.diffs
                    .where("[filePath+timestamp]")
                    .between([fp, Dexie.minKey], [fp, Dexie.maxKey])
                    .sortBy("timestamp");

                let prevId: number | null = null;
                for (const diff of diffs) {
                    await this.db.diffs.update(diff.id!, { parentId: prevId });
                    prevId = diff.id!;
                }

                const snapshot = await this.db.snapshots.get(fp);
                if (snapshot) {
                    await this.db.snapshots.put({ ...snapshot, headRecordId: prevId });
                }
            }

            await this.db._meta.put({ key: "schemaVersion", value: HISTORY_SCHEMA_VERSION });
        });
        logDebug("History: migration v1 → v2 complete");
    }

    async saveDiff(
        filePath: string,
        patches: string,
        baseHash: string,
        added: number,
        removed: number,
        conflict: boolean,
        source: HistorySource,
        parentId: number | null,
    ): Promise<number> {
        return await this.db.diffs.add({
            filePath,
            timestamp: Date.now(),
            patches,
            baseHash,
            added,
            removed,
            conflict: conflict || undefined,
            source,
            parentId,
        }) as number;
    }

    async getSnapshot(filePath: string): Promise<FileSnapshot | undefined> {
        return this.db.snapshots.get(filePath);
    }

    async saveSnapshot(filePath: string, content: string, headRecordId: number | null): Promise<void> {
        await this.db.snapshots.put({
            filePath,
            content,
            lastModified: Date.now(),
            headRecordId,
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
