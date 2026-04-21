/**
 * E2E: the ping-pong scenario that v0.20.1 fixed, now exercised against
 * a real CouchDB instead of FakeCouchClient.
 *
 * The integration-level regression (tests/integration/regression-chunk-
 * repair-pingpong.integ.test.ts) already covers the invariant at the
 * analyzer level. This file guards against any CouchDB-specific quirk
 * (rev threading, tombstones, conflict shape) that the fake client
 * doesn't reproduce. It also serves as the seed for a wider 2-device
 * E2E suite.
 *
 * Setup mirrors the integration test:
 *   - remote (CouchDB)  — FileDoc v2 (chunks D,E) + A,B,C,D,E
 *   - device "up-to-date" — same as remote
 *   - device "lagging"    — old FileDoc v1 (chunks A,B,C) + A,B,C
 *
 * Assertions: lagging side's analyze returns `needs-convergence`;
 * up-to-date side's analyze is `converged` with orphan chunks A,B,C.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createE2EHarness, stripLocalRevs, type E2EHarness } from "./couch-harness.ts";
import { analyzeChunkConsistency } from "../../src/sync/chunk-consistency.ts";
import { makeChunkId, makeFileId } from "../../src/types/doc-id.ts";
import type { ChunkDoc, CouchSyncDoc, FileDoc, VectorClock } from "../../src/types.ts";

function chunk(hash: string): ChunkDoc {
    return {
        _id: makeChunkId(hash),
        type: "chunk",
        data: "ZGF0YQ==", // base64("data")
    };
}

function file(path: string, chunkIds: string[], vclock: VectorClock): FileDoc {
    return {
        _id: makeFileId(path),
        type: "file",
        chunks: chunkIds,
        mtime: 1000,
        ctime: 1000,
        size: 100,
        vclock,
    };
}

describe("E2E multi-device: chunk-repair ping-pong (real CouchDB)", () => {
    let h: E2EHarness;

    beforeEach(async () => {
        h = await createE2EHarness({ uniqueDb: true });
    });

    afterEach(async () => {
        if (h) await h.destroyAll();
    });

    it("lagging device sees needs-convergence; up-to-date device sees converged orphans", async () => {
        const uptoDate = h.addDevice("uptodate");
        const lagging = h.addDevice("lagging");

        const A = chunk("A");
        const B = chunk("B");
        const C = chunk("C");
        const D = chunk("D");
        const E = chunk("E");

        const oldFile = file(
            "note.md",
            [A._id, B._id, C._id],
            { uptodate: 1 },
        );
        const newFile = file(
            "note.md",
            [D._id, E._id],
            { uptodate: 2 },
        );

        // 1. Seed remote CouchDB with the latest state.
        await uptoDate.client.bulkDocs(
            stripLocalRevs([newFile, A, B, C, D, E] as unknown as Array<
                CouchSyncDoc & { _rev?: string }
            >),
        );

        // 2. Up-to-date device mirrors remote locally.
        await uptoDate.db.runWriteTx({
            docs: [{ doc: newFile }],
            chunks: [A, B, C, D, E],
        });

        // 3. Lagging device holds the older FileDoc + the old chunks only.
        await lagging.db.runWriteTx({
            docs: [{ doc: oldFile }],
            chunks: [A, B, C],
        });

        // 4. Lagging device: analyzer refuses — returns needs-convergence.
        const laggingResult = await analyzeChunkConsistency({
            localDb: lagging.db,
            remote: lagging.client,
        });
        expect(laggingResult.state).toBe("needs-convergence");
        if (laggingResult.state === "needs-convergence") {
            expect(laggingResult.divergence.differing).toHaveLength(1);
            expect(laggingResult.divergence.differing[0].id).toBe(newFile._id);
            expect(laggingResult.divergence.differing[0].relation).toBe("dominated");
            expect(laggingResult.divergence.localOnly).toEqual([]);
            expect(laggingResult.divergence.remoteOnly).toEqual([]);
        }

        // 5. Up-to-date device: analyzer converges; old chunks A/B/C are
        // orphan on both sides and can be safely repaired.
        const uptoDateResult = await analyzeChunkConsistency({
            localDb: uptoDate.db,
            remote: uptoDate.client,
        });
        expect(uptoDateResult.state).toBe("converged");
        if (uptoDateResult.state !== "converged") return;
        const oldIds = [A._id, B._id, C._id].sort();
        expect([...uptoDateResult.report.orphanLocal].sort()).toEqual(oldIds);
        expect([...uptoDateResult.report.orphanRemote].sort()).toEqual(oldIds);
    });
});
