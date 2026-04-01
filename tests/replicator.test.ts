import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import PouchDB from "pouchdb";
import memoryAdapter from "pouchdb-adapter-memory";
import type { CouchSyncDoc } from "../src/types.ts";

PouchDB.plugin(memoryAdapter);

// Minimal LocalDB for testing Replicator internals
function createTestDB(name: string) {
    const db = new PouchDB<CouchSyncDoc>(name, { adapter: "memory" });
    return {
        getDb: () => db,
        get: async <T extends CouchSyncDoc>(id: string): Promise<T | null> => {
            try { return (await db.get(id)) as T; }
            catch (e: any) { if (e.status === 404) return null; throw e; }
        },
        put: async (doc: CouchSyncDoc) => {
            const existing = await db.get(doc._id).catch(() => null);
            if (existing) doc._rev = (existing as any)._rev;
            return db.put(doc);
        },
        close: () => db.close(),
        destroy: () => db.destroy(),
    };
}

describe("onceIdle behavior via PouchDB sync", () => {
    let db1: ReturnType<typeof createTestDB>;
    let db2: ReturnType<typeof createTestDB>;

    beforeEach(() => {
        const id = Date.now();
        db1 = createTestDB(`idle-test-1-${id}`);
        db2 = createTestDB(`idle-test-2-${id}`);
    });

    afterEach(async () => {
        await db1.destroy();
        await db2.destroy();
    });

    it("PouchDB paused event fires with no error when sync catches up", async () => {
        // Put a doc in db1
        await db1.getDb().put({ _id: "test.md", type: "file", chunks: [], mtime: 1, ctime: 1, size: 0 } as any);

        const pausedPromise = new Promise<boolean>((resolve) => {
            const sync = db1.getDb().sync(db2.getDb(), { live: true, retry: false });
            sync.on("paused", (err: any) => {
                sync.cancel();
                resolve(!err); // true if no error = caught up
            });
        });

        const caughtUp = await pausedPromise;
        expect(caughtUp).toBe(true);
    });

    it("paused event fires even with empty databases", async () => {
        const pausedPromise = new Promise<boolean>((resolve) => {
            const sync = db1.getDb().sync(db2.getDb(), { live: true, retry: false });
            sync.on("paused", (err: any) => {
                sync.cancel();
                resolve(!err);
            });
        });

        const caughtUp = await pausedPromise;
        expect(caughtUp).toBe(true);
    });

    it("onceIdle pattern: callback fires once on first idle", async () => {
        const callback = vi.fn();
        let hasBeenIdle = false;

        await db1.getDb().put({ _id: "a.md", type: "file", chunks: [], mtime: 1, ctime: 1, size: 0 } as any);

        await new Promise<void>((resolve) => {
            const sync = db1.getDb().sync(db2.getDb(), { live: true, retry: false });
            sync.on("paused", (err: any) => {
                if (!err && !hasBeenIdle) {
                    hasBeenIdle = true;
                    callback();
                }
                sync.cancel();
                resolve();
            });
        });

        expect(callback).toHaveBeenCalledTimes(1);
    });
});

describe("update_seq stall detection", () => {
    let db: ReturnType<typeof createTestDB>;

    beforeEach(() => {
        db = createTestDB(`seq-test-${Date.now()}`);
    });

    afterEach(async () => {
        await db.destroy();
    });

    it("update_seq increases when documents are added", async () => {
        const info1 = await db.getDb().info();
        const seq1 = info1.update_seq;

        await db.getDb().put({ _id: "test1", type: "file", chunks: [], mtime: 1, ctime: 1, size: 0 } as any);

        const info2 = await db.getDb().info();
        const seq2 = info2.update_seq;

        expect(seq2).not.toBe(seq1);
    });

    it("update_seq stays the same when no changes occur", async () => {
        await db.getDb().put({ _id: "test1", type: "file", chunks: [], mtime: 1, ctime: 1, size: 0 } as any);

        const info1 = await db.getDb().info();
        const info2 = await db.getDb().info();

        expect(info1.update_seq).toBe(info2.update_seq);
    });
});
