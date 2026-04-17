import { describe, it, expect, vi } from "vitest";
import { SyncSession } from "../src/db/sync/sync-session.ts";
import { SyncEvents } from "../src/db/sync/sync-events.ts";
import { AuthGate } from "../src/db/sync/auth-gate.ts";
import { ErrorRecovery } from "../src/db/error-recovery.ts";
import { Checkpoints } from "../src/db/sync/checkpoints.ts";
import type { ICouchClient } from "../src/db/interfaces.ts";

function makeClient(overrides: Partial<ICouchClient> = {}): ICouchClient {
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
    return {
        runWriteTx: vi.fn(async (tx: any) => { if (tx?.onCommit) await tx.onCommit(); }),
        info: vi.fn().mockResolvedValue({ updateSeq: 0 }),
        get: vi.fn().mockResolvedValue(null),
        getChunks: vi.fn().mockResolvedValue([]),
        changes: vi.fn().mockResolvedValue({ results: [], last_seq: 0 }),
        getStore: () => ({
            getMeta: vi.fn().mockResolvedValue(null),
            runWriteTx: vi.fn().mockResolvedValue(undefined),
        }),
        getMetaStore: () => ({
            getMeta: vi.fn().mockResolvedValue(null),
            runWriteTx: vi.fn().mockResolvedValue(undefined),
        }),
    };
}

function makeSession(client = makeClient()) {
    const localDb = makeLocalDb();
    const events = new SyncEvents();
    const auth = new AuthGate();
    const errorRecovery = new ErrorRecovery({
        getState: () => "connected" as const,
        setState: () => {},
        emitError: () => {},
        teardown: () => {},
        requestReconnect: async () => {},
    }, auth);
    const checkpoints = new Checkpoints(localDb);
    return new SyncSession({
        client, localDb, events, errorRecovery, checkpoints,
        getConflictResolver: () => undefined,
        ensureChunks: async () => {},
        handleLocalDbError: () => {},
    });
}

describe("SyncSession", () => {
    it("exposes client; disposed=false initially", () => {
        const session = makeSession();
        expect(session.client).toBeDefined();
        expect(session.disposed).toBe(false);
    });

    it("dispose() flips disposed=true (idempotent)", () => {
        const s = makeSession();
        s.dispose();
        s.dispose();
        expect(s.disposed).toBe(true);
    });

    it("settled resolves when no tasks were started", async () => {
        const s = makeSession();
        s.dispose();
        await expect(s.settled).resolves.toBeUndefined();
    });

    it("runCatchup registers a task that settled awaits", async () => {
        const s = makeSession();
        const catchupP = s.runCatchup();
        const settledP = s.settled;
        await catchupP;
        await expect(settledP).resolves.toBeUndefined();
    });

    it("dispose mid-longpoll stops further iterations", async () => {
        let callCount = 0;
        // changesLongpoll resolves only when the disposed flag is set, so the
        // loop is parked on the await until dispose; after dispose it returns
        // empty, the loop reads isCancelled, and exits. callCount must be 1.
        let resolveLongpoll: (v: any) => void = () => {};
        const client = makeClient({
            changesLongpoll: vi.fn().mockImplementation(() => {
                callCount++;
                return new Promise((resolve) => { resolveLongpoll = resolve; });
            }),
        });
        const s = makeSession(client);
        s.startLive();
        await new Promise((r) => setTimeout(r, 20));
        expect(callCount).toBe(1);
        s.dispose();
        // Unblock the parked longpoll so the loop can read isCancelled.
        resolveLongpoll({ results: [], last_seq: "0" });
        await s.settled;
        await new Promise((r) => setTimeout(r, 30));
        // Loop saw cancellation and never re-issued changesLongpoll.
        expect(callCount).toBe(1);
    });

    it("owns its own echoes (session-scoped state)", () => {
        const s = makeSession();
        s.echoes.recordPushEcho("file:a.md");
        expect(s.echoes.consumePushEcho("file:a.md")).toBe(true);
        // Fresh session starts with empty echoes
        const s2 = makeSession();
        expect(s2.echoes.consumePushEcho("file:a.md")).toBe(false);
    });
});
