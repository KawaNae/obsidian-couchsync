import { describe, it, expect, vi } from "vitest";
import { PullPipeline } from "../src/db/sync/pull-pipeline.ts";
import { PullWriter } from "../src/db/sync/pull-writer.ts";
import { EchoTracker } from "../src/db/sync/echo-tracker.ts";
import { SyncEvents } from "../src/db/sync/sync-events.ts";
import { AuthGate } from "../src/db/sync/auth-gate.ts";
import { Checkpoints } from "../src/db/sync/checkpoints.ts";
import { ErrorRecovery } from "../src/db/error-recovery.ts";
import { DbError } from "../src/db/write-transaction.ts";
import type { ICouchClient } from "../src/db/interfaces.ts";
import type { SyncState } from "../src/db/reconnect-policy.ts";

function makeClient(overrides?: Partial<ICouchClient>): ICouchClient {
    return {
        info: vi.fn().mockResolvedValue({ db_name: "t", doc_count: 0, update_seq: "0" }),
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

function makeLocalDb(): any {
    const runWriteTx = vi.fn(async (tx: any) => { if (tx?.onCommit) await tx.onCommit(); });
    const mock: any = {
        runWriteTx,
        info: vi.fn().mockResolvedValue({ updateSeq: 5 }),
        get: vi.fn().mockResolvedValue(null),
        getChunks: vi.fn().mockResolvedValue([]),
    };
    mock.getStore = () => ({
        runWriteTx: mock.runWriteTx,
        getMeta: vi.fn().mockResolvedValue(null),
    });
    mock.getMetaStore = () => ({
        runWriteTx: vi.fn().mockResolvedValue(undefined),
        getMeta: vi.fn().mockResolvedValue(null),
    });
    return mock;
}

interface Harness {
    pipeline: PullPipeline;
    events: SyncEvents;
    pausedCount: () => number;
    handleLocalDbError: ReturnType<typeof vi.fn>;
    checkpoints: Checkpoints;
    saveCheckpoints: ReturnType<typeof vi.fn>;
    cancel: () => void;
    getRemoteSeq: () => number | string;
}

function makeHarness(client: ICouchClient): Harness {
    const localDb = makeLocalDb();
    const echoes = new EchoTracker();
    const events = new SyncEvents();
    const checkpoints = new Checkpoints(localDb);
    // Spy save() to observe persistence attempts without hitting the mock store.
    const saveCheckpoints = vi.fn().mockResolvedValue(undefined);
    checkpoints.save = saveCheckpoints as any;
    const pullWriter = new PullWriter({
        localDb, events, echoes, checkpoints,
        getConflictResolver: () => undefined,
        ensureChunks: async () => {},
    });

    let state: SyncState = "connected";
    let cancelled = false;
    let paused = 0;
    events.on("paused", () => { paused++; });

    const handleLocalDbError = vi.fn();
    const errorRecovery = new ErrorRecovery({
        getState: () => state,
        setState: (s) => { state = s; },
        emitError: () => {},
        teardown: () => {},
        requestReconnect: async () => {},
    }, new AuthGate());

    const pipeline = new PullPipeline({
        client, pullWriter, checkpoints, errorRecovery, events,
        isCancelled: () => cancelled,
        handleLocalDbError,
        delay: async () => {},
    });

    return {
        pipeline, events, pausedCount: () => paused,
        handleLocalDbError, checkpoints, saveCheckpoints,
        cancel: () => { cancelled = true; },
        getRemoteSeq: () => checkpoints.getRemoteSeq(),
    };
}

// ── Catchup ─────────────────────────────────────────────

describe("PullPipeline.runCatchup", () => {
    it("drains remote changes in batches until empty", async () => {
        let i = 0;
        const responses = [
            {
                results: [
                    { id: "file:a.md", seq: "1", doc: { _id: "file:a.md", type: "file", chunks: [], vclock: { A: 1 }, mtime: 1, ctime: 1, size: 0 } },
                ],
                last_seq: "1",
            },
            { results: [], last_seq: "1" },
        ];
        const client = makeClient({
            changes: vi.fn().mockImplementation(async () => responses[i++] ?? { results: [], last_seq: "1" }),
        });
        const h = makeHarness(client);

        await h.pipeline.runCatchup();

        expect(client.changes).toHaveBeenCalledTimes(2);
        expect(h.getRemoteSeq()).toBe("1");
        expect(h.saveCheckpoints).toHaveBeenCalled();
    });

    it("exits early if cancelled before first fetch", async () => {
        const client = makeClient();
        const h = makeHarness(client);
        h.cancel();

        await h.pipeline.runCatchup();

        expect(client.changes).not.toHaveBeenCalled();
    });

    // Idle timeout (60s no progress) is exercised against a real server in
    // tests/integration/*. Reliable unit-level time-mocking of the catchup
    // loop adds more fragility than value.
});

// ── Longpoll ────────────────────────────────────────────

describe("PullPipeline.runLongpoll", () => {
    it("applies received changes and emits paused after batch", async () => {
        let h!: Harness;
        let callCount = 0;
        const client = makeClient({
            changesLongpoll: vi.fn().mockImplementation(async () => {
                callCount++;
                if (callCount === 1) {
                    return {
                        results: [
                            { id: "file:a.md", seq: "5", doc: { _id: "file:a.md", type: "file", chunks: [], vclock: { A: 1 }, mtime: 1, ctime: 1, size: 0 } },
                        ],
                        last_seq: "5",
                    };
                }
                h.cancel();
                return { results: [], last_seq: "5" };
            }),
        });
        h = makeHarness(client);

        await h.pipeline.runLongpoll();

        // Pipeline does not drive the state machine — SyncEngine owns it.
        // Pipeline only signals "batch was applied" via paused.
        expect(h.pausedCount()).toBeGreaterThanOrEqual(1);
    });

    it("empty longpoll result emits no paused (no batch applied)", async () => {
        let h!: Harness;
        let callCount = 0;
        const client = makeClient({
            changesLongpoll: vi.fn().mockImplementation(async () => {
                callCount++;
                if (callCount >= 2) h.cancel();
                return { results: [], last_seq: "0" };
            }),
        });
        h = makeHarness(client);

        await h.pipeline.runLongpoll();

        expect(h.pausedCount()).toBe(0);
    });

    it("DbError with recovery=halt exits the loop immediately", async () => {
        const err = new DbError("quota", "quota exceeded", { recovery: "halt" });
        const client = makeClient({
            changesLongpoll: vi.fn().mockRejectedValue(err),
        });
        const h = makeHarness(client);

        await h.pipeline.runLongpoll();

        expect(h.handleLocalDbError).toHaveBeenCalledWith(err, "pull write");
        expect(client.changesLongpoll).toHaveBeenCalledTimes(1);
    });

    it("exponential backoff doubles retryMs on consecutive errors (capped at 30s)", async () => {
        let h!: Harness;
        let callCount = 0;
        const client = makeClient({
            changesLongpoll: vi.fn().mockImplementation(async () => {
                callCount++;
                if (callCount > 5) h.cancel();
                throw new Error("network offline");
            }),
        });
        h = makeHarness(client);

        await h.pipeline.runLongpoll();

        expect(h.pipeline.getRetryMs()).toBeLessThanOrEqual(30_000);
        expect(h.pipeline.getRetryMs()).toBeGreaterThanOrEqual(4_000);
    });

    it("records the last transient error message for dedup", async () => {
        let h!: Harness;
        let callCount = 0;
        const client = makeClient({
            changesLongpoll: vi.fn().mockImplementation(async () => {
                callCount++;
                if (callCount > 2) h.cancel();
                throw new Error("network offline");
            }),
        });
        h = makeHarness(client);

        await h.pipeline.runLongpoll();

        expect(h.pipeline.getLastErrorMsg()).toContain("offline");
    });
});
