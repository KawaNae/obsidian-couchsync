import { describe, it, expect, beforeEach, afterEach } from "vitest";
import PouchDB from "pouchdb";
import memoryAdapter from "pouchdb-adapter-memory";
import { ConflictResolver } from "../src/conflict/conflict-resolver.ts";
import type { CouchSyncDoc, FileDoc } from "../src/types.ts";

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
        getChunks: async () => [],
        destroy: () => db.destroy(),
    };
}

describe("ConflictResolver — editedAt-based resolution", () => {
    let testDb: ReturnType<typeof createTestDB>;

    beforeEach(() => {
        testDb = createTestDB(`conflict-test-${Date.now()}`);
    });

    afterEach(async () => {
        await testDb.destroy();
    });

    async function createConflict(
        docId: string,
        localAttrs: Partial<FileDoc>,
        remoteAttrs: Partial<FileDoc>,
    ): Promise<FileDoc> {
        const db = testDb.getDb();

        // Create initial doc
        const baseDoc: FileDoc = {
            _id: docId, type: "file", chunks: ["chunk:base"],
            mtime: 1000, ctime: 1000, size: 0,
        };
        const { rev: baseRev } = await db.put(baseDoc);

        // Create two conflicting updates from the same base
        const localDoc: FileDoc = {
            ...baseDoc, _rev: baseRev,
            chunks: ["chunk:local"], mtime: 2000,
            ...localAttrs,
        };
        await db.put(localDoc);

        const remoteDoc: FileDoc = {
            ...baseDoc, _rev: baseRev,
            chunks: ["chunk:remote"], mtime: 3000,
            ...remoteAttrs,
            _id: docId,
        };
        // Force a conflict by putting with the old rev (will be rejected),
        // so instead use bulkDocs with new_edits: false
        await db.bulkDocs([{
            ...remoteDoc,
            _rev: `2-remote${Date.now()}`,
        }], { new_edits: false });

        const result = await db.get(docId, { conflicts: true });
        return result as unknown as FileDoc;
    }

    it("resolves conflict using editedAt when both docs have it", async () => {
        const doc = await createConflict("test.md",
            { editedAt: 1500, chunks: ["chunk:older-edit"] },
            { editedAt: 2500, chunks: ["chunk:newer-edit"] },
        );

        expect(doc._conflicts).toBeDefined();
        expect(doc._conflicts!.length).toBeGreaterThan(0);

        const resolver = new ConflictResolver(testDb as any);
        const resolved = await resolver.resolveIfConflicted(doc);
        expect(resolved).toBe(true);

        // After resolution, the winner should have the higher editedAt
        const final = await testDb.getDb().get("test.md") as unknown as FileDoc;
        expect(final.editedAt).toBe(2500);
    });

    it("falls back to mtime when editedAt is missing", async () => {
        const doc = await createConflict("legacy.md",
            { mtime: 2000 },  // no editedAt
            { mtime: 3000 },  // no editedAt
        );

        const resolver = new ConflictResolver(testDb as any);
        await resolver.resolveIfConflicted(doc);

        const final = await testDb.getDb().get("legacy.md") as unknown as FileDoc;
        expect(final.mtime).toBe(3000);
    });

    it("calls onConflictResolved callback with winner and loser", async () => {
        const doc = await createConflict("callback.md",
            { editedAt: 1000, chunks: ["chunk:loser"] },
            { editedAt: 2000, chunks: ["chunk:winner"] },
        );

        let capturedWinner: FileDoc | null = null;
        let capturedLoser: FileDoc | null = null;

        const resolver = new ConflictResolver(testDb as any,
            async (_path, winner, loser) => {
                capturedWinner = winner;
                capturedLoser = loser;
            },
        );
        await resolver.resolveIfConflicted(doc);

        expect(capturedWinner).not.toBeNull();
        expect(capturedLoser).not.toBeNull();
        expect(capturedWinner!.editedAt).toBe(2000);
    });
});
