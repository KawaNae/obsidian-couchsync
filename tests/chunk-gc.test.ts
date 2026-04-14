import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestStore } from "./helpers/dexie-test-store.ts";
import { DexieStore } from "../src/db/dexie-store.ts";
import { LocalDB } from "../src/db/local-db.ts";
import type { FileDoc, ChunkDoc, CouchSyncDoc } from "../src/types.ts";
import { makeFileId, makeChunkId } from "../src/types/doc-id.ts";
import { gcOrphanChunks } from "../src/db/chunk-gc.ts";

// Minimal LocalDB backed by a test DexieStore.
function makeLocalDb(store: DexieStore<CouchSyncDoc>): LocalDB {
    const db = new LocalDB("chunk-gc-test-unused");
    // Inject the store directly (bypass open()).
    (db as any).store = store;
    return db;
}

function makeFile(
    path: string,
    chunks: string[],
    opts: { deleted?: boolean } = {},
): FileDoc {
    return {
        _id: makeFileId(path),
        type: "file",
        chunks,
        mtime: 1000,
        ctime: 1000,
        size: 100,
        deleted: opts.deleted,
        vclock: { A: 1 },
    };
}

function makeChunk(hash: string): ChunkDoc {
    return {
        _id: makeChunkId(hash),
        type: "chunk",
        data: "dGVzdA==",
    };
}

/** Shorthand: seed a doc via runWrite. */
async function put(store: DexieStore<CouchSyncDoc>, doc: CouchSyncDoc): Promise<void> {
    await store.runWrite({ docs: [{ doc }] });
}

describe("gcOrphanChunks", () => {
    let store: DexieStore<CouchSyncDoc>;
    let db: LocalDB;

    beforeEach(() => {
        store = createTestStore<CouchSyncDoc>("chunk-gc");
        db = makeLocalDb(store);
    });

    afterEach(async () => {
        await store.destroy();
    });

    it("deletes unreferenced chunks", async () => {
        const c1 = makeChunk("used1");
        const c2 = makeChunk("orphan1");
        await put(store, c1);
        await put(store, c2);
        await put(store, makeFile("a.md", [c1._id]));

        const result = await gcOrphanChunks(db);

        expect(result.deletedChunks).toBe(1);
        expect(result.scannedChunks).toBe(2);
        expect(result.referencedChunks).toBe(1);

        // Orphan should be gone.
        expect(await store.get(c2._id)).toBeNull();
        // Referenced chunk should remain.
        expect(await store.get(c1._id)).not.toBeNull();
    });

    it("keeps all chunks when none are orphaned", async () => {
        const c1 = makeChunk("ref1");
        const c2 = makeChunk("ref2");
        await put(store, c1);
        await put(store, c2);
        await put(store, makeFile("a.md", [c1._id, c2._id]));

        const result = await gcOrphanChunks(db);

        expect(result.deletedChunks).toBe(0);
        expect(result.scannedChunks).toBe(2);
    });

    it("treats chunks from deleted FileDocs as orphans", async () => {
        const c1 = makeChunk("dead");
        await put(store, c1);
        await put(store, makeFile("deleted.md", [c1._id], { deleted: true }));

        const result = await gcOrphanChunks(db);

        expect(result.deletedChunks).toBe(1);
        expect(await store.get(c1._id)).toBeNull();
    });

    it("handles empty store", async () => {
        const result = await gcOrphanChunks(db);

        expect(result.scannedChunks).toBe(0);
        expect(result.referencedChunks).toBe(0);
        expect(result.deletedChunks).toBe(0);
    });

    it("keeps chunk shared by multiple FileDocs even if one is deleted", async () => {
        const c1 = makeChunk("shared");
        await put(store, c1);
        await put(store, makeFile("alive.md", [c1._id]));
        await put(store, makeFile("dead.md", [c1._id], { deleted: true }));

        const result = await gcOrphanChunks(db);

        expect(result.deletedChunks).toBe(0);
        expect(await store.get(c1._id)).not.toBeNull();
    });
});
