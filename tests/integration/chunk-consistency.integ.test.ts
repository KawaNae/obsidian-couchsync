/**
 * Integration: analyzeChunkConsistency against a real LocalDB + FakeCouchClient.
 *
 * Seeds each scenario through the same channels the production code
 * uses (runWriteTx for local, bulkDocs for remote) and asserts the
 * five buckets end-to-end. Complements the unit tests by exercising
 * realistic interleaving rather than single-scenario isolation.
 */

import "fake-indexeddb/auto";
import { describe, it, expect, afterEach } from "vitest";
import { LocalDB } from "../../src/db/local-db.ts";
import { FakeCouchClient } from "../helpers/fake-couch-client.ts";
import {
    analyzeChunkConsistency,
    type ChunkConsistencyReport,
    type ChunkConsistencyDeps,
} from "../../src/sync/chunk-consistency.ts";
import { makeFileId, makeChunkId } from "../../src/types/doc-id.ts";
import type { FileDoc, ChunkDoc, CouchSyncDoc } from "../../src/types.ts";

async function analyzeConverged(
    deps: ChunkConsistencyDeps,
): Promise<ChunkConsistencyReport> {
    const result = await analyzeChunkConsistency(deps);
    if (result.state !== "converged") {
        throw new Error(
            `expected converged, got needs-convergence: ${JSON.stringify(result.divergence)}`,
        );
    }
    return result.report;
}

let counter = 0;

function file(path: string, chunkIds: string[]): FileDoc {
    return {
        _id: makeFileId(path),
        type: "file",
        chunks: chunkIds,
        mtime: 1000,
        ctime: 1000,
        size: 100,
        vclock: { A: 1 },
    };
}

function chunk(hash: string): ChunkDoc {
    return {
        _id: makeChunkId(hash),
        type: "chunk",
        data: "ZGF0YQ==",
    };
}

async function putLocal(db: LocalDB, docs: CouchSyncDoc[]): Promise<void> {
    await db.runWriteTx({
        docs: docs.filter((d) => d.type !== "chunk").map((d) => ({ doc: d })),
        chunks: docs.filter((d) => d.type === "chunk") as ChunkDoc[],
    });
}

describe("Integration: analyzeChunkConsistency", () => {
    const cleanups: Array<() => Promise<void>> = [];

    function mkDevice(label: string): { db: LocalDB; remote: FakeCouchClient } {
        const db = new LocalDB(`integ-chunk-cons-${label}-${Date.now()}-${counter++}`);
        db.open();
        const remote = new FakeCouchClient();
        cleanups.push(async () => { await db.destroy(); });
        cleanups.push(async () => { await remote.destroy(); });
        return { db, remote };
    }

    afterEach(async () => {
        for (const fn of cleanups.splice(0)) await fn();
    });

    it("in-sync 3-file vault → no discrepancies, orphan buckets empty", async () => {
        const { db, remote } = mkDevice("sync");

        const c1 = chunk("alpha");
        const c2 = chunk("beta");
        const c3 = chunk("gamma");
        const f1 = file("one.md", [c1._id, c2._id]);
        const f2 = file("two.md", [c2._id, c3._id]);
        const f3 = file("three.md", [c3._id]);

        await putLocal(db, [c1, c2, c3, f1, f2, f3]);
        await remote.bulkDocs([c1, c2, c3, f1, f2, f3]);

        const r = await analyzeConverged({ localDb: db, remote });
        expect(r.counts.localOnly).toBe(0);
        expect(r.counts.remoteOnly).toBe(0);
        expect(r.counts.missingReferenced).toBe(0);
        expect(r.counts.orphanLocal).toBe(0);
        expect(r.counts.orphanRemote).toBe(0);
        expect(r.snapshotChanged).toBe(false);
    });

    it("orphan injection on both sides is detected independently", async () => {
        const { db, remote } = mkDevice("orphan");

        const real = chunk("real");
        const f = file("a.md", [real._id]);
        await putLocal(db, [real, f]);
        await remote.bulkDocs([real, f]);

        // Inject orphans directly into each store.
        const localOrphan = chunk("local-only-orphan");
        await putLocal(db, [localOrphan]);

        const remoteOrphan = chunk("remote-only-orphan");
        await remote.bulkDocs([remoteOrphan]);

        const r = await analyzeConverged({ localDb: db, remote });

        expect(r.localOnly).toEqual([localOrphan._id]);
        expect(r.remoteOnly).toEqual([remoteOrphan._id]);
        expect(r.orphanLocal).toEqual([localOrphan._id]);
        expect(r.orphanRemote).toEqual([remoteOrphan._id]);
        expect(r.counts.missingReferenced).toBe(0);
    });

    it("broken file: FileDoc references a chunk absent from both sides", async () => {
        const { db, remote } = mkDevice("broken");

        const ghost = makeChunkId("ghost");
        const realChunk = chunk("kept");
        // Healthy file keeps one chunk alive on both sides.
        const okFile = file("ok.md", [realChunk._id]);
        // Broken file references a chunk that was never written.
        const brokenFile = file("broken.md", [ghost]);

        await putLocal(db, [realChunk, okFile, brokenFile]);
        await remote.bulkDocs([realChunk, okFile, brokenFile]);

        const r = await analyzeConverged({ localDb: db, remote });
        expect(r.counts.missingReferenced).toBe(1);
        expect(r.missingReferenced[0].id).toBe(ghost);
        expect(r.missingReferenced[0].referencedBy).toEqual(["broken.md"]);
        // Real chunk still healthy on both sides.
        expect(r.counts.localOnly).toBe(0);
        expect(r.counts.remoteOnly).toBe(0);
    });

    it("all three scenarios together: orphans + broken + drift all coexist", async () => {
        const { db, remote } = mkDevice("all");

        const kept = chunk("kept");
        const localOrphan = chunk("loc-only");
        const remoteOrphan = chunk("rem-only");
        const drifted = chunk("drift");
        const ghost = makeChunkId("ghost");

        const healthyFile = file("h.md", [kept._id]);
        const brokenFile = file("b.md", [ghost]);
        const driftFile = file("d.md", [drifted._id]);

        await putLocal(db, [kept, localOrphan, healthyFile, brokenFile, driftFile]);
        await remote.bulkDocs([kept, remoteOrphan, drifted, healthyFile, brokenFile, driftFile]);

        const r = await analyzeConverged({ localDb: db, remote });

        // kept  — both sides, referenced
        // localOrphan — local only, unreferenced
        // remoteOrphan — remote only, unreferenced
        // drifted — remote only, referenced (normal drift, not broken)
        // ghost — missingReferenced

        expect(r.localOnly).toEqual([localOrphan._id]);
        expect(r.remoteOnly.sort()).toEqual([drifted._id, remoteOrphan._id].sort());
        expect(r.orphanLocal).toEqual([localOrphan._id]);
        expect(r.orphanRemote).toEqual([remoteOrphan._id]);
        expect(r.missingReferenced).toHaveLength(1);
        expect(r.missingReferenced[0].id).toBe(ghost);
    });
});
