/**
 * Regression: chunk-repair ping-pong in a multi-device setting.
 *
 * Prior behaviour (v0.20.0): `analyzeChunkConsistency` merged local
 * and remote FileDoc sets picking the local side unconditionally. A
 * lagging device holding an older FileDoc would see its chunks as
 * "referenced" and `localOnly`, and the repair command would push
 * them back — undoing the up-to-date device's earlier tombstone. Two
 * devices would then bounce the chunks back and forth.
 *
 * Under convergence gating the analyser refuses to produce a report
 * when the two sides disagree on any FileDoc (by id or vclock); the
 * lagging device instead receives `needs-convergence` and the repair
 * path is architecturally unavailable until sync catches up.
 */

import "fake-indexeddb/auto";
import { describe, it, expect, afterEach } from "vitest";
import { LocalDB } from "../../src/db/local-db.ts";
import { FakeCouchClient } from "../helpers/fake-couch-client.ts";
import {
    analyzeChunkConsistency,
} from "../../src/sync/chunk-consistency.ts";
import {
    planFromReport,
    repairChunkDrift,
} from "../../src/sync/chunk-repair.ts";
import { makeFileId, makeChunkId } from "../../src/types/doc-id.ts";
import type {
    FileDoc,
    ChunkDoc,
    CouchSyncDoc,
    VectorClock,
} from "../../src/types.ts";

let counter = 0;

function chunk(hash: string): ChunkDoc {
    return {
        _id: makeChunkId(hash),
        type: "chunk",
        data: "ZGF0YQ==",
    };
}

function file(
    path: string,
    chunkIds: string[],
    vclock: VectorClock,
): FileDoc {
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

async function putLocal(db: LocalDB, docs: CouchSyncDoc[]): Promise<void> {
    await db.runWriteTx({
        docs: docs.filter((d) => d.type !== "chunk").map((d) => ({ doc: d })),
        chunks: docs.filter((d) => d.type === "chunk") as ChunkDoc[],
    });
}

describe("Regression: chunk-repair ping-pong across two devices", () => {
    const cleanups: Array<() => Promise<void>> = [];

    function mkDb(label: string): LocalDB {
        const db = new LocalDB(`integ-pingpong-${label}-${Date.now()}-${counter++}`);
        db.open();
        cleanups.push(async () => { await db.destroy(); });
        return db;
    }

    function mkRemote(): FakeCouchClient {
        const remote = new FakeCouchClient();
        cleanups.push(async () => { await remote.destroy(); });
        return remote;
    }

    afterEach(async () => {
        for (const fn of cleanups.splice(0)) await fn();
    });

    /**
     * Seed layout:
     *
     *   up-to-date-side   ── FileDoc v2 (chunks D,E) + A,B,C,D,E
     *   remote            ── FileDoc v2 (chunks D,E) + A,B,C,D,E
     *   lagging-side      ── FileDoc v1 (chunks A,B,C) + A,B,C
     *
     * i.e. the up-to-date device and the remote have already caught up;
     * the lagging device holds an older FileDoc that still references
     * the now-unreferenced chunks.
     */
    async function seedPingPongWorld(): Promise<{
        remote: FakeCouchClient;
        uptoDate: LocalDB;
        lagging: LocalDB;
        oldChunks: ChunkDoc[];
        newChunks: ChunkDoc[];
        oldFile: FileDoc;
        newFile: FileDoc;
    }> {
        const remote = mkRemote();
        const uptoDate = mkDb("uptodate");
        const lagging = mkDb("lagging");

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

        await remote.bulkDocs([newFile, A, B, C, D, E]);
        await putLocal(uptoDate, [newFile, A, B, C, D, E]);
        await putLocal(lagging, [oldFile, A, B, C]);

        return {
            remote,
            uptoDate,
            lagging,
            oldChunks: [A, B, C],
            newChunks: [D, E],
            oldFile,
            newFile,
        };
    }

    it("lagging device: analyse returns needs-convergence with dominated relation", async () => {
        const world = await seedPingPongWorld();

        const result = await analyzeChunkConsistency({
            localDb: world.lagging,
            remote: world.remote,
        });

        expect(result.state).toBe("needs-convergence");
        if (result.state === "needs-convergence") {
            expect(result.divergence.differing).toHaveLength(1);
            expect(result.divergence.differing[0].id).toBe(world.newFile._id);
            expect(result.divergence.differing[0].relation).toBe("dominated");
            expect(result.divergence.localOnly).toEqual([]);
            expect(result.divergence.remoteOnly).toEqual([]);
        }
    });

    it("up-to-date device: analyse is converged and orphanRemote lists the stale chunks", async () => {
        const world = await seedPingPongWorld();

        const result = await analyzeChunkConsistency({
            localDb: world.uptoDate,
            remote: world.remote,
        });

        expect(result.state).toBe("converged");
        if (result.state !== "converged") return;
        const oldIds = world.oldChunks.map((c) => c._id).sort();
        expect([...result.report.orphanLocal].sort()).toEqual(oldIds);
        expect([...result.report.orphanRemote].sort()).toEqual(oldIds);
    });

    it("no ping-pong: after up-to-date side tombstones, lagging side still sees needs-convergence until pulled", async () => {
        const world = await seedPingPongWorld();

        // Up-to-date side repairs — tombstones old chunks on remote,
        // deletes them locally. This is the step that, under the old
        // design, would race with the lagging device's repair.
        const desktopResult = await analyzeChunkConsistency({
            localDb: world.uptoDate,
            remote: world.remote,
        });
        if (desktopResult.state !== "converged") {
            throw new Error("precondition: desktop must be converged");
        }
        const plan = planFromReport(desktopResult.report);
        await repairChunkDrift(plan, {
            localDb: world.uptoDate,
            remote: world.remote,
        });

        // Lagging device now has remote with only {newFile, D, E}, and
        // still locally holds the old FileDoc + A,B,C. The old design
        // would have classified A/B/C as referenced-but-localOnly and
        // offered to push them — re-creating the very state the
        // up-to-date device just cleaned up. The new design refuses:
        const laggingResult = await analyzeChunkConsistency({
            localDb: world.lagging,
            remote: world.remote,
        });
        expect(laggingResult.state).toBe("needs-convergence");
        if (laggingResult.state === "needs-convergence") {
            expect(laggingResult.divergence.differing).toHaveLength(1);
            expect(laggingResult.divergence.differing[0].relation).toBe(
                "dominated",
            );
        }
    });

    it("after lagging device pulls the newer FileDoc, it becomes converged with local-only stale chunks", async () => {
        const world = await seedPingPongWorld();

        // Simulate the lagging device catching up: overwrite its old
        // FileDoc with the remote's newer copy. (pullAll in production
        // does the same via runWriteTx replaying remote docs.)
        await putLocal(world.lagging, [world.newFile, ...world.newChunks]);

        const laggingResult = await analyzeChunkConsistency({
            localDb: world.lagging,
            remote: world.remote,
        });

        expect(laggingResult.state).toBe("converged");
        if (laggingResult.state !== "converged") return;
        const oldIds = world.oldChunks.map((c) => c._id).sort();
        // Stale chunks still present locally, remote has them too — both
        // sides list them as orphan. The *remote* orphans may match what
        // the up-to-date device would have seen, which is the normal
        // recovery path: either device can now safely repair.
        expect([...laggingResult.report.orphanLocal].sort()).toEqual(oldIds);
        expect([...laggingResult.report.orphanRemote].sort()).toEqual(oldIds);
    });
});
