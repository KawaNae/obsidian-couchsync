import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import PouchDB from "pouchdb";
import memoryAdapter from "pouchdb-adapter-memory";
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
        destroy: () => db.destroy(),
    };
}

function makeFileDoc(id: string, mtime: number, chunks: string[] = []): FileDoc {
    return { _id: id, type: "file", chunks, mtime, ctime: mtime, size: 0 };
}

describe("pull-first reconnection strategy", () => {
    let local: ReturnType<typeof createTestDB>;
    let remote: ReturnType<typeof createTestDB>;

    beforeEach(() => {
        const id = Date.now();
        local = createTestDB(`pull-first-local-${id}`);
        remote = createTestDB(`pull-first-remote-${id}`);
    });

    afterEach(async () => {
        await local.destroy();
        await remote.destroy();
    });

    it("one-shot pull brings remote docs to local before bidirectional sync starts", async () => {
        // Remote has a newer doc that local doesn't have
        await remote.put(makeFileDoc("note.md", 2000));

        // Phase 1: one-shot pull (simulates startWithPullFirst pull phase)
        const pulledDocs: CouchSyncDoc[] = [];
        await new Promise<void>((resolve, reject) => {
            const replication = local.getDb().replicate.from(remote.getDb(), { batch_size: 50 });
            replication.on("change", (info) => {
                if (info.docs) {
                    for (const doc of info.docs) {
                        pulledDocs.push(doc as unknown as CouchSyncDoc);
                    }
                }
            });
            replication.on("complete", () => resolve());
            replication.on("error", (err) => reject(err));
        });

        // Verify remote doc was pulled
        expect(pulledDocs.length).toBeGreaterThanOrEqual(1);
        const pulledNote = pulledDocs.find((d) => d._id === "note.md");
        expect(pulledNote).toBeDefined();
        expect((pulledNote as FileDoc).mtime).toBe(2000);

        // Verify local DB now has the remote doc
        const localDoc = await local.getDb().get("note.md");
        expect(localDoc).toBeDefined();
    });

    it("stale local doc does not overwrite remote when pull-first is used", async () => {
        // Both have the same doc initially (simulate prior sync)
        await local.put(makeFileDoc("shared.md", 1000));
        await new Promise<void>((resolve, reject) => {
            const sync = local.getDb().sync(remote.getDb());
            sync.on("complete", () => resolve());
            sync.on("error", (err) => reject(err));
        });

        // Remote gets updated (desktop edits while mobile offline)
        const remoteDoc = await remote.getDb().get("shared.md");
        await remote.getDb().put({
            ...remoteDoc,
            mtime: 3000,
            chunks: ["chunk:newer"],
        } as any);

        // Phase 1: one-shot pull (mobile reconnects)
        const pulledDocs: CouchSyncDoc[] = [];
        await new Promise<void>((resolve, reject) => {
            const replication = local.getDb().replicate.from(remote.getDb(), { batch_size: 50 });
            replication.on("change", (info) => {
                if (info.docs) {
                    for (const doc of info.docs) {
                        pulledDocs.push(doc as unknown as CouchSyncDoc);
                    }
                }
            });
            replication.on("complete", () => resolve());
            replication.on("error", (err) => reject(err));
        });

        // After pull, local should have the newer version
        const localDoc = await local.getDb().get("shared.md") as any;
        expect(localDoc.mtime).toBe(3000);
        expect(localDoc.chunks).toEqual(["chunk:newer"]);

        // Phase 2: bidirectional sync should NOT push old version back
        await new Promise<void>((resolve, reject) => {
            const sync = local.getDb().sync(remote.getDb());
            sync.on("complete", () => resolve());
            sync.on("error", (err) => reject(err));
        });

        // Remote should still have mtime 3000, not overwritten
        const remoteAfter = await remote.getDb().get("shared.md") as any;
        expect(remoteAfter.mtime).toBe(3000);
    });

    it("offline local edits create a conflict that can be resolved by mtime", async () => {
        // Initial sync: both have same doc
        await local.put(makeFileDoc("conflict.md", 1000));
        await new Promise<void>((resolve, reject) => {
            const sync = local.getDb().sync(remote.getDb());
            sync.on("complete", () => resolve());
            sync.on("error", (err) => reject(err));
        });

        // Both sides edit independently (offline scenario)
        const localDoc = await local.getDb().get("conflict.md");
        await local.getDb().put({
            ...localDoc,
            mtime: 2000,
            chunks: ["chunk:mobile-edit"],
        } as any);

        const remoteDoc = await remote.getDb().get("conflict.md");
        await remote.getDb().put({
            ...remoteDoc,
            mtime: 3000,
            chunks: ["chunk:desktop-edit"],
        } as any);

        // Pull-first phase: pull remote changes
        await new Promise<void>((resolve, reject) => {
            const replication = local.getDb().replicate.from(remote.getDb(), { batch_size: 50 });
            replication.on("complete", () => resolve());
            replication.on("error", (err) => reject(err));
        });

        // Local should have conflicts
        const result = await local.getDb().get("conflict.md", { conflicts: true });
        expect(result._conflicts).toBeDefined();
        expect(result._conflicts!.length).toBeGreaterThan(0);

        // The winning revision (deterministic by PouchDB) and the conflict
        // should both be accessible for mtime-based resolution
        const conflictRev = result._conflicts![0];
        const conflicting = await local.getDb().get("conflict.md", { rev: conflictRev });

        // One of them should have mtime 2000, the other 3000
        const mtimes = [(result as any).mtime, (conflicting as any).mtime].sort();
        expect(mtimes).toEqual([2000, 3000]);
    });

    it("pull with no remote changes completes immediately", async () => {
        // Both in sync
        await local.put(makeFileDoc("synced.md", 1000));
        await new Promise<void>((resolve, reject) => {
            const sync = local.getDb().sync(remote.getDb());
            sync.on("complete", () => resolve());
            sync.on("error", (err) => reject(err));
        });

        // Pull-first with no new changes
        const pulledDocs: CouchSyncDoc[] = [];
        await new Promise<void>((resolve, reject) => {
            const replication = local.getDb().replicate.from(remote.getDb(), { batch_size: 50 });
            replication.on("change", (info) => {
                if (info.docs) {
                    for (const doc of info.docs) {
                        pulledDocs.push(doc as unknown as CouchSyncDoc);
                    }
                }
            });
            replication.on("complete", () => resolve());
            replication.on("error", (err) => reject(err));
        });

        // No docs should have been pulled
        expect(pulledDocs.length).toBe(0);
    });
});
