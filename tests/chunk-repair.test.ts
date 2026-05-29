/**
 * Unit tests for chunk-repair — the write-side counterpart of
 * analyzeChunkConsistency. Uses a real LocalDB (fake-indexeddb) and
 * FakeCouchClient for symmetry with chunk-consistency.test.ts.
 *
 * The repair module is a four-quadrant orchestrator on top of
 * `pushDocs` / `pullDocs` / local runWriteTx / `deleteRemoteDocs`;
 * these tests cover plan derivation (referenced × membership and
 * unreferenced × membership), direction dispatch, empty/mixed inputs,
 * and best-effort error collection.
 */

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LocalDB } from "../src/db/local-db.ts";
import { FakeCouchClient } from "./helpers/fake-couch-client.ts";
import {
    planFromReport,
    planIsEmpty,
    repairChunkDrift,
} from "../src/sync/chunk-repair.ts";
import type { ChunkConsistencyReport } from "../src/sync/chunk-consistency.ts";
import type { ChunkDoc, CouchSyncDoc } from "../src/types.ts";
import { makeChunkId } from "../src/types/doc-id.ts";
import { buildChunkAttachment } from "../src/db/chunk-attachment.ts";

/** Seed a chunk on the remote the way production does — content in the
 *  `c` attachment, not the doc body. Repair-pull reconstructs content
 *  from this attachment (v2), so a body-only seed would pull an empty
 *  chunk. */
async function seedRemoteChunk(remote: FakeCouchClient, chunk: ChunkDoc): Promise<void> {
    await remote.bulkDocsWithAttachments([buildChunkAttachment(chunk)]);
}

function emptyReport(overrides: Partial<ChunkConsistencyReport> = {}): ChunkConsistencyReport {
    return {
        generatedAt: 0,
        localUpdateSeq: 0,
        remoteUpdateSeq: 0,
        snapshotChanged: false,
        counts: {
            localChunks: 0,
            remoteChunks: 0,
            referencedIds: 0,
            localOnly: 0,
            remoteOnly: 0,
            missingReferenced: 0,
            orphanLocal: 0,
            orphanRemote: 0,
        },
        localOnly: [],
        remoteOnly: [],
        missingReferenced: [],
        orphanLocal: [],
        orphanRemote: [],
        ...overrides,
    };
}

function makeChunk(hash: string): ChunkDoc {
    return {
        _id: makeChunkId(hash),
        type: "chunk",
        schemaVersion: 2,
        content: new TextEncoder().encode("data"),
    };
}

async function putLocal(db: LocalDB, doc: CouchSyncDoc): Promise<void> {
    await db.runWriteTx({ docs: [{ doc }] });
}

let counter = 0;
async function mkFresh(): Promise<{ db: LocalDB; remote: FakeCouchClient }> {
    const db = new LocalDB(`chunk-repair-${Date.now()}-${counter++}`);
    db.open();
    const remote = new FakeCouchClient();
    return { db, remote };
}

describe("planFromReport", () => {
    it("separates referenced drift (push/pull) from unreferenced (delete)", () => {
        const refL = makeChunkId("ref-local");
        const refR = makeChunkId("ref-remote");
        const orphL = makeChunkId("orph-local");
        const orphR = makeChunkId("orph-remote");
        const missing = makeChunkId("missing");
        const report = emptyReport({
            localOnly: [refL, orphL],
            remoteOnly: [refR, orphR],
            orphanLocal: [orphL],
            orphanRemote: [orphR],
            missingReferenced: [{ id: missing, referencedBy: ["x.md"] }],
        });
        const plan = planFromReport(report);
        expect(plan.toPush).toEqual([refL]);
        expect(plan.toPull).toEqual([refR]);
        expect(plan.toDeleteLocal).toEqual([orphL]);
        expect(plan.toDeleteRemote).toEqual([orphR]);
    });

    it("empty report → empty plan", () => {
        const plan = planFromReport(emptyReport());
        expect(plan).toEqual({
            toPush: [],
            toPull: [],
            toDeleteLocal: [],
            toDeleteRemote: [],
        });
        expect(planIsEmpty(plan)).toBe(true);
    });

    // Invariant II (G2): broken chunks (missingReferenced) are owned by the
    // reconciler's quarantine path, NOT by repair — they can't be pushed,
    // pulled, or deleted into existence. The plan must exclude them entirely
    // (no silent delete-shortcut that would risk data another device holds).
    it("missingReferenced (broken) → excluded from every repair action", () => {
        const broken = makeChunkId("broken-everywhere");
        const plan = planFromReport(emptyReport({
            missingReferenced: [{ id: broken, referencedBy: ["broken-note.md"] }],
        }));
        expect(plan.toPush).not.toContain(broken);
        expect(plan.toPull).not.toContain(broken);
        expect(plan.toDeleteLocal).not.toContain(broken);
        expect(plan.toDeleteRemote).not.toContain(broken);
        expect(planIsEmpty(plan)).toBe(true);
    });

    it("two-sided orphans (present on both, unreferenced) stay with GC", () => {
        // Such chunks are in orphanLocal + orphanRemote but NOT in
        // localOnly / remoteOnly — so plan excludes them entirely.
        const bothSidesOrphan = makeChunkId("both");
        const report = emptyReport({
            orphanLocal: [bothSidesOrphan],
            orphanRemote: [bothSidesOrphan],
        });
        const plan = planFromReport(report);
        expect(planIsEmpty(plan)).toBe(true);
    });
});

describe("repairChunkDrift", () => {
    let db: LocalDB;
    let remote: FakeCouchClient;

    beforeEach(async () => {
        ({ db, remote } = await mkFresh());
    });

    afterEach(async () => {
        await db.destroy();
        await remote.destroy();
    });

    it("pushes referenced localOnly → remote", async () => {
        const chunk = makeChunk("push");
        await putLocal(db, chunk);

        const result = await repairChunkDrift(
            { toPush: [chunk._id], toPull: [], toDeleteLocal: [], toDeleteRemote: [] },
            { localDb: db, remote },
        );
        expect(result.pushed).toBe(1);
        expect(await remote.getDoc(chunk._id)).not.toBeNull();
    });

    it("pulls referenced remoteOnly → local", async () => {
        const chunk = makeChunk("pull");
        await seedRemoteChunk(remote, chunk);

        const result = await repairChunkDrift(
            { toPush: [], toPull: [chunk._id], toDeleteLocal: [], toDeleteRemote: [] },
            { localDb: db, remote },
        );
        expect(result.pulled).toBe(1);
        expect(await db.get(chunk._id)).not.toBeNull();
    });

    it("deletes unreferenced localOnly chunks from local", async () => {
        const chunk = makeChunk("orphan-local");
        await putLocal(db, chunk);
        expect(await db.get(chunk._id)).not.toBeNull();

        const result = await repairChunkDrift(
            { toPush: [], toPull: [], toDeleteLocal: [chunk._id], toDeleteRemote: [] },
            { localDb: db, remote },
        );
        expect(result.deletedLocal).toBe(1);
        expect(await db.get(chunk._id)).toBeNull();
    });

    it("tombstones unreferenced remoteOnly chunks on remote", async () => {
        const chunk = makeChunk("orphan-remote");
        await seedRemoteChunk(remote, chunk);

        const result = await repairChunkDrift(
            { toPush: [], toPull: [], toDeleteLocal: [], toDeleteRemote: [chunk._id] },
            { localDb: db, remote },
        );
        expect(result.deletedRemote).toBe(1);
        // Post-delete the chunk is gone from live allDocs results.
        const rows = (
            await remote.allDocs<any>({
                keys: [chunk._id],
                include_docs: true,
            })
        ).rows;
        expect(rows[0]?.value?.deleted ?? true).toBe(true);
    });

    it("runs all four quadrants in one call", async () => {
        const pushC = makeChunk("q-push");
        const pullC = makeChunk("q-pull");
        const delL = makeChunk("q-del-local");
        const delR = makeChunk("q-del-remote");
        await putLocal(db, pushC);
        await putLocal(db, delL);
        await seedRemoteChunk(remote, pullC);
        await remote.bulkDocs([delR]);

        const result = await repairChunkDrift(
            {
                toPush: [pushC._id],
                toPull: [pullC._id],
                toDeleteLocal: [delL._id],
                toDeleteRemote: [delR._id],
            },
            { localDb: db, remote },
        );
        expect(result.pushed).toBe(1);
        expect(result.pulled).toBe(1);
        expect(result.deletedLocal).toBe(1);
        expect(result.deletedRemote).toBe(1);
        expect(result.failed).toEqual([]);

        expect(await remote.getDoc(pushC._id)).not.toBeNull();
        expect(await db.get(pullC._id)).not.toBeNull();
        expect(await db.get(delL._id)).toBeNull();
    });

    it("empty plan → zero counts, no ops", async () => {
        const result = await repairChunkDrift(
            { toPush: [], toPull: [], toDeleteLocal: [], toDeleteRemote: [] },
            { localDb: db, remote },
        );
        expect(result).toMatchObject({
            pushed: 0,
            pulled: 0,
            deletedLocal: 0,
            deletedRemote: 0,
            failed: [],
        });
    });

    it("emits progress events for every direction in use", async () => {
        const pushC = makeChunk("p-push");
        const pullC = makeChunk("p-pull");
        const delL = makeChunk("p-del-local");
        const delR = makeChunk("p-del-remote");
        await putLocal(db, pushC);
        await putLocal(db, delL);
        await seedRemoteChunk(remote, pullC);
        await remote.bulkDocs([delR]);

        const phases = new Set<string>();
        await repairChunkDrift(
            {
                toPush: [pushC._id],
                toPull: [pullC._id],
                toDeleteLocal: [delL._id],
                toDeleteRemote: [delR._id],
            },
            {
                localDb: db,
                remote,
                onProgress: (phase) => phases.add(phase),
            },
        );
        expect(phases).toEqual(
            new Set(["push", "pull", "delete-local", "delete-remote"]),
        );
    });

    it("collects push failures into failed[] and continues other phases", async () => {
        const pushC = makeChunk("will-fail");
        const pullC = makeChunk("ok-pull");
        await putLocal(db, pushC);
        await seedRemoteChunk(remote, pullC);

        // v2: chunk push routes through bulkDocsWithAttachments. Mock
        // both endpoints to fail on push paths so the test still
        // exercises the failure-collection branch regardless of which
        // codec path the chunk actually takes.
        const originalBulkDocs = remote.bulkDocs.bind(remote);
        const originalBulkAtt = remote.bulkDocsWithAttachments.bind(remote);
        remote.bulkDocs = async (docs: any[]) => {
            if (docs.some((d) => !d._deleted)) throw new Error("boom");
            return originalBulkDocs(docs);
        };
        remote.bulkDocsWithAttachments = async () => {
            throw new Error("boom");
        };

        const result = await repairChunkDrift(
            {
                toPush: [pushC._id],
                toPull: [pullC._id],
                toDeleteLocal: [],
                toDeleteRemote: [],
            },
            { localDb: db, remote },
        );
        expect(result.pushed).toBe(0);
        expect(result.pulled).toBe(1);
        expect(result.failed.length).toBeGreaterThan(0);
        expect(result.failed[0].direction).toBe("push");

        remote.bulkDocs = originalBulkDocs;
        remote.bulkDocsWithAttachments = originalBulkAtt;
    });

    it("records elapsedMs", async () => {
        const result = await repairChunkDrift(
            { toPush: [], toPull: [], toDeleteLocal: [], toDeleteRemote: [] },
            { localDb: db, remote },
        );
        expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    });
});
