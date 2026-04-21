/**
 * Unit tests for analyzeChunkConsistency + collectReferencedChunks.
 *
 * Uses a real LocalDB (fake-indexeddb) and FakeCouchClient to exercise
 * the streaming sort-merge against both stores. Every assertion targets
 * observable outputs (bucket membership, counts, ordering) — not how
 * the code gets there.
 */

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LocalDB } from "../src/db/local-db.ts";
import { FakeCouchClient } from "./helpers/fake-couch-client.ts";
import {
    analyzeChunkConsistency,
    diffFileDocs,
    hasDivergence,
    type ChunkConsistencyReport,
} from "../src/sync/chunk-consistency.ts";
import { collectReferencedChunks } from "../src/db/chunk-refs.ts";
import type { FileDoc, ChunkDoc, CouchSyncDoc } from "../src/types.ts";
import { makeFileId, makeChunkId } from "../src/types/doc-id.ts";

// ── Fixtures ─────────────────────────────────────────────

function makeFile(
    path: string,
    chunkIds: string[],
    opts: { deleted?: boolean } = {},
): FileDoc {
    return {
        _id: makeFileId(path),
        type: "file",
        chunks: chunkIds,
        mtime: 1000,
        ctime: 1000,
        size: 100,
        deleted: opts.deleted,
        vclock: { A: 1 },
    };
}

function makeChunk(hash: string): ChunkDoc {
    return {
        _id: makeChunkId(hash),
        type: "chunk",
        data: "ZGF0YQ==",
    };
}

async function putLocal(db: LocalDB, doc: CouchSyncDoc): Promise<void> {
    await db.runWriteTx({ docs: [{ doc }] });
}

async function putRemote(
    remote: FakeCouchClient,
    doc: CouchSyncDoc,
): Promise<void> {
    await remote.bulkDocs([doc]);
}

// ── Harness ──────────────────────────────────────────────

let counter = 0;

async function mkFresh(): Promise<{ db: LocalDB; remote: FakeCouchClient }> {
    const db = new LocalDB(`chunk-consistency-${Date.now()}-${counter++}`);
    db.open();
    const remote = new FakeCouchClient();
    return { db, remote };
}

async function runWithDefaults(
    db: LocalDB,
    remote: FakeCouchClient,
    extra: Partial<Parameters<typeof analyzeChunkConsistency>[0]> = {},
): Promise<ChunkConsistencyReport> {
    const result = await analyzeChunkConsistency({ localDb: db, remote, ...extra });
    if (result.state !== "converged") {
        throw new Error(
            `expected converged, got needs-convergence: ${JSON.stringify(result.divergence)}`,
        );
    }
    return result.report;
}

// ── collectReferencedChunks unit ─────────────────────────

describe("collectReferencedChunks", () => {
    it("skips deleted FileDocs entirely", () => {
        const alive = makeFile("alive.md", [makeChunkId("a")]);
        const dead = makeFile("dead.md", [makeChunkId("b")], { deleted: true });
        const refs = collectReferencedChunks([alive, dead]);
        expect([...refs.keys()].sort()).toEqual([makeChunkId("a")]);
    });

    it("accumulates referencedBy paths across multiple files", () => {
        const f1 = makeFile("one.md", [makeChunkId("x")]);
        const f2 = makeFile("two.md", [makeChunkId("x")]);
        const refs = collectReferencedChunks([f1, f2]);
        expect(refs.get(makeChunkId("x"))?.sort()).toEqual(["one.md", "two.md"]);
    });

    it("empty input yields empty map", () => {
        expect(collectReferencedChunks([]).size).toBe(0);
    });
});

// ── diffFileDocs unit ────────────────────────────────────

describe("diffFileDocs", () => {
    it("empty on both sides is not a divergence", () => {
        const d = diffFileDocs([], []);
        expect(d).toEqual({ localOnly: [], remoteOnly: [], differing: [] });
        expect(hasDivergence(d)).toBe(false);
    });

    it("id in local only → localOnly", () => {
        const a = makeFile("a.md", []);
        const d = diffFileDocs([a], []);
        expect(d.localOnly).toEqual([a._id]);
        expect(d.remoteOnly).toEqual([]);
        expect(hasDivergence(d)).toBe(true);
    });

    it("id in remote only → remoteOnly", () => {
        const a = makeFile("a.md", []);
        const d = diffFileDocs([], [a]);
        expect(d.remoteOnly).toEqual([a._id]);
        expect(d.localOnly).toEqual([]);
        expect(hasDivergence(d)).toBe(true);
    });

    it("equal vclock → no divergence", () => {
        const a = makeFile("a.md", []); // vclock { A: 1 }
        const d = diffFileDocs([a], [a]);
        expect(hasDivergence(d)).toBe(false);
    });

    it("dominated: local older, remote newer", () => {
        const base = makeFile("a.md", []);
        const local: FileDoc = { ...base, vclock: { A: 1 } };
        const remote: FileDoc = { ...base, vclock: { A: 2 } };
        const d = diffFileDocs([local], [remote]);
        expect(d.differing).toHaveLength(1);
        expect(d.differing[0].relation).toBe("dominated");
    });

    it("dominates: local newer, remote older", () => {
        const base = makeFile("a.md", []);
        const local: FileDoc = { ...base, vclock: { A: 3 } };
        const remote: FileDoc = { ...base, vclock: { A: 1 } };
        const d = diffFileDocs([local], [remote]);
        expect(d.differing[0].relation).toBe("dominates");
    });

    it("concurrent: forks on different devices", () => {
        const base = makeFile("a.md", []);
        const local: FileDoc = { ...base, vclock: { A: 2, B: 1 } };
        const remote: FileDoc = { ...base, vclock: { A: 1, B: 2 } };
        const d = diffFileDocs([local], [remote]);
        expect(d.differing[0].relation).toBe("concurrent");
    });

    it("output is sorted by id", () => {
        const z = makeFile("z.md", []);
        const a = makeFile("a.md", []);
        const d = diffFileDocs([z, a], []);
        expect(d.localOnly).toEqual([a._id, z._id]);
    });
});

// ── analyzeChunkConsistency ──────────────────────────────

describe("analyzeChunkConsistency", () => {
    let db: LocalDB;
    let remote: FakeCouchClient;

    beforeEach(async () => {
        ({ db, remote } = await mkFresh());
    });

    afterEach(async () => {
        await db.destroy();
        await remote.destroy();
    });

    it("empty: both stores zero → every bucket empty", async () => {
        const report = await runWithDefaults(db, remote);
        expect(report.counts).toEqual({
            localChunks: 0,
            remoteChunks: 0,
            referencedIds: 0,
            localOnly: 0,
            remoteOnly: 0,
            missingReferenced: 0,
            orphanLocal: 0,
            orphanRemote: 0,
        });
        expect(report.localOnly).toEqual([]);
        expect(report.remoteOnly).toEqual([]);
        expect(report.missingReferenced).toEqual([]);
    });

    it("aligned: 3 shared chunks, 1 file references 2 → one orphan on each side", async () => {
        const c1 = makeChunk("aaa");
        const c2 = makeChunk("bbb");
        const c3 = makeChunk("ccc");
        const f = makeFile("note.md", [c1._id, c2._id]);

        for (const d of [c1, c2, c3, f]) {
            await putLocal(db, d);
            await putRemote(remote, d);
        }

        const r = await runWithDefaults(db, remote);
        expect(r.counts.localOnly).toBe(0);
        expect(r.counts.remoteOnly).toBe(0);
        expect(r.counts.missingReferenced).toBe(0);
        expect(r.counts.orphanLocal).toBe(1);
        expect(r.counts.orphanRemote).toBe(1);
        expect(r.orphanLocal).toEqual([c3._id]);
        expect(r.orphanRemote).toEqual([c3._id]);
    });

    it("local only: chunk missing from remote is bucketed", async () => {
        const c = makeChunk("only-here");
        await putLocal(db, c);
        // Include a FileDoc to avoid the chunk looking orphan'd.
        const f = makeFile("a.md", [c._id]);
        await putLocal(db, f);
        await putRemote(remote, f);

        const r = await runWithDefaults(db, remote);
        expect(r.localOnly).toEqual([c._id]);
        expect(r.remoteOnly).toEqual([]);
        expect(r.counts.missingReferenced).toBe(0);
        expect(r.orphanLocal).toEqual([]);
    });

    it("remote only: chunk missing from local is bucketed (mirror)", async () => {
        const c = makeChunk("only-there");
        await putRemote(remote, c);
        const f = makeFile("a.md", [c._id]);
        await putLocal(db, f);
        await putRemote(remote, f);

        const r = await runWithDefaults(db, remote);
        expect(r.remoteOnly).toEqual([c._id]);
        expect(r.localOnly).toEqual([]);
        expect(r.orphanRemote).toEqual([]);
    });

    it("missing referenced (both sides): FileDoc references a chunk absent everywhere", async () => {
        const ghost = makeChunkId("ghost");
        const f = makeFile("broken.md", [ghost]);
        await putLocal(db, f);
        await putRemote(remote, f);

        const r = await runWithDefaults(db, remote);
        expect(r.counts.missingReferenced).toBe(1);
        expect(r.missingReferenced[0].id).toBe(ghost);
        expect(r.missingReferenced[0].referencedBy).toEqual(["broken.md"]);
    });

    it("missing referenced (one side only): chunk present remotely → NOT missingReferenced", async () => {
        // Classic drift-in-flight: chunk landed remote but not yet local.
        // This is recoverable by normal pull, not a broken file.
        const c = makeChunk("half");
        const f = makeFile("a.md", [c._id]);
        await putRemote(remote, c);
        await putRemote(remote, f);
        await putLocal(db, f); // local has FileDoc but not the chunk

        const r = await runWithDefaults(db, remote);
        expect(r.counts.missingReferenced).toBe(0);
        expect(r.counts.remoteOnly).toBe(1);
        expect(r.remoteOnly).toEqual([c._id]);
    });

    it("deleted FileDoc: its chunks count as unreferenced → orphan, not missingReferenced", async () => {
        const c = makeChunk("ghost-ref");
        const deletedFile = makeFile("d.md", [c._id], { deleted: true });
        await putLocal(db, c);
        await putLocal(db, deletedFile);
        await putRemote(remote, c);
        await putRemote(remote, deletedFile);

        const r = await runWithDefaults(db, remote);
        expect(r.counts.missingReferenced).toBe(0);
        expect(r.orphanLocal).toEqual([c._id]);
        expect(r.orphanRemote).toEqual([c._id]);
    });

    it("FileDoc present on only one side → needs-convergence, chunks not enumerated", async () => {
        // Classic lagging-device situation: local has a FileDoc that
        // hasn't pushed yet (or hasn't pulled from remote). Producing a
        // report from this state would mis-classify the chunks — by
        // design the analyser refuses and returns needs-convergence so
        // the caller can let sync catch up first.
        const c = makeChunk("shared");
        const fLocalOnly = makeFile("only-here.md", [c._id]);
        await putLocal(db, c);
        await putLocal(db, fLocalOnly);
        await putRemote(remote, c);

        const result = await analyzeChunkConsistency({ localDb: db, remote });
        expect(result.state).toBe("needs-convergence");
        if (result.state === "needs-convergence") {
            expect(result.divergence.localOnly).toEqual([fLocalOnly._id]);
            expect(result.divergence.remoteOnly).toEqual([]);
            expect(result.divergence.differing).toEqual([]);
        }
    });

    it("FileDoc vclock differs → needs-convergence with `differing` populated", async () => {
        const f = makeFile("note.md", []);
        const older: FileDoc = { ...f, vclock: { A: 1 } };
        const newer: FileDoc = { ...f, vclock: { A: 2 } };
        await putLocal(db, older);
        await putRemote(remote, newer);

        const result = await analyzeChunkConsistency({ localDb: db, remote });
        expect(result.state).toBe("needs-convergence");
        if (result.state === "needs-convergence") {
            expect(result.divergence.differing).toHaveLength(1);
            expect(result.divergence.differing[0].id).toBe(f._id);
            expect(result.divergence.differing[0].relation).toBe("dominated");
            expect(result.divergence.localOnly).toEqual([]);
            expect(result.divergence.remoteOnly).toEqual([]);
        }
    });

    it("concurrent vclock on the same FileDoc is flagged as `concurrent`", async () => {
        const f = makeFile("c.md", []);
        const localFork: FileDoc = { ...f, vclock: { A: 2, B: 1 } };
        const remoteFork: FileDoc = { ...f, vclock: { A: 1, B: 2 } };
        await putLocal(db, localFork);
        await putRemote(remote, remoteFork);

        const result = await analyzeChunkConsistency({ localDb: db, remote });
        expect(result.state).toBe("needs-convergence");
        if (result.state === "needs-convergence") {
            expect(result.divergence.differing[0].relation).toBe("concurrent");
        }
    });

    it("pagination: pageSize=2 with 7 chunks walks the full range", async () => {
        const chunks = ["a", "b", "c", "d", "e", "f", "g"].map(makeChunk);
        for (const c of chunks) {
            await putLocal(db, c);
            await putRemote(remote, c);
        }
        // Reference half so some become orphan.
        const f = makeFile(
            "note.md",
            chunks.slice(0, 3).map((c) => c._id),
        );
        await putLocal(db, f);
        await putRemote(remote, f);

        const r = await runWithDefaults(db, remote, { pageSize: 2 });
        expect(r.counts.localChunks).toBe(7);
        expect(r.counts.remoteChunks).toBe(7);
        expect(r.orphanLocal.length).toBe(4);
        expect(r.orphanLocal).toEqual(
            chunks.slice(3).map((c) => c._id).sort(),
        );
    });

    it("abort: pre-flight signal aborts immediately with AbortError", async () => {
        const ac = new AbortController();
        ac.abort();
        await expect(
            analyzeChunkConsistency({ localDb: db, remote, signal: ac.signal }),
        ).rejects.toMatchObject({ name: "AbortError" });
    });

    it("determinism: output arrays are in lex ascending order", async () => {
        // Insert in reverse lex order so that only sorting can produce
        // the expected output.
        const ids = ["z", "y", "x", "w"].map(makeChunk);
        for (const c of ids) await putLocal(db, c);
        // Skip remote entirely so everything is localOnly + orphanLocal.

        const r = await runWithDefaults(db, remote);
        const lexSorted = [...r.localOnly].sort();
        expect(r.localOnly).toEqual(lexSorted);
        expect(r.orphanLocal).toEqual(lexSorted);
    });

    it("snapshotChanged: flipped to true when remote update_seq advances mid-scan", async () => {
        // Seed some state so the scan actually runs.
        const c = makeChunk("base");
        await putLocal(db, c);
        await putRemote(remote, c);

        const originalAllDocs = remote.allDocs.bind(remote);
        let injected = false;
        // Monkey-patch one allDocs call to mutate the remote after it runs.
        (remote as any).allDocs = async (opts: any) => {
            const result = await originalAllDocs(opts);
            if (!injected) {
                injected = true;
                await remote.bulkDocs([makeChunk("late-arrival")]);
            }
            return result;
        };

        const r = await runWithDefaults(db, remote);
        expect(r.snapshotChanged).toBe(true);
    });
});
