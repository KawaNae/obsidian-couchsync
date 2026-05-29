import Dexie, { type Table } from "dexie";
import type { DiffRecord, FileSnapshot, HistorySource } from "./types.ts";

/** Local content schema version stamped into `_meta` on first open.
 *  Bumped when the shape of a DiffRecord / FileSnapshot row changes
 *  in a way that requires a one-shot migration. Independent of the
 *  Dexie DB-level version (which tracks table-shape evolution). */
const HISTORY_SCHEMA_VERSION = 1 as const;

interface MetaRow { key: string; value: number }

class HistoryDB extends Dexie {
    diffs!: Table<DiffRecord, string>;
    snapshots!: Table<FileSnapshot, string>;
    _meta!: Table<MetaRow, string>;

    constructor(vaultName: string) {
        super(`couchsync-history-${vaultName}`);
        this.version(1).stores({
            diffs: "++id, [filePath+timestamp], filePath, timestamp",
            snapshots: "filePath",
        });
        // v2: add `_meta` table for application-level schema versioning.
        // Invariant 15 — every local Dexie DB carries its own format
        // version row independent of the DB-level Dexie migration chain.
        this.version(2).stores({
            diffs: "++id, [filePath+timestamp], filePath, timestamp",
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

    /** Stamp `_meta.schemaVersion` on first open, or assert the stored
     *  value matches `HISTORY_SCHEMA_VERSION`. Idempotent. */
    async ensureSchemaVersion(): Promise<void> {
        const existing = await this.db._meta.get("schemaVersion");
        if (existing === undefined) {
            await this.db._meta.put({ key: "schemaVersion", value: HISTORY_SCHEMA_VERSION });
            return;
        }
        if (existing.value !== HISTORY_SCHEMA_VERSION) {
            throw new Error(
                `HistoryStorage schema version mismatch (stored=${existing.value}, expected=${HISTORY_SCHEMA_VERSION})`,
            );
        }
    }

    async saveDiff(
        filePath: string,
        patches: string,
        baseHash: string,
        added: number,
        removed: number,
        conflict = false,
        source: HistorySource = "local",
    ): Promise<void> {
        await this.db.diffs.add({
            filePath,
            timestamp: Date.now(),
            patches,
            baseHash,
            added,
            removed,
            conflict: conflict || undefined,
            source,
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
