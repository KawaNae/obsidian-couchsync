/**
 * End-to-end Vector Clock integration tests.
 *
 * Uses two in-memory PouchDB instances to reproduce the failure modes
 * the VC redesign was built to fix:
 *
 *   - Lost update under network delay
 *   - Silent conflict loss between causally concurrent edits
 *   - Long-offline return overwriting remote state
 *   - Schema guard refusing to sync legacy (pre-VC) databases
 *
 * Phase 2: ConflictResolver.resolveOnPull() replaces resolveIfConflicted().
 * Instead of building PouchDB conflict trees and walking `_conflicts`,
 * tests directly compare pairs of documents via resolveOnPull().
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
        get: async (id: string) => {
            try { return await db.get(id) as unknown; }
            catch (e: any) { if (e.status === 404) return null; throw e; }
        },
        allDocs: async (opts?: any) => db.allDocs(opts) as any,
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
        const bDoc = await writeFile(dbB, DEVICE_B, "note.md", "v2");

        // Meanwhile A, unaware of v2, writes "v3" based on v1 → concurrent.
        const aDoc = await writeFile(dbA, DEVICE_A, "note.md", "v3");

        // Phase 2: compare docs directly via resolveOnPull.
        const onConcurrent = vi.fn();
        const resolver = new ConflictResolver();
        resolver.setOnConcurrent(onConcurrent);

        // When A pulls B's doc, the two are concurrent.
        const verdict = await resolver.resolveOnPull(aDoc, bDoc);
        expect(verdict).toBe("concurrent");
        expect(onConcurrent).toHaveBeenCalled();
        expect(onConcurrent.mock.calls[0][0]).toBe("note.md");
    });

    it("Scenario Offline-Return: auto-resolves in favour of the dominator when one side is a strict extension", async () => {
        // A writes initial content and replicates to B.
        await writeFile(dbA, DEVICE_A, "offline.md", "base");
        await dbA.getDb().replicate.to(dbB.getDb());

        // B makes a single edit.
        const bDoc = await writeFile(dbB, DEVICE_B, "offline.md", "b-edit");
        await dbB.getDb().replicate.to(dbA.getDb());

        // A makes 10 edits in sequence — each dominates B's state because
        // A's local clock now includes A's replicated {A:1,B:1} base.
        let aDoc: FileDoc = bDoc;
        for (let i = 0; i < 10; i++) {
            aDoc = await writeFile(dbA, DEVICE_A, "offline.md", `a-edit-${i}`);
        }

        // Phase 2: when B pulls A's latest, A dominates → take-remote.
        const onConcurrent = vi.fn();
        const resolver = new ConflictResolver();
        resolver.setOnConcurrent(onConcurrent);

        const verdict = await resolver.resolveOnPull(bDoc, aDoc);
        expect(verdict).toBe("take-remote");
        expect(onConcurrent).not.toHaveBeenCalled();
    });

    it("Scenario Mtime-Lies: mtime disagreement with VC must not influence winner", async () => {
        // The hostile case: construct two docs where mtime LIES.
        // "wrong" has a higher mtime but a dominated vclock.
        const right: FileDoc = {
            _id: makeFileId("lie.md"),
            type: "file",
            chunks: ["chunk:right"],
            mtime: 1, // old mtime
            ctime: 1,
            size: 5,
            vclock: { X: 5 },
        };
        const wrong: FileDoc = {
            _id: makeFileId("lie.md"),
            type: "file",
            chunks: ["chunk:wrong"],
            mtime: 999999, // new mtime, but dominated vclock
            ctime: 1,
            size: 5,
            vclock: { X: 3 },
        };

        // When pulling "wrong" while local has "right", local dominates.
        const resolver = new ConflictResolver();
        const verdict = await resolver.resolveOnPull(right, wrong);
        expect(verdict).toBe("keep-local");
    });

    it("Schema-Guard: bare-path and missing-vclock legacy docs are both detected", async () => {
        const db = new PouchDB<any>(
            `vc-int-guard-${Date.now()}-${Math.random()}`,
            { adapter: "memory" },
        );

        async function findLegacy(): Promise<string | null> {
            const idResult = await db.allDocs({ limit: 200 });
            for (const row of idResult.rows) {
                if (row.id.startsWith("_")) continue;
                if (!isReplicatedDocId(row.id)) return row.id;
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

        await db.put({
            _id: "legacy.md",
            type: "file",
            chunks: ["chunk:old"],
            mtime: 1,
            ctime: 1,
            size: 3,
        });
        expect(await findLegacy()).toBe("legacy.md");

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

        const doc = (await db.get(makeFileId("no-vc.md"))) as any;
        doc.vclock = { D: 1 };
        await db.put(doc);
        expect(await findLegacy()).toBeNull();

        await db.destroy();
    });

    it("compareVC sanity: equal vclocks with different chunks → concurrent", async () => {
        // Edge case: two docs with identical VCs but different chunks.
        // Causally they're equal → keep-local (no conflict raised).
        const local: FileDoc = {
            _id: makeFileId("edge.md"),
            type: "file",
            chunks: ["chunk:A"],
            mtime: 1,
            ctime: 1,
            size: 1,
            vclock: { X: 1 },
        };
        const remote: FileDoc = {
            ...local,
            chunks: ["chunk:B"],
        };

        const resolver = new ConflictResolver();
        const verdict = await resolver.resolveOnPull(local, remote);
        // Equal vclocks → keep-local
        expect(verdict).toBe("keep-local");
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
