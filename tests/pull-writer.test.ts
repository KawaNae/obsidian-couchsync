import { describe, it, expect, vi } from "vitest";
import { PullWriter } from "../src/db/sync/pull-writer.ts";
import { EchoTracker } from "../src/db/sync/echo-tracker.ts";
import { SyncEvents } from "../src/db/sync/sync-events.ts";
import { Checkpoints } from "../src/db/sync/checkpoints.ts";
import type { ChangesResult } from "../src/db/interfaces.ts";
import type { FileDoc } from "../src/types.ts";

// ── Mock factories (shared with sync-engine.test.ts structure) ──

function makeMockLocalDb(overrides?: any): any {
    const docsMeta: Record<string, any> = {};
    const bulkPut = vi.fn().mockResolvedValue([]);
    const applyTx = async (tx: any) => {
        if (!tx) return;
        if (tx.meta) {
            for (const m of tx.meta) {
                if (m.op === "put") docsMeta[m.key] = m.value;
                else delete docsMeta[m.key];
            }
        }
        if (tx.docs && tx.docs.length > 0) {
            await bulkPut(tx.docs.map((d: any) => d.doc));
        }
        if (tx.onCommit) await tx.onCommit();
    };
    const runWriteTx = vi.fn(async (tx: any) => { await applyTx(tx); });
    const mock: any = {
        bulkPut,
        info: vi.fn().mockResolvedValue({ updateSeq: 5 }),
        get: vi.fn().mockResolvedValue(null),
        getChunks: vi.fn().mockResolvedValue([]),
        runWriteTx,
        getMeta: vi.fn(async (k: string) => docsMeta[k] ?? null),
        ...overrides,
    };
    // Checkpoints uses localDb.getStore().runWriteTx for its saves, but
    // commitPullBatch routes through localDb.runWriteTx — provide a
    // getStore() that delegates back to the same runWriteTx so tests
    // can observe all tx calls via `runWriteTx.mock`.
    mock.getStore = () => ({
        runWriteTx: mock.runWriteTx,
        getMeta: mock.getMeta,
    });
    mock.getMetaStore = () => ({
        runWriteTx: vi.fn().mockResolvedValue(undefined),
        getMeta: vi.fn().mockResolvedValue(null),
    });
    return mock;
}

function makeWriter(
    localDb: any,
    opts: { resolver?: any; ensureChunks?: (doc: FileDoc) => Promise<void> } = {},
): {
    writer: PullWriter;
    echoes: EchoTracker;
    events: SyncEvents;
    checkpoints: Checkpoints;
    metaWrites: any[];
} {
    const echoes = new EchoTracker();
    const events = new SyncEvents();
    const metaWrites: any[] = [];
    const origTx = localDb.runWriteTx;
    localDb.runWriteTx = vi.fn(async (tx: any) => {
        if (tx?.meta) metaWrites.push(...tx.meta);
        return origTx(tx);
    });
    const checkpoints = new Checkpoints(localDb);
    const writer = new PullWriter({
        localDb,
        events,
        echoes,
        checkpoints,
        getConflictResolver: () => opts.resolver,
        ensureChunks: opts.ensureChunks ?? (async () => {}),
    });
    return { writer, echoes, events, checkpoints, metaWrites };
}

// ── Tests ─────────────────────────────────────────────────

describe("PullWriter vclock guard", () => {
    it("take-remote: writes doc when resolver verdict is take-remote", async () => {
        const localDb = makeMockLocalDb({
            get: vi.fn().mockResolvedValue({
                _id: "file:test.md", type: "file", chunks: [], vclock: { A: 1 },
                mtime: 1, ctime: 1, size: 0,
            }),
        });
        const resolver = { resolveOnPull: vi.fn().mockResolvedValue("take-remote") };
        const { writer } = makeWriter(localDb, { resolver });

        const result: ChangesResult<any> = {
            results: [
                { id: "file:test.md", seq: "1", doc: {
                    _id: "file:test.md", _rev: "2-abc", type: "file",
                    chunks: [], vclock: { A: 2 }, mtime: 2, ctime: 1, size: 0,
                }},
            ],
            last_seq: "1",
        };
        await writer.apply(result);

        expect(localDb.bulkPut).toHaveBeenCalled();
        const written = localDb.bulkPut.mock.calls[0][0];
        expect(written).toHaveLength(1);
        expect(written[0]._id).toBe("file:test.md");
    });

    it("keep-local: skips doc when resolver verdict is keep-local", async () => {
        const localDb = makeMockLocalDb({
            get: vi.fn().mockResolvedValue({
                _id: "file:test.md", type: "file", chunks: [], vclock: { A: 5 },
                mtime: 5, ctime: 1, size: 0,
            }),
        });
        const resolver = { resolveOnPull: vi.fn().mockResolvedValue("keep-local") };
        const { writer } = makeWriter(localDb, { resolver });

        const result: ChangesResult<any> = {
            results: [
                { id: "file:test.md", seq: "1", doc: {
                    _id: "file:test.md", _rev: "2-abc", type: "file",
                    chunks: [], vclock: { B: 3 }, mtime: 3, ctime: 1, size: 0,
                }},
            ],
            last_seq: "1",
        };
        await writer.apply(result);

        expect(localDb.bulkPut).not.toHaveBeenCalled();
    });

    it("concurrent: skips doc and fires concurrent event", async () => {
        const localDb = makeMockLocalDb({
            get: vi.fn().mockResolvedValue({
                _id: "file:test.md", type: "file", chunks: [], vclock: { A: 2 },
                mtime: 2, ctime: 1, size: 0,
            }),
        });
        const resolver = { resolveOnPull: vi.fn().mockResolvedValue("concurrent") };
        const { writer, events } = makeWriter(localDb, { resolver });

        const fired: string[] = [];
        events.on("concurrent", ({ filePath }) => fired.push(filePath));

        const result: ChangesResult<any> = {
            results: [
                { id: "file:test.md", seq: "1", doc: {
                    _id: "file:test.md", _rev: "2-abc", type: "file",
                    chunks: [], vclock: { B: 1 }, mtime: 1, ctime: 1, size: 0,
                }},
            ],
            last_seq: "1",
        };
        await writer.apply(result);

        expect(localDb.bulkPut).not.toHaveBeenCalled();
        expect(fired).toContain("test.md");
    });

    it("chunk docs bypass the vclock guard (no resolver call)", async () => {
        const localDb = makeMockLocalDb();
        const resolver = { resolveOnPull: vi.fn() };
        const { writer } = makeWriter(localDb, { resolver });

        const result: ChangesResult<any> = {
            results: [
                { id: "chunk:abc123", seq: "1", doc: {
                    _id: "chunk:abc123", _rev: "1-xyz", type: "chunk", data: "base64...",
                }},
            ],
            last_seq: "1",
        };
        await writer.apply(result);

        expect(localDb.bulkPut).toHaveBeenCalled();
        expect(resolver.resolveOnPull).not.toHaveBeenCalled();
    });

    it("new doc (no local version): accepted without resolver call", async () => {
        const localDb = makeMockLocalDb({ get: vi.fn().mockResolvedValue(null) });
        const resolver = { resolveOnPull: vi.fn() };
        const { writer } = makeWriter(localDb, { resolver });

        const result: ChangesResult<any> = {
            results: [
                { id: "file:new.md", seq: "1", doc: {
                    _id: "file:new.md", _rev: "1-abc", type: "file",
                    chunks: [], vclock: { B: 1 }, mtime: 1, ctime: 1, size: 0,
                }},
            ],
            last_seq: "1",
        };
        await writer.apply(result);

        expect(localDb.bulkPut).toHaveBeenCalled();
        expect(resolver.resolveOnPull).not.toHaveBeenCalled();
    });
});

describe("PullWriter atomic commit", () => {
    it("bundles accepted docs and META_REMOTE_SEQ in a single runWriteTx call", async () => {
        const localDb = makeMockLocalDb();
        const { writer } = makeWriter(localDb);

        const result: ChangesResult<any> = {
            results: [
                { id: "chunk:a", seq: "1", doc: { _id: "chunk:a", type: "chunk", data: "x" } },
            ],
            last_seq: "7",
        };
        await writer.apply(result);

        expect(localDb.runWriteTx).toHaveBeenCalledTimes(1);
        const tx = localDb.runWriteTx.mock.calls[0][0];
        expect(tx.docs).toHaveLength(1);
        expect(tx.meta).toEqual([{ op: "put", key: "_sync/remote-seq", value: "7" }]);
    });

    it("runWriteTx failure → no echo record, propagates error", async () => {
        const localDb = makeMockLocalDb();
        localDb.runWriteTx = vi.fn().mockRejectedValue(new Error("quota"));
        const { writer, echoes } = makeWriter(localDb);

        const result: ChangesResult<any> = {
            results: [
                { id: "chunk:a", seq: "1", doc: { _id: "chunk:a", type: "chunk", data: "x" } },
            ],
            last_seq: "3",
        };

        await expect(writer.apply(result)).rejects.toThrow("quota");
        // Echo record is set in onCommit, which only fires inside a
        // successful tx — a failed tx must not leak an echo entry.
        expect(echoes.sizePullWritten()).toBe(0);
    });

    it("empty batch: returns empty=true with no runWriteTx call", async () => {
        const localDb = makeMockLocalDb();
        const { writer } = makeWriter(localDb);

        const result: ChangesResult<any> = { results: [], last_seq: "9" };
        const applied = await writer.apply(result);

        expect(applied.empty).toBe(true);
        expect(applied.nextRemoteSeq).toBe("9");
        expect(localDb.runWriteTx).not.toHaveBeenCalled();
    });
});

describe("PullWriter onCommit side effects", () => {
    it("records pull-write echoes only after the tx commits", async () => {
        const localDb = makeMockLocalDb({
            info: vi.fn().mockResolvedValue({ updateSeq: 42 }),
        });
        const { writer, echoes } = makeWriter(localDb);

        const result: ChangesResult<any> = {
            results: [
                { id: "chunk:a", seq: "1", doc: { _id: "chunk:a", type: "chunk", data: "x" } },
            ],
            last_seq: "1",
        };
        await writer.apply(result);

        expect(echoes.isPullEcho("chunk:a", 42)).toBe(true);
        expect(echoes.isPullEcho("chunk:a", 43)).toBe(false);
    });

    it("consumes push echo before writing (skips the echo doc entirely)", async () => {
        const localDb = makeMockLocalDb();
        const { writer, echoes } = makeWriter(localDb);
        echoes.recordPushEcho("chunk:echo");

        const result: ChangesResult<any> = {
            results: [
                { id: "chunk:echo", seq: "1", doc: { _id: "chunk:echo", type: "chunk", data: "x" } },
            ],
            last_seq: "1",
        };
        await writer.apply(result);

        expect(localDb.bulkPut).not.toHaveBeenCalled();
        expect(echoes.consumePushEcho("chunk:echo")).toBe(false);
    });

    it("fires pull-write for accepted FileDocs and emits auto-resolve", async () => {
        const localDb = makeMockLocalDb({ get: vi.fn().mockResolvedValue(null) });
        const { writer, events } = makeWriter(localDb);

        const pullWrites: FileDoc[] = [];
        events.onAsync("pull-write", async ({ doc }) => { pullWrites.push(doc); });
        const autoResolved: string[] = [];
        events.on("auto-resolve", ({ filePath }) => autoResolved.push(filePath));

        const result: ChangesResult<any> = {
            results: [
                { id: "file:a.md", seq: "1", doc: {
                    _id: "file:a.md", _rev: "1-x", type: "file",
                    chunks: [], vclock: { A: 1 }, mtime: 1, ctime: 1, size: 0,
                }},
            ],
            last_seq: "1",
        };
        await writer.apply(result);

        expect(pullWrites).toHaveLength(1);
        expect(pullWrites[0]._id).toBe("file:a.md");
        expect(autoResolved).toEqual(["a.md"]);
    });
});

describe("PullWriter deletion handling", () => {
    it("fires pull-delete query for file doc tombstones", async () => {
        const localDb = makeMockLocalDb({
            get: vi.fn().mockResolvedValue({
                _id: "file:deleted.md", type: "file",
                chunks: [], vclock: { A: 1 }, mtime: 1, ctime: 1, size: 0,
            }),
        });
        const { writer, events } = makeWriter(localDb);

        const query = vi.fn().mockResolvedValue(false);
        events.onQuery("pull-delete", query);

        const result: ChangesResult<any> = {
            results: [
                { id: "file:deleted.md", seq: "3", deleted: true },
            ],
            last_seq: "3",
        };
        await writer.apply(result);

        expect(query).toHaveBeenCalledWith(expect.objectContaining({
            path: "deleted.md",
            localDoc: expect.objectContaining({ _id: "file:deleted.md" }),
        }));
    });

    it("skips chunk doc tombstones (never fires pull-delete)", async () => {
        const localDb = makeMockLocalDb();
        const { writer, events } = makeWriter(localDb);

        const query = vi.fn().mockResolvedValue(false);
        events.onQuery("pull-delete", query);

        const result: ChangesResult<any> = {
            results: [
                { id: "chunk:abc123", seq: "3", deleted: true },
            ],
            last_seq: "3",
        };
        await writer.apply(result);

        expect(query).not.toHaveBeenCalled();
    });

    it("skips already-deleted local docs", async () => {
        const localDb = makeMockLocalDb({
            get: vi.fn().mockResolvedValue({
                _id: "file:gone.md", type: "file", deleted: true,
                chunks: [], vclock: { A: 1 }, mtime: 1, ctime: 1, size: 0,
            }),
        });
        const { writer, events } = makeWriter(localDb);

        const query = vi.fn().mockResolvedValue(false);
        events.onQuery("pull-delete", query);

        const result: ChangesResult<any> = {
            results: [
                { id: "file:gone.md", seq: "3", deleted: true },
            ],
            last_seq: "3",
        };
        await writer.apply(result);

        expect(query).not.toHaveBeenCalled();
    });

    it("query returning true → emits concurrent with a tombstone remoteDoc", async () => {
        const localDb = makeMockLocalDb({
            get: vi.fn().mockResolvedValue({
                _id: "file:edited.md", type: "file",
                chunks: ["chunk:c1"], vclock: { A: 2 }, mtime: 2, ctime: 1, size: 10,
            }),
        });
        const { writer, events } = makeWriter(localDb);

        events.onQuery("pull-delete", async () => true); // unpushed edits
        const concurrent = vi.fn();
        events.on("concurrent", concurrent);

        const result: ChangesResult<any> = {
            results: [
                { id: "file:edited.md", seq: "3", deleted: true },
            ],
            last_seq: "3",
        };
        await writer.apply(result);

        expect(concurrent).toHaveBeenCalledWith(expect.objectContaining({
            filePath: "edited.md",
            remoteDoc: expect.objectContaining({ deleted: true }),
        }));
    });
});
