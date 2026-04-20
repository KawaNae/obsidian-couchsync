import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LocalDB } from "../src/db/local-db.ts";
import type { FileDoc, ChunkDoc, CouchSyncDoc } from "../src/types.ts";
import { makeFileId, makeChunkId } from "../src/types/doc-id.ts";
import { gcOrphanChunks } from "../src/db/chunk-gc.ts";

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

/** Shorthand: seed a doc via the LocalDB public API. */
async function put(db: LocalDB, doc: CouchSyncDoc): Promise<void> {
    await db.runWriteTx({ docs: [{ doc }] });
}

let counter = 0;

describe("gcOrphanChunks", () => {
    let db: LocalDB;

    beforeEach(() => {
        db = new LocalDB(`chunk-gc-${Date.now()}-${counter++}`);
        db.open();
    });

    afterEach(async () => {
        await db.destroy();
    });

    it("deletes unreferenced chunks", async () => {
        const c1 = makeChunk("used1");
        const c2 = makeChunk("orphan1");
        await put(db, c1);
        await put(db, c2);
        await put(db, makeFile("a.md", [c1._id]));

        const result = await gcOrphanChunks(db);

        expect(result.deletedChunks).toBe(1);
        expect(result.scannedChunks).toBe(2);
        expect(result.referencedChunks).toBe(1);

        expect(await db.get(c2._id)).toBeNull();
        expect(await db.get(c1._id)).not.toBeNull();
    });

    it("keeps all chunks when none are orphaned", async () => {
        const c1 = makeChunk("ref1");
        const c2 = makeChunk("ref2");
        await put(db, c1);
        await put(db, c2);
        await put(db, makeFile("a.md", [c1._id, c2._id]));

        const result = await gcOrphanChunks(db);

        expect(result.deletedChunks).toBe(0);
        expect(result.scannedChunks).toBe(2);
    });

    it("treats chunks from deleted FileDocs as orphans", async () => {
        const c1 = makeChunk("dead");
        await put(db, c1);
        await put(db, makeFile("deleted.md", [c1._id], { deleted: true }));

        const result = await gcOrphanChunks(db);

        expect(result.deletedChunks).toBe(1);
        expect(await db.get(c1._id)).toBeNull();
    });

    it("handles empty store", async () => {
        const result = await gcOrphanChunks(db);

        expect(result.scannedChunks).toBe(0);
        expect(result.referencedChunks).toBe(0);
        expect(result.deletedChunks).toBe(0);
    });

    it("keeps chunk shared by multiple FileDocs even if one is deleted", async () => {
        const c1 = makeChunk("shared");
        await put(db, c1);
        await put(db, makeFile("alive.md", [c1._id]));
        await put(db, makeFile("dead.md", [c1._id], { deleted: true }));

        const result = await gcOrphanChunks(db);

        expect(result.deletedChunks).toBe(0);
        expect(await db.get(c1._id)).not.toBeNull();
    });
});
