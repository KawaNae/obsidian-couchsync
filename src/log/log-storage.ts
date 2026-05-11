/**
 * Persistent log buffer backed by IndexedDB.
 *
 * Parallel to `HistoryStorage`: a small Dexie wrapper for one orthogonal
 * concern. The in-memory ring in `src/ui/log.ts` (500 entries) drives the
 * Log View; this layer holds the much larger N-day buffer that the user
 * exports to a .md snapshot on demand.
 *
 * All write errors are caught and surfaced as `console.warn` only — never
 * via `logError`. The append path is invoked from a listener on `pushEntry`,
 * so reporting an IDB failure via logError would re-enter the listener and
 * loop forever.
 */

import Dexie, { type Table } from "dexie";
import type { LogLevel } from "../ui/log.ts";

export interface PersistedLogEntry {
    /** Auto-increment primary key. */
    id?: number;
    timestamp: number;
    level: LogLevel;
    message: string;
}

export interface LogStorageStats {
    count: number;
    oldestTs: number | null;
    newestTs: number | null;
    approxBytes: number;
    /** Per-level counts (computed lazily; absent in lightweight stats path). */
    levels?: Record<LogLevel, number>;
}

class LogDB extends Dexie {
    entries!: Table<PersistedLogEntry, number>;

    constructor(vaultName: string) {
        super(`couchsync-logs-${vaultName}`);
        this.version(1).stores({
            entries: "++id, timestamp",
        });
    }
}

/** Rough byte size of one persisted entry. timestamp (8) + level (~8) +
 *  per-char overhead for the message (UTF-16 internal, 2 bytes/char) +
 *  Dexie record overhead. Used by count-proxy size cap — exact precision
 *  is not required, only stable order-of-magnitude. */
export function approxEntryBytes(entry: PersistedLogEntry): number {
    return 48 + entry.message.length * 2;
}

export class LogStorage {
    private db: LogDB;
    private readonly dbName: string;

    constructor(vaultName: string) {
        this.dbName = `couchsync-logs-${vaultName}`;
        this.db = new LogDB(vaultName);
    }

    async bulkAppend(entries: PersistedLogEntry[]): Promise<void> {
        if (entries.length === 0) return;
        try {
            await this.db.entries.bulkAdd(entries);
        } catch (e: any) {
            console.warn(`[log-storage] bulkAppend failed: ${e?.message ?? e}`);
        }
    }

    /** Read entries with timestamp >= sinceTs (or all if omitted), in
     *  ascending timestamp order. Used by the export path. */
    async getAll(sinceTs?: number): Promise<PersistedLogEntry[]> {
        try {
            const coll = sinceTs !== undefined
                ? this.db.entries.where("timestamp").aboveOrEqual(sinceTs)
                : this.db.entries.toCollection();
            return await coll.sortBy("timestamp");
        } catch (e: any) {
            console.warn(`[log-storage] getAll failed: ${e?.message ?? e}`);
            return [];
        }
    }

    /** Delete entries strictly older than cutoffTs. Returns the number
     *  removed. */
    async deleteBefore(cutoffTs: number): Promise<number> {
        try {
            return await this.db.entries.where("timestamp").below(cutoffTs).delete();
        } catch (e: any) {
            console.warn(`[log-storage] deleteBefore failed: ${e?.message ?? e}`);
            return 0;
        }
    }

    /** Trim oldest entries until total count <= maxEntries. Returns the
     *  number removed. */
    async trimToCount(maxEntries: number): Promise<number> {
        if (maxEntries < 0) return 0;
        try {
            const count = await this.db.entries.count();
            if (count <= maxEntries) return 0;
            const overflow = count - maxEntries;
            // primaryKeys() over an indexed range is O(N) scan only, no
            // record materialisation. Slice the oldest `overflow` ids by
            // timestamp ascending and bulkDelete.
            const oldestIds = await this.db.entries
                .orderBy("timestamp")
                .limit(overflow)
                .primaryKeys();
            await this.db.entries.bulkDelete(oldestIds);
            return oldestIds.length;
        } catch (e: any) {
            console.warn(`[log-storage] trimToCount failed: ${e?.message ?? e}`);
            return 0;
        }
    }

    /** Computed stats. `approxBytes` requires a full scan, so this is
     *  intended for periodic (1h) cleanup and on-demand UI refresh, not
     *  hot-path use. */
    async getStats(): Promise<LogStorageStats> {
        try {
            const count = await this.db.entries.count();
            if (count === 0) {
                return { count: 0, oldestTs: null, newestTs: null, approxBytes: 0 };
            }
            const oldest = await this.db.entries.orderBy("timestamp").first();
            const newest = await this.db.entries.orderBy("timestamp").last();
            let approxBytes = 0;
            const levels: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
            await this.db.entries.each((e) => {
                approxBytes += approxEntryBytes(e);
                levels[e.level] = (levels[e.level] ?? 0) + 1;
            });
            return {
                count,
                oldestTs: oldest?.timestamp ?? null,
                newestTs: newest?.timestamp ?? null,
                approxBytes,
                levels,
            };
        } catch (e: any) {
            console.warn(`[log-storage] getStats failed: ${e?.message ?? e}`);
            return { count: 0, oldestTs: null, newestTs: null, approxBytes: 0 };
        }
    }

    async clearAll(): Promise<void> {
        try {
            await this.db.entries.clear();
        } catch (e: any) {
            console.warn(`[log-storage] clearAll failed: ${e?.message ?? e}`);
        }
    }

    /** Close the connection. Idempotent. */
    close(): void {
        try {
            this.db.close();
        } catch { /* idempotent */ }
    }

    /** Delete the entire database (advanced reset path on the Maintenance
     *  tab). Closes the current connection and reopens a fresh one. */
    async deleteDatabase(): Promise<void> {
        try {
            this.db.close();
            await Dexie.delete(this.dbName);
        } catch (e: any) {
            console.warn(`[log-storage] deleteDatabase failed: ${e?.message ?? e}`);
        }
        // Reopen so subsequent appends/reads work without re-instantiation.
        this.db = new LogDB(this.dbName.replace(/^couchsync-logs-/, ""));
    }
}
