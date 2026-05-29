/**
 * E2E: the ping-pong scenario that v0.20.1 fixed, exercised against a real
 * CouchDB. The integration test (regression-chunk-repair-pingpong.integ)
 * covers the analyzer at the fake-client level; this guards CouchDB-specific
 * quirks (rev threading, _all_docs id enumeration over attachment-backed
 * chunks, tombstone shape).
 *
 * Modernised to the v0.25.x schema: chunks carry `content: Uint8Array` +
 * `schemaVersion` and are seeded onto the remote as real binary ATTACHMENTS
 * (bulkDocsWithAttachments), not inline JSON — matching how the live push
 * pipeline stores them, so the analyzer enumerates the same shape it sees in
 * production.
 *
 * Scenario (mirrors the integration test):
 *   - remote (CouchDB)    — FileDoc v2 (chunks D,E) + chunks A..E
 *   - device "up-to-date" — same as remote
 *   - device "lagging"    — old FileDoc v1 (chunks A,B,C) + chunks A,B,C
 *
 * Assertions: lagging side's analyze → needs-convergence; up-to-date side's
 * analyze → converged with A,B,C orphaned on both sides.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createE2EHarness, stripLocalRevs, type E2EHarness } from "./couch-harness.ts";
import { analyzeChunkConsistency } from "../../src/sync/chunk-consistency.ts";
import { buildChunkAttachment } from "../../src/db/chunk-attachment.ts";
import { makeChunkId, makeFileId } from "../../src/types/doc-id.ts";
import {
    CHUNK_SCHEMA_VERSION,
    FILE_SCHEMA_VERSION,
    type ChunkDoc,
    type CouchSyncDoc,
    type FileDoc,
    type VectorClock,
} from "../../src/types.ts";

const enc = new TextEncoder();

function chunk(letter: string): ChunkDoc {
    return {
        _id: makeChunkId(letter),
        type: "chunk",
        schemaVersion: CHUNK_SCHEMA_VERSION,
        content: enc.encode(`chunk-${letter}`),
    };
}

function file(path: string, chunkIds: string[], vclock: VectorClock): FileDoc {
    return {
        _id: makeFileId(path),
        type: "file",
        schemaVersion: FILE_SCHEMA_VERSION,
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

        const oldFile = file("note.md", [A._id, B._id, C._id], { uptodate: 1 });
        const newFile = file("note.md", [D._id, E._id], { uptodate: 2 });

        // 1. Seed remote: chunks as real binary attachments + the latest FileDoc.
        await uptoDate.client.bulkDocsWithAttachments(
            [A, B, C, D, E].map((c) => buildChunkAttachment(c, { keepRev: false })),
        );
        await uptoDate.client.bulkDocs(
            stripLocalRevs([newFile] as Array<FileDoc & { _rev?: string }>) as CouchSyncDoc[],
        );

        // 2. Up-to-date device mirrors remote locally (content present).
        await uptoDate.db.runWriteTx({ docs: [{ doc: newFile }], chunks: [A, B, C, D, E] });

        // 3. Lagging device holds the older FileDoc + the old chunks only.
        await lagging.db.runWriteTx({ docs: [{ doc: oldFile }], chunks: [A, B, C] });

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

        // 5. Up-to-date device: analyzer converges; A,B,C orphan on both sides.
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
