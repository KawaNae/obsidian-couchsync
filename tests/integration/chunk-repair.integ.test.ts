/**
 * Integration: chunk-repair against a real LocalDB + FakeCouchClient.
 *
 * Seeds drift via the same channels the production code uses, runs the
 * repair end-to-end via `analyzeChunkConsistency` → `planFromReport` →
 * `repairChunkDrift`, and verifies the post-repair report is clean.
 *
 * Complements `chunk-repair.test.ts` (unit-level) by exercising the
 * full pipeline: report → plan → execute → re-analyze.
 */

import "fake-indexeddb/auto";
import { describe, it, expect, afterEach } from "vitest";
import { LocalDB } from "../../src/db/local-db.ts";
import { FakeCouchClient } from "../helpers/fake-couch-client.ts";
import { analyzeChunkConsistency } from "../../src/sync/chunk-consistency.ts";
import {
    planFromReport,
    repairChunkDrift,
} from "../../src/sync/chunk-repair.ts";
import { makeFileId, makeChunkId } from "../../src/types/doc-id.ts";
import type { FileDoc, ChunkDoc, CouchSyncDoc } from "../../src/types.ts";

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

describe("Integration: chunk-repair", () => {
    const cleanups: Array<() => Promise<void>> = [];

    function mkDevice(label: string): { db: LocalDB; remote: FakeCouchClient } {
        const db = new LocalDB(`integ-chunk-repair-${label}-${Date.now()}-${counter++}`);
        db.open();
        const remote = new FakeCouchClient();
        cleanups.push(async () => { await db.destroy(); });
        cleanups.push(async () => { await remote.destroy(); });
        return { db, remote };
    }

    afterEach(async () => {
        for (const fn of cleanups.splice(0)) await fn();
    });

    it("heals a localOnly chunk: push to remote closes the gap", async () => {
        const { db, remote } = mkDevice("push");

        const c = chunk("drift-push");
        const f = file("a.md", [c._id]);
        // Local has FileDoc + chunk, remote only has the FileDoc.
        await putLocal(db, [c, f]);
        await remote.bulkDocs([f]);

        const before = await analyzeChunkConsistency({ localDb: db, remote });
        expect(before.localOnly).toEqual([c._id]);

        const result = await repairChunkDrift(
            planFromReport(before),
            { localDb: db, remote },
        );
        expect(result.pushed).toBe(1);
        expect(result.failed).toEqual([]);

        const after = await analyzeChunkConsistency({ localDb: db, remote });
        expect(after.counts.localOnly).toBe(0);
        expect(after.counts.remoteOnly).toBe(0);
        expect(after.counts.missingReferenced).toBe(0);
    });

    it("heals a remoteOnly chunk: pull from remote closes the gap", async () => {
        const { db, remote } = mkDevice("pull");

        const c = chunk("drift-pull");
        const f = file("b.md", [c._id]);
        // Remote has FileDoc + chunk, local only has the FileDoc.
        await putLocal(db, [f]);
        await remote.bulkDocs([c, f]);

        const before = await analyzeChunkConsistency({ localDb: db, remote });
        expect(before.remoteOnly).toEqual([c._id]);

        const result = await repairChunkDrift(
            planFromReport(before),
            { localDb: db, remote },
        );
        expect(result.pulled).toBe(1);

        const after = await analyzeChunkConsistency({ localDb: db, remote });
        expect(after.counts.localOnly).toBe(0);
        expect(after.counts.remoteOnly).toBe(0);
    });

    it("heals bidirectional drift in a single run", async () => {
        const { db, remote } = mkDevice("both");

        const lc = chunk("local-drift");
        const rc = chunk("remote-drift");
        const fLocal = file("l.md", [lc._id]);
        const fRemote = file("r.md", [rc._id]);
        // Both sides have both FileDocs (so references are known everywhere),
        // but each side is missing exactly one of the chunks.
        await putLocal(db, [lc, fLocal, fRemote]);
        await remote.bulkDocs([rc, fLocal, fRemote]);

        const before = await analyzeChunkConsistency({ localDb: db, remote });
        expect(before.localOnly).toEqual([lc._id]);
        expect(before.remoteOnly).toEqual([rc._id]);

        const result = await repairChunkDrift(
            planFromReport(before),
            { localDb: db, remote },
        );
        expect(result.pushed).toBe(1);
        expect(result.pulled).toBe(1);
        expect(result.failed).toEqual([]);

        const after = await analyzeChunkConsistency({ localDb: db, remote });
        expect(after.counts.localOnly).toBe(0);
        expect(after.counts.remoteOnly).toBe(0);
    });

    it("deletes one-sided orphans from the side they live on", async () => {
        const { db, remote } = mkDevice("one-sided-orphans");

        const kept = chunk("kept");
        const localOrphan = chunk("loc-only-orphan");
        const remoteOrphan = chunk("rem-only-orphan");
        const ghost = makeChunkId("ghost");
        const healthy = file("h.md", [kept._id]);
        const broken = file("b.md", [ghost]);

        await putLocal(db, [kept, localOrphan, healthy, broken]);
        await remote.bulkDocs([kept, remoteOrphan, healthy, broken]);

        const before = await analyzeChunkConsistency({ localDb: db, remote });
        expect(before.orphanLocal).toEqual([localOrphan._id]);
        expect(before.orphanRemote).toEqual([remoteOrphan._id]);

        const result = await repairChunkDrift(
            planFromReport(before),
            { localDb: db, remote },
        );
        // One-sided orphans are deleted from their side (neither copy
        // nor a no-op). This is where the repair complements GC.
        expect(result.deletedLocal).toBe(1);
        expect(result.deletedRemote).toBe(1);
        expect(result.pushed).toBe(0);
        expect(result.pulled).toBe(0);

        const after = await analyzeChunkConsistency({ localDb: db, remote });
        // Both one-sided orphans are gone. missingReferenced (ghost)
        // remains — it's unrecoverable and out of scope.
        expect(after.counts.orphanLocal).toBe(0);
        expect(after.counts.orphanRemote).toBe(0);
        expect(after.counts.localOnly).toBe(0);
        expect(after.counts.remoteOnly).toBe(0);
        expect(after.counts.missingReferenced).toBe(1);
        expect(after.missingReferenced[0].id).toBe(ghost);
    });

    it("only cleans one-sided orphans; two-sided orphans are GC's job", async () => {
        const { db, remote } = mkDevice("two-sided");

        const bothSidesOrphan = chunk("both-orphan");
        // Seed the same unreferenced chunk on both sides, with no file
        // referencing it. The report will list it in orphanLocal AND
        // orphanRemote, but NOT in localOnly / remoteOnly.
        await putLocal(db, [bothSidesOrphan]);
        await remote.bulkDocs([bothSidesOrphan]);

        const before = await analyzeChunkConsistency({ localDb: db, remote });
        expect(before.localOnly).toEqual([]);
        expect(before.remoteOnly).toEqual([]);
        expect(before.orphanLocal).toEqual([bothSidesOrphan._id]);
        expect(before.orphanRemote).toEqual([bothSidesOrphan._id]);

        const result = await repairChunkDrift(
            planFromReport(before),
            { localDb: db, remote },
        );
        expect(result.deletedLocal).toBe(0);
        expect(result.deletedRemote).toBe(0);

        const after = await analyzeChunkConsistency({ localDb: db, remote });
        // Untouched — GC will eventually handle it.
        expect(after.orphanLocal).toEqual([bothSidesOrphan._id]);
        expect(after.orphanRemote).toEqual([bothSidesOrphan._id]);
    });

    it("empty drift → repair is a no-op and report stays clean", async () => {
        const { db, remote } = mkDevice("noop");

        const c = chunk("kept");
        const f = file("a.md", [c._id]);
        await putLocal(db, [c, f]);
        await remote.bulkDocs([c, f]);

        const before = await analyzeChunkConsistency({ localDb: db, remote });
        const result = await repairChunkDrift(
            planFromReport(before),
            { localDb: db, remote },
        );
        expect(result.pushed).toBe(0);
        expect(result.pulled).toBe(0);

        const after = await analyzeChunkConsistency({ localDb: db, remote });
        expect(after.counts.localOnly).toBe(0);
        expect(after.counts.remoteOnly).toBe(0);
    });
});
