/**
 * End-to-end Vector Clock integration tests.
 *
 * Uses two in-memory PouchDB instances replicated against each other to
 * reproduce the failure modes the VC redesign was built to fix:
 *
 *   - Lost update under network delay
 *   - Silent conflict loss between causally concurrent edits
 *   - Long-offline return overwriting remote state
 *   - Schema guard refusing to sync legacy (pre-VC) databases
 *
 * These tests assert BEHAVIOR, not implementation: they drive
 * ConflictResolver via the public API against real replicated state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import PouchDB from "pouchdb";
import memoryAdapter from "pouchdb-adapter-memory";
import { ConflictResolver } from "../src/conflict/conflict-resolver.ts";
import { incrementVC, compareVC } from "../src/sync/vector-clock.ts";
import type { FileDoc, CouchSyncDoc, VectorClock } from "../src/types.ts";
import {
    isFileDocId,
    isChunkDocId,
    isConfigDocId,
    isReplicatedDocId,
    makeFileId,
} from "../src/types/doc-id.ts";

PouchDB.plugin(memoryAdapter);

function mkDb(name: string) {
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

async function writeFile(
    db: ReturnType<typeof mkDb>,
    deviceId: string,
    path: string,
    content: string,
): Promise<FileDoc> {
    const docId = makeFileId(path);
    const existing = (await db.getDb().get(docId).catch(() => null)) as FileDoc | null;
    const doc: FileDoc = {
        _id: docId,
        type: "file",
        chunks: [`chunk:${content}`],
        mtime: Date.now(),
        ctime: existing?.ctime ?? Date.now(),
        size: content.length,
        vclock: incrementVC(existing?.vclock, deviceId),
    };
    await db.put(doc);
    return doc;
}

describe("VC integration — two peers over in-memory replication", () => {
    let dbA: ReturnType<typeof mkDb>;
    let dbB: ReturnType<typeof mkDb>;
    const DEVICE_A = "device-A";
    const DEVICE_B = "device-B";

    beforeEach(() => {
        const stamp = `${Date.now()}-${Math.random()}`;
        dbA = mkDb(`vc-int-A-${stamp}`);
        dbB = mkDb(`vc-int-B-${stamp}`);
    });

    afterEach(async () => {
        await dbA.destroy();
        await dbB.destroy();
    });

    it("Scenario Lost-Update: A's delayed write after B replicates becomes concurrent, raises modal", async () => {
        // A writes v1, replicates to B.
        await writeFile(dbA, DEVICE_A, "note.md", "v1");
        await dbA.getDb().replicate.to(dbB.getDb());

        // B writes v2 on top → causally dominates A's v1.
        await writeFile(dbB, DEVICE_B, "note.md", "v2");

        // Meanwhile A, unaware of v2, writes "v3" based on v1 → concurrent.
        await writeFile(dbA, DEVICE_A, "note.md", "v3");

        // Now both sides replicate. PouchDB merges into a conflict tree.
        await dbA.getDb().replicate.to(dbB.getDb());
        await dbB.getDb().replicate.to(dbA.getDb());

        const onConcurrent = vi.fn();
        const resolver = new ConflictResolver(dbA as any);
        resolver.setOnConcurrent(onConcurrent);

        const resolved = await resolver.scanConflicts();
        // No auto-resolution: the writes are concurrent.
        expect(resolved).toBe(0);
        expect(onConcurrent).toHaveBeenCalled();
        expect(onConcurrent.mock.calls[0][0]).toBe("note.md");
    });

    it("Scenario Offline-Return: auto-resolves in favour of the dominator when one side is a strict extension", async () => {
        // A writes initial content and replicates to B.
        await writeFile(dbA, DEVICE_A, "offline.md", "base");
        await dbA.getDb().replicate.to(dbB.getDb());

        // B makes a single edit.
        await writeFile(dbB, DEVICE_B, "offline.md", "b-edit");
        await dbB.getDb().replicate.to(dbA.getDb());

        // A makes 10 edits in sequence — each dominates B's state because
        // A's local clock now includes A's replicated {A:1,B:1} base.
        for (let i = 0; i < 10; i++) {
            await writeFile(dbA, DEVICE_A, "offline.md", `a-edit-${i}`);
        }
        await dbA.getDb().replicate.to(dbB.getDb());
        await dbB.getDb().replicate.to(dbA.getDb());

        const resolver = new ConflictResolver(dbA as any);
        const onConcurrent = vi.fn();
        resolver.setOnConcurrent(onConcurrent);

        await resolver.scanConflicts();
        // A's chain dominates → any conflict auto-resolves without modal.
        expect(onConcurrent).not.toHaveBeenCalled();

        const final = (await dbA.getDb().get(makeFileId("offline.md"))) as unknown as FileDoc;
        expect(final.chunks[0]).toBe("chunk:a-edit-9");
    });

    it("Scenario Mtime-Lies: mtime disagreement with VC must not influence winner", async () => {
        // The hostile case: construct two revisions where mtime LIES.
        // "wrong" has a higher mtime but a dominated vclock.
        // A pre-VC resolver would pick "wrong"; the VC resolver must not.
        const lieId = makeFileId("lie.md");
        await dbA.getDb().put({
            _id: lieId,
            type: "file",
            chunks: ["chunk:right"],
            mtime: 1,
            ctime: 1,
            size: 5,
            vclock: { X: 5 },
        });

        await dbA.getDb().bulkDocs(
            [
                {
                    _id: lieId,
                    type: "file",
                    chunks: ["chunk:wrong"],
                    mtime: 999999,
                    ctime: 1,
                    size: 5,
                    vclock: { X: 3 },
                    _rev: `2-${Math.floor(Math.random() * 1e16).toString(16).padStart(32, "0")}`,
                },
            ],
            { new_edits: false },
        );

        const doc = (await dbA.getDb().get(lieId, { conflicts: true })) as any;
        expect(doc._conflicts?.length).toBeGreaterThan(0);

        const resolver = new ConflictResolver(dbA as any);
        const resolved = await resolver.resolveIfConflicted(doc);
        expect(resolved).toBe(true);

        const final = (await dbA.getDb().get(lieId)) as unknown as FileDoc;
        expect(final.chunks).toEqual(["chunk:right"]);
        expect(final.vclock).toEqual({ X: 5 });
    });

    it("Schema-Guard: bare-path and missing-vclock legacy docs are both detected", async () => {
        // Exercise the probe logic directly. We can't import LocalDB here
        // because its module-level pouchdb-browser import blows up in
        // node (needs `self`), but the probe is tested here as a pure
        // mirror of src/db/local-db.ts#findLegacyFileDoc.
        const db = new PouchDB<any>(
            `vc-int-guard-${Date.now()}-${Math.random()}`,
            { adapter: "memory" },
        );

        // Mirror of LocalDB.findLegacyFileDoc, minus the FileDoc class
        // constraint (plain PouchDB in this test):
        async function findLegacy(): Promise<string | null> {
            const idResult = await db.allDocs({ limit: 200 });
            for (const row of idResult.rows) {
                if (row.id.startsWith("_")) continue;
                if (!isReplicatedDocId(row.id)) return row.id; // bare path
                if (isFileDocId(row.id)) {
                    const doc = (await db.get(row.id)) as any;
                    if (doc.type !== "file") continue;
                    if (!doc.vclock || Object.keys(doc.vclock).length === 0) {
                        return row.id;
                    }
                    return null;
                }
                if (isConfigDocId(row.id)) {
                    const doc = (await db.get(row.id)) as any;
                    if ("binary" in doc) return row.id;
                    return null;
                }
                if (isChunkDocId(row.id)) continue;
            }
            return null;
        }

        // Case 1: a bare-path legacy doc (pre ID-redesign) is detected
        // purely by its missing prefix.
        await db.put({
            _id: "legacy.md",
            type: "file",
            chunks: ["chunk:old"],
            mtime: 1,
            ctime: 1,
            size: 3,
        });
        expect(await findLegacy()).toBe("legacy.md");

        // Case 2: after we remove the bare-path doc and insert a proper
        // file:-prefixed doc WITHOUT vclock, it's still detected.
        await db.remove((await db.get("legacy.md")) as any);
        await db.put({
            _id: makeFileId("no-vc.md"),
            type: "file",
            chunks: ["chunk:old"],
            mtime: 1,
            ctime: 1,
            size: 3,
        });
        expect(await findLegacy()).toBe(makeFileId("no-vc.md"));

        // Case 3: once it has a vclock, it's current.
        const doc = (await db.get(makeFileId("no-vc.md"))) as any;
        doc.vclock = { D: 1 };
        await db.put(doc);
        expect(await findLegacy()).toBeNull();

        await db.destroy();
    });

    it("compareVC sanity: equal vclocks with different chunks is not silently resolved", async () => {
        // Edge case: two revs with identical VCs but different chunks.
        // Causally they're equal → neither dominates → concurrent.
        const doc: FileDoc = {
            _id: makeFileId("edge.md"),
            type: "file",
            chunks: ["chunk:A"],
            mtime: 1,
            ctime: 1,
            size: 1,
            vclock: { X: 1 },
        };
        await dbA.getDb().put(doc);
        await dbA.getDb().bulkDocs(
            [
                {
                    ...doc,
                    chunks: ["chunk:B"],
                    _rev: `2-${Math.floor(Math.random() * 1e16).toString(16).padStart(32, "0")}`,
                } as any,
            ],
            { new_edits: false },
        );
        const current = (await dbA.getDb().get(makeFileId("edge.md"), { conflicts: true })) as any;

        const resolver = new ConflictResolver(dbA as any);
        const onConcurrent = vi.fn();
        resolver.setOnConcurrent(onConcurrent);

        // An equal-VC pair technically has a dominator (either one),
        // because findDominator treats "equal" as acceptable. This is
        // intentional: if two devices independently produced identical
        // clock states with different content, one of them will become
        // the winner and the other will flow through history via the
        // auto-resolved callback. The point of this test is to document
        // that this path is NOT silent — either findDominator picks one
        // (and onAutoResolved fires) or onConcurrent fires.
        const autoSeen: string[] = [];
        resolver.setOnAutoResolved((path) => {
            autoSeen.push(path);
        });
        const resolved = await resolver.resolveIfConflicted(current);
        expect(resolved || onConcurrent.mock.calls.length > 0).toBe(true);
        // At least one of the two paths fired:
        expect(autoSeen.length + onConcurrent.mock.calls.length).toBeGreaterThan(0);
    });

    it("VC chain sanity: incrementVC produces strictly dominating clocks", () => {
        let vc: VectorClock = {};
        for (let i = 0; i < 5; i++) {
            const next = incrementVC(vc, "device-X");
            expect(compareVC(next, vc)).toBe("dominates");
            vc = next;
        }
        expect(vc).toEqual({ "device-X": 5 });
    });
});
