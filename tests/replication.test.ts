import { describe, it, expect, beforeEach, afterEach } from "vitest";
import PouchDB from "pouchdb";
import memoryAdapter from "pouchdb-adapter-memory";
import { splitIntoChunks } from "../src/db/chunker.ts";
import { ConflictResolver } from "../src/conflict/conflict-resolver.ts";
import type { FileDoc, CouchSyncDoc } from "../src/types.ts";
import { makeFileId } from "../src/types/doc-id.ts";

PouchDB.plugin(memoryAdapter);

// Minimal LocalDB wrapper for tests
function createLocalDB(name: string) {
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
        allDocs: async (opts?: any) => db.allDocs(opts) as any,
        getChunks: async (chunkIds: string[]) => {
            const result = await db.allDocs({ keys: chunkIds, include_docs: true });
            return result.rows
                .filter((r): r is any => "doc" in r && r.doc != null)
                .map((r) => r.doc);
        },
        getFileDoc: async (path: string) => {
            try { return (await db.get(makeFileId(path))) as FileDoc; }
            catch { return null; }
        },
        close: () => db.close(),
        destroy: () => db.destroy(),
    };
}

async function createFileDoc(
    db: ReturnType<typeof createLocalDB>,
    path: string,
    content: string,
    mtime: number,
    vclock: Record<string, number> = { test: 1 },
): Promise<FileDoc> {
    const chunks = await splitIntoChunks(new TextEncoder().encode(content).buffer);
    for (const chunk of chunks) {
        await db.put(chunk);
    }
    const fileDoc: FileDoc = {
        _id: makeFileId(path),
        type: "file",
        chunks: chunks.map((c) => c._id),
        mtime,
        ctime: mtime,
        size: content.length,
        vclock,
    };
    await db.put(fileDoc);
    return fileDoc;
}

describe("PouchDB replication", () => {
    let db1: ReturnType<typeof createLocalDB>;
    let db2: ReturnType<typeof createLocalDB>;
    let counter: number;

    beforeEach(() => {
        counter = Date.now();
        db1 = createLocalDB(`test-repl-1-${counter}`);
        db2 = createLocalDB(`test-repl-2-${counter}`);
    });

    afterEach(async () => {
        await db1.destroy();
        await db2.destroy();
    });

    it("replicates a document from db1 to db2", async () => {
        await createFileDoc(db1, "test.md", "hello world", 1000);

        await db1.getDb().replicate.to(db2.getDb());

        const doc = await db2.getFileDoc("test.md");
        expect(doc).not.toBeNull();
        expect(doc!.type).toBe("file");
        expect(doc!.mtime).toBe(1000);
    });

    it("creates a conflict when both sides modify the same doc", async () => {
        // Initial state: same doc on both sides
        await createFileDoc(db1, "note.md", "original", 1000);
        await db1.getDb().replicate.to(db2.getDb());

        // Both sides modify independently
        await createFileDoc(db1, "note.md", "version A", 2000);
        await createFileDoc(db2, "note.md", "version B", 3000);

        // Sync → conflict
        await db1.getDb().replicate.to(db2.getDb());
        await db2.getDb().replicate.to(db1.getDb());

        // Check for conflicts on db1
        const doc = await db1.getDb().get(makeFileId("note.md"), { conflicts: true });
        expect(doc._conflicts).toBeDefined();
        expect(doc._conflicts!.length).toBeGreaterThan(0);
    });

    it("ConflictResolver picks the VC-dominator as winner (ignoring mtime)", async () => {
        // Build a scenario where mtime DISAGREES with VC. The "old edit"
        // side has a HIGHER mtime but a DOMINATED vclock.
        const localDoc = await createFileDoc(db1, "note.md", "old edit (wrong)", 9999, { A: 2 });
        const remoteDoc = await createFileDoc(db2, "note.md", "new edit (right)", 1, { A: 3 });

        // Phase 2: resolveOnPull compares docs directly.
        const resolver = new ConflictResolver();
        const verdict = await resolver.resolveOnPull(localDoc, remoteDoc);
        // Remote (A:3) dominates local (A:2) → take-remote
        expect(verdict).toBe("take-remote");
    });

    it("ConflictResolver calls onAutoResolved with winner and losers for dominated conflicts", async () => {
        const localDoc = await createFileDoc(db1, "note.md", "loser", 2000, { A: 2 });
        const remoteDoc = await createFileDoc(db2, "note.md", "winner", 5000, { A: 3 });

        let callbackArgs: { filePath: string; winnerVC: any; loserCount: number } | null = null;

        const resolver = new ConflictResolver(
            async (filePath, winner, losers) => {
                callbackArgs = {
                    filePath,
                    winnerVC: winner.vclock,
                    loserCount: losers.length,
                };
            },
        );

        await resolver.resolveOnPull(localDoc, remoteDoc);

        expect(callbackArgs).not.toBeNull();
        expect(callbackArgs!.filePath).toBe("note.md");
        expect(callbackArgs!.winnerVC).toEqual({ A: 3 });
        expect(callbackArgs!.loserCount).toBe(1);
    });

    it("ConflictResolver raises onConcurrent callback when VCs are incomparable", async () => {
        // Device A and B each bump only their own key — pure concurrent edits.
        const localDoc = await createFileDoc(db1, "note.md", "A's edit", 2000, { A: 2, B: 0 });
        const remoteDoc = await createFileDoc(db2, "note.md", "B's edit", 2000, { A: 0, B: 1 });

        const concurrentCalls: string[] = [];
        const resolver = new ConflictResolver();
        resolver.setOnConcurrent((path) => {
            concurrentCalls.push(path);
        });

        const verdict = await resolver.resolveOnPull(localDoc, remoteDoc);
        expect(verdict).toBe("concurrent");
        expect(concurrentCalls).toContain("note.md");
    });
});

describe("chunk deduplication skip", () => {
    let db: ReturnType<typeof createLocalDB>;

    beforeEach(() => {
        db = createLocalDB(`test-dedup-${Date.now()}`);
    });

    afterEach(async () => {
        await db.destroy();
    });

    it("same content produces same chunk IDs so fileToDb can skip", async () => {
        const content = "same content";
        const chunks1 = await splitIntoChunks(new TextEncoder().encode(content).buffer);
        const chunks2 = await splitIntoChunks(new TextEncoder().encode(content).buffer);

        const ids1 = chunks1.map((c) => c._id);
        const ids2 = chunks2.map((c) => c._id);

        expect(ids1).toEqual(ids2);

        // Simulate fileToDb skip logic
        await createFileDoc(db, "test.md", content, 1000);
        const existing = await db.getFileDoc("test.md");

        const shouldSkip =
            existing &&
            existing.chunks.length === ids2.length &&
            existing.chunks.every((id, i) => id === ids2[i]);

        expect(shouldSkip).toBe(true);
    });

    it("different content produces different chunk IDs", async () => {
        const chunks1 = await splitIntoChunks(new TextEncoder().encode("content A").buffer);
        const chunks2 = await splitIntoChunks(new TextEncoder().encode("content B").buffer);

        await createFileDoc(db, "test.md", "content A", 1000);
        const existing = await db.getFileDoc("test.md");

        const ids2 = chunks2.map((c) => c._id);
        const shouldSkip =
            existing &&
            existing.chunks.length === ids2.length &&
            existing.chunks.every((id, i) => id === ids2[i]);

        expect(shouldSkip).toBe(false);
    });
});
