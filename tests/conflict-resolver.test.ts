import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import PouchDB from "pouchdb";
import memoryAdapter from "pouchdb-adapter-memory";
import { ConflictResolver } from "../src/conflict/conflict-resolver.ts";
import type { CouchSyncDoc, FileDoc, VectorClock } from "../src/types.ts";
import { makeFileId } from "../src/types/doc-id.ts";

PouchDB.plugin(memoryAdapter);

function createTestDB(name: string) {
    const db = new PouchDB<CouchSyncDoc>(name, { adapter: "memory" });
    return {
        getDb: () => db,
        put: async (doc: CouchSyncDoc) => {
            const existing = await db.get(doc._id).catch(() => null);
            if (existing) doc._rev = (existing as any)._rev;
            return db.put(doc);
        },
        getByRev: async (id: string, rev: string) => {
            try {
                return await db.get(id, { rev }) as unknown;
            } catch (e: any) {
                if (e.status === 404) return null;
                throw e;
            }
        },
        removeRev: async (id: string, rev: string) => {
            await db.remove(id, rev);
        },
        allDocs: async (opts?: any) => {
            return await db.allDocs(opts) as any;
        },
        get: async (id: string) => {
            try { return await db.get(id) as unknown; }
            catch (e: any) { if (e.status === 404) return null; throw e; }
        },
        getChunks: async () => [],
        destroy: () => db.destroy(),
    };
}

/**
 * Build a conflict state where `localAttrs` is the current winning rev and
 * `remoteAttrs` is an alternate rev in the _conflicts tree. Returns the
 * current rev as read back from PouchDB with conflicts populated.
 */
async function createConflict(
    testDb: ReturnType<typeof createTestDB>,
    vaultPath: string,
    localAttrs: Partial<FileDoc>,
    remoteAttrs: Partial<FileDoc>,
): Promise<FileDoc> {
    const db = testDb.getDb();
    const docId = makeFileId(vaultPath);
    const baseDoc: FileDoc = {
        _id: docId,
        type: "file",
        chunks: ["chunk:base"],
        mtime: 1000,
        ctime: 1000,
        size: 0,
        vclock: {},
    };
    const { rev: baseRev } = await db.put(baseDoc);

    const localDoc: FileDoc = {
        ...baseDoc,
        _rev: baseRev,
        chunks: ["chunk:local"],
        ...localAttrs,
    };
    await db.put(localDoc);

    const remoteDoc: FileDoc = {
        ...baseDoc,
        chunks: ["chunk:remote"],
        ...remoteAttrs,
    };
    await db.bulkDocs(
        [{ ...remoteDoc, _rev: `2-remote${Date.now()}${Math.random()}` }],
        { new_edits: false },
    );

    const result = await db.get(docId, { conflicts: true });
    return result as unknown as FileDoc;
}

describe("ConflictResolver — VC-based resolution", () => {
    let testDb: ReturnType<typeof createTestDB>;

    beforeEach(() => {
        testDb = createTestDB(`vc-conflict-test-${Date.now()}-${Math.random()}`);
    });

    afterEach(async () => {
        await testDb.destroy();
    });

    it("auto-resolves when one revision strictly dominates the other", async () => {
        const doc = await createConflict(testDb, "dominates.md",
            { vclock: { A: 2, B: 1 }, chunks: ["chunk:local"] },
            { vclock: { A: 1, B: 1 }, chunks: ["chunk:remote"] },
        );
        expect(doc._conflicts?.length).toBeGreaterThan(0);

        const resolver = new ConflictResolver(testDb as any);
        const onConcurrent = vi.fn();
        resolver.setOnConcurrent(onConcurrent);

        const resolved = await resolver.resolveIfConflicted(doc);
        expect(resolved).toBe(true);
        expect(onConcurrent).not.toHaveBeenCalled();

        const final = await testDb.getDb().get(makeFileId("dominates.md"), { conflicts: true }) as any;
        expect(final._conflicts).toBeUndefined();
        // Winner should be the A:2 revision — its chunks
        expect(final.chunks).toEqual(["chunk:local"]);
        expect(final.vclock).toEqual({ A: 2, B: 1 });
    });

    it("raises onConcurrent callback when no revision dominates", async () => {
        const doc = await createConflict(testDb, "concurrent.md",
            { vclock: { A: 1, B: 0 }, chunks: ["chunk:local"] },
            { vclock: { A: 0, B: 1 }, chunks: ["chunk:remote"] },
        );

        const resolver = new ConflictResolver(testDb as any);
        const onConcurrent = vi.fn();
        resolver.setOnConcurrent(onConcurrent);

        const resolved = await resolver.resolveIfConflicted(doc);
        expect(resolved).toBe(false);
        expect(onConcurrent).toHaveBeenCalledTimes(1);
        const [path, revs] = onConcurrent.mock.calls[0];
        expect(path).toBe("concurrent.md");
        expect(Array.isArray(revs)).toBe(true);
        expect(revs.length).toBe(2);
    });

    it("does NOT use mtime or editedAt as a tiebreaker", async () => {
        // Both revs are causally concurrent. If the resolver fell back to
        // mtime, it would silently pick the higher mtime one. We want it
        // to raise a conflict instead.
        const doc = await createConflict(testDb, "tiebreak.md",
            {
                vclock: { A: 1, B: 0 },
                chunks: ["chunk:local"],
                mtime: 9999, // very new
            },
            {
                vclock: { A: 0, B: 1 },
                chunks: ["chunk:remote"],
                mtime: 1,    // very old
            },
        );

        const resolver = new ConflictResolver(testDb as any);
        const onConcurrent = vi.fn();
        resolver.setOnConcurrent(onConcurrent);

        const resolved = await resolver.resolveIfConflicted(doc);
        expect(resolved).toBe(false);
        expect(onConcurrent).toHaveBeenCalled();
    });

    it("is a no-op when the doc has no conflicts", async () => {
        const clean: FileDoc = {
            _id: makeFileId("clean.md"), type: "file",
            chunks: ["chunk:only"], mtime: 1, ctime: 1, size: 0,
            vclock: { A: 1 },
        };
        const resolver = new ConflictResolver(testDb as any);
        expect(await resolver.resolveIfConflicted(clean)).toBe(false);
    });

    it("returns false and does not call callback when onConcurrent is unset", async () => {
        const doc = await createConflict(testDb, "no-cb.md",
            { vclock: { A: 1 }, chunks: ["chunk:local"] },
            { vclock: { B: 1 }, chunks: ["chunk:remote"] },
        );
        const resolver = new ConflictResolver(testDb as any);
        const resolved = await resolver.resolveIfConflicted(doc);
        expect(resolved).toBe(false);
    });
});
