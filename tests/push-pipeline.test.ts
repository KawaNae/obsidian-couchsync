import { describe, it, expect, vi } from "vitest";
import { PushPipeline } from "../src/db/sync/push-pipeline.ts";
import { EchoTracker } from "../src/db/sync/echo-tracker.ts";
import { SyncEvents } from "../src/db/sync/sync-events.ts";
import { Checkpoints } from "../src/db/sync/checkpoints.ts";
import { DbError } from "../src/db/write-transaction.ts";
import type { ICouchClient } from "../src/db/interfaces.ts";

// ── Mock factories ───────────────────────────────────────

function makeMockClient(overrides?: Partial<ICouchClient>): ICouchClient {
    return {
        info: vi.fn().mockResolvedValue({ db_name: "test", doc_count: 0, update_seq: "0" }),
        getDoc: vi.fn().mockResolvedValue(null),
        bulkGet: vi.fn().mockResolvedValue([]),
        bulkDocs: vi.fn().mockResolvedValue([]),
        allDocs: vi.fn().mockResolvedValue({ rows: [], total_rows: 0 }),
        changes: vi.fn().mockResolvedValue({ results: [], last_seq: "0" }),
        changesLongpoll: vi.fn().mockImplementation(() => new Promise(() => {})),
        destroy: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function makePipeline(
    client: ICouchClient,
    opts: { localDb?: any; cancelAfter?: number } = {},
) {
    const echoes = new EchoTracker();
    const events = new SyncEvents();
    const baseLocalDb = opts.localDb ?? {
        changes: vi.fn().mockResolvedValue({ results: [], last_seq: 0 }),
    };
    // Checkpoints expects getStore()/getMetaStore(); stub them for tests
    // that don't provide a real LocalDB.
    const localDb: any = baseLocalDb;
    if (!localDb.getStore) {
        localDb.getStore = () => ({
            runWriteTx: vi.fn().mockResolvedValue(undefined),
            getMeta: vi.fn().mockResolvedValue(null),
        });
    }
    if (!localDb.getMetaStore) {
        localDb.getMetaStore = () => ({
            runWriteTx: vi.fn().mockResolvedValue(undefined),
            getMeta: vi.fn().mockResolvedValue(null),
        });
    }

    let cancelled = false;
    let callCount = 0;
    const isCancelled = () => {
        if (cancelled) return true;
        if (opts.cancelAfter !== undefined && callCount >= opts.cancelAfter) {
            cancelled = true;
            return true;
        }
        return false;
    };

    const checkpoints = new Checkpoints(localDb);
    const saveCheckpoints = vi.fn().mockResolvedValue(undefined);
    checkpoints.save = saveCheckpoints as any;
    const handleLocalDbError = vi.fn();
    let pausedCount = 0;
    events.on("paused", () => { pausedCount++; });

    const pipeline = new PushPipeline({
        localDb,
        client,
        echoes,
        events,
        checkpoints,
        isCancelled,
        handleLocalDbError,
        delay: async () => {
            callCount++;
        },
    });

    return {
        pipeline, echoes, events, localDb,
        cancel: () => { cancelled = true; },
        getLastPushedSeq: () => checkpoints.getLastPushedSeq(),
        saveCheckpoints, handleLocalDbError,
        pausedCount: () => pausedCount,
    };
}

// ── Pipeline loop ───────────────────────────────────────

describe("PushPipeline.run", () => {
    it("polls localDb.changes and pushes replicated docs", async () => {
        const localDb = {
            changes: vi.fn()
                .mockResolvedValueOnce({
                    results: [
                        { id: "file:a.md", seq: 1, doc: { _id: "file:a.md", type: "file" } },
                    ],
                    last_seq: 1,
                })
                .mockResolvedValue({ results: [], last_seq: 1 }),
        };
        const bulkDocs = vi.fn().mockResolvedValue([{ ok: true, id: "file:a.md", rev: "1-x" }]);
        const client = makeMockClient({ bulkDocs });
        const { pipeline, pausedCount } = makePipeline(client, { localDb, cancelAfter: 1 });

        await pipeline.run();

        expect(bulkDocs).toHaveBeenCalled();
        // SyncEngine subscribes to paused to update lastHealthyAt.
        expect(pausedCount()).toBeGreaterThanOrEqual(1);
    });

    it("skips non-replicated doc IDs (_local/*)", async () => {
        const localDb = {
            changes: vi.fn()
                .mockResolvedValueOnce({
                    results: [
                        { id: "_local/something", seq: 1, doc: { _id: "_local/something" } },
                    ],
                    last_seq: 1,
                })
                .mockResolvedValue({ results: [], last_seq: 1 }),
        };
        const bulkDocs = vi.fn();
        const client = makeMockClient({ bulkDocs });
        const { pipeline } = makePipeline(client, { localDb, cancelAfter: 1 });

        await pipeline.run();

        expect(bulkDocs).not.toHaveBeenCalled();
    });

    it("filters out pull echoes based on seq comparison", async () => {
        const localDb = {
            changes: vi.fn()
                .mockResolvedValueOnce({
                    results: [
                        { id: "file:echo.md", seq: 10, doc: { _id: "file:echo.md", type: "file" } },
                    ],
                    last_seq: 10,
                })
                .mockResolvedValue({ results: [], last_seq: 10 }),
        };
        const bulkDocs = vi.fn();
        const client = makeMockClient({ bulkDocs });
        const { pipeline, echoes } = makePipeline(client, { localDb, cancelAfter: 1 });

        // Record that pull wrote this doc at seq 10 → local change at seq 10 is the echo.
        echoes.recordPullWrites(["file:echo.md"], 10);

        await pipeline.run();

        expect(bulkDocs).not.toHaveBeenCalled();
    });

    it("lets post-pull edits through (seq > recorded pull seq)", async () => {
        const localDb = {
            changes: vi.fn()
                .mockResolvedValueOnce({
                    results: [
                        { id: "file:fresh.md", seq: 15, doc: { _id: "file:fresh.md", type: "file" } },
                    ],
                    last_seq: 15,
                })
                .mockResolvedValue({ results: [], last_seq: 15 }),
        };
        const bulkDocs = vi.fn().mockResolvedValue([{ ok: true, id: "file:fresh.md", rev: "1-x" }]);
        const client = makeMockClient({ bulkDocs });
        const { pipeline, echoes } = makePipeline(client, { localDb, cancelAfter: 1 });

        echoes.recordPullWrites(["file:fresh.md"], 10); // pull at 10, local edit at 15

        await pipeline.run();

        expect(bulkDocs).toHaveBeenCalled();
    });

    it("halt DbError exits the loop", async () => {
        const err = new DbError("quota", "full", { recovery: "halt" });
        const localDb = { changes: vi.fn().mockRejectedValue(err) };
        const { pipeline, handleLocalDbError } = makePipeline(makeMockClient(), { localDb });

        await pipeline.run();

        expect(handleLocalDbError).toHaveBeenCalledWith(err, "push loop");
        expect(localDb.changes).toHaveBeenCalledTimes(1);
    });
});

// ── pushDocs one-shot ───────────────────────────────────

describe("PushPipeline.pushDocs", () => {
    it("threads remote revs onto docs before bulkDocs", async () => {
        const bulkDocs = vi.fn().mockResolvedValue([{ ok: true }]);
        const allDocs = vi.fn().mockResolvedValue({
            rows: [{ id: "file:x.md", value: { rev: "2-remote" } }],
        });
        const client = makeMockClient({ bulkDocs, allDocs });
        const { pipeline } = makePipeline(client);

        await pipeline.pushDocs([{ _id: "file:x.md", type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0 } as any]);

        expect(allDocs).toHaveBeenCalledWith({ keys: ["file:x.md"] });
        const pushed = bulkDocs.mock.calls[0][0];
        expect(pushed[0]._rev).toBe("2-remote");
    });

    it("records push-echo for successful pushes", async () => {
        const bulkDocs = vi.fn().mockResolvedValue([{ ok: true, id: "file:x.md", rev: "2-x" }]);
        const client = makeMockClient({ bulkDocs });
        const { pipeline, echoes } = makePipeline(client);

        await pipeline.pushDocs([{ _id: "file:x.md", type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0 } as any]);

        expect(echoes.consumePushEcho("file:x.md")).toBe(true);
    });

    it("emits error event once per session on 403 storm", async () => {
        const bulkDocs = vi.fn().mockResolvedValue([
            { error: "forbidden", reason: "no perm", id: "file:a.md" },
            { error: "forbidden", reason: "no perm", id: "file:b.md" },
        ]);
        const client = makeMockClient({ bulkDocs });
        const { pipeline, events } = makePipeline(client);

        const errors: string[] = [];
        events.on("error", ({ message }) => errors.push(message));

        await pipeline.pushDocs([
            { _id: "file:a.md", type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0 } as any,
            { _id: "file:b.md", type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0 } as any,
        ]);

        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain("denied");

        // Second storm: latch should suppress the repeat.
        bulkDocs.mockResolvedValueOnce([{ error: "forbidden", reason: "no perm", id: "file:c.md" }]);
        await pipeline.pushDocs([
            { _id: "file:c.md", type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0 } as any,
        ]);
        expect(errors).toHaveLength(1);
    });

    it("does not record push-echo for conflicted or denied docs", async () => {
        const bulkDocs = vi.fn().mockResolvedValue([
            { error: "conflict", id: "file:a.md" },
            { error: "forbidden", reason: "no perm", id: "file:b.md" },
        ]);
        const client = makeMockClient({ bulkDocs });
        const { pipeline, echoes } = makePipeline(client);

        await pipeline.pushDocs([
            { _id: "file:a.md", type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0 } as any,
            { _id: "file:b.md", type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0 } as any,
        ]);

        expect(echoes.consumePushEcho("file:a.md")).toBe(false);
        expect(echoes.consumePushEcho("file:b.md")).toBe(false);
    });
});
