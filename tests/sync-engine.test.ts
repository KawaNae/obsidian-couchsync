import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import type { ICouchClient, ChangesResult, DbInfo } from "../src/db/interfaces.ts";
import type { CouchSyncSettings } from "../src/settings.ts";
import type { CouchSyncDoc, FileDoc } from "../src/types.ts";
import type { SyncState } from "../src/db/reconnect-policy.ts";

// ── Stub browser globals ─────────────────────────────────
const noop = () => {};
(globalThis as any).self = (globalThis as any).self ?? globalThis;
(globalThis as any).window = (globalThis as any).window ?? {
    addEventListener: noop,
    removeEventListener: noop,
};
(globalThis as any).document = (globalThis as any).document ?? {
    addEventListener: noop,
    removeEventListener: noop,
    visibilityState: "visible",
};

// Dynamic import so the stubs are in place before transitive deps.
let SyncEngine: typeof import("../src/db/sync-engine.ts").SyncEngine;
beforeAll(async () => {
    ({ SyncEngine } = await import("../src/db/sync-engine.ts"));
});

// ── Mock factories ───────────────────────────────────────

/**
 * changesLongpoll mock that resolves the first `resolveCount` calls,
 * then hangs forever. Prevents tight infinite loops in the pull loop.
 */
function makeLongpollMock(
    resolveCount = 1,
    result: ChangesResult<any> = { results: [], last_seq: "0" },
) {
    let callNum = 0;
    return vi.fn().mockImplementation(async () => {
        callNum++;
        if (callNum <= resolveCount) return result;
        return new Promise(() => {});
    });
}

function makeMockClient(overrides?: Partial<ICouchClient>): ICouchClient {
    return {
        info: vi.fn().mockResolvedValue({ db_name: "test", doc_count: 0, update_seq: "0" } satisfies DbInfo),
        getDoc: vi.fn().mockResolvedValue(null),
        bulkGet: vi.fn().mockResolvedValue([]),
        bulkDocs: vi.fn().mockResolvedValue([]),
        allDocs: vi.fn().mockResolvedValue({ rows: [], total_rows: 0 }),
        changes: vi.fn().mockResolvedValue({ results: [], last_seq: "0" } satisfies ChangesResult<any>),
        changesLongpoll: makeLongpollMock(),
        destroy: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function makeMockLocalDb(overrides?: any): any {
    const docsMeta: Record<string, any> = {};
    const legacyMeta: Record<string, any> = {};

    // Simulate the docs store: runWriteTx accepts a fixed tx,
    // runWriteBuilder accepts a builder function. Mimics the real DexieStore:
    // meta puts land in docsMeta, `docs` flow into the `bulkPut` mock so
    // existing assertions still observe pulled writes. Fires onCommit
    // synchronously after.
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
            // Call bulkPut mock with the bare doc array (old shape) so
            // existing assertions continue to work.
            await bulkPut(tx.docs.map((d: any) => d.doc));
        }
        if (tx.onCommit) await tx.onCommit();
    };
    const runWriteTx = vi.fn(async (tx: any) => {
        await applyTx(tx);
    });
    const runWriteBuilder = vi.fn(async (builder: any, _opts?: any) => {
        const built = await builder({
            get: async () => null,
            getMeta: async (k: string) => docsMeta[k] ?? null,
            getMetaByPrefix: async () => [],
        });
        if (!built) return false;
        await applyTx(built);
        return true;
    });
    const docsStore = {
        getMeta: vi.fn(async (key: string) => docsMeta[key] ?? null),
        runWriteTx,
        runWriteBuilder,
    };
    return {
        bulkPut,
        changes: vi.fn().mockResolvedValue({ results: [], last_seq: 0 }),
        info: vi.fn().mockResolvedValue({ updateSeq: 0 }),
        getChunks: vi.fn().mockResolvedValue([]),
        runWriteTx,
        runWriteBuilder,
        getStore: () => docsStore,
        getMetaStore: () => ({
            getMeta: vi.fn(async (key: string) => legacyMeta[key] ?? null),
            putMeta: vi.fn(async (key: string, value: any) => { legacyMeta[key] = value; }),
            deleteMeta: vi.fn(async (key: string) => { delete legacyMeta[key]; }),
        }),
        allDocs: vi.fn().mockResolvedValue({ rows: [] }),
        ...overrides,
    };
}

function makeSyncEngine(localDb: any, mockClient: ICouchClient): InstanceType<typeof SyncEngine> {
    const settings = (): CouchSyncSettings => ({
        couchdbUri: "http://test.invalid",
        couchdbUser: "",
        couchdbPassword: "",
        couchdbDbName: "test",
        couchdbConfigDbName: "",
    } as any);
    const engine = new SyncEngine(localDb, settings, false);
    (engine as any).makeVaultClient = () => mockClient;
    return engine;
}

function fakeDoc(id: string, rev = "1-abc"): CouchSyncDoc {
    return { _id: id, _rev: rev } as any;
}

// ── Tests ────────────────────────────────────────────────

describe("SyncEngine state machine", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("start() transitions: disconnected -> reconnecting -> syncing -> connected", async () => {
        const mockClient = makeMockClient();
        const localDb = makeMockLocalDb();
        const engine = makeSyncEngine(localDb, mockClient);

        const states: SyncState[] = [];
        engine.events.on("state-change", ({ state }) => states.push(state));

        expect(engine.getState()).toBe("disconnected");
        await engine.start();

        // Catchup complete → connected immediately, no longpoll wait.
        expect(states).toEqual(["reconnecting", "syncing", "connected"]);
        expect(engine.getState()).toBe("connected");
        engine.stop();
    });

    it("stop() sets state to disconnected", async () => {
        const mockClient = makeMockClient();
        const localDb = makeMockLocalDb();
        const engine = makeSyncEngine(localDb, mockClient);

        await engine.start();
        engine.stop();
        expect(engine.getState()).toBe("disconnected");
    });

    it("concurrent start() calls dedup (only one session created)", async () => {
        const mockClient = makeMockClient();
        const localDb = makeMockLocalDb();
        const engine = makeSyncEngine(localDb, mockClient);

        await Promise.all([engine.start(), engine.start(), engine.start()]);

        // catchup changes() should have been called exactly once.
        expect(mockClient.changes).toHaveBeenCalledTimes(1);
        engine.stop();
    });

    it("paused event fires immediately after catchup completes", async () => {
        const engine = makeSyncEngine(makeMockLocalDb(), makeMockClient());

        const pausedCalls: boolean[] = [];
        engine.events.on("paused", () => pausedCalls.push(true));

        await engine.start();

        // paused event fires during start(), no longpoll wait needed.
        expect(pausedCalls).toEqual([true]);
        expect(engine.getState()).toBe("connected");
        engine.stop();
    });

    it("onceIdle fires immediately after catchup completes", async () => {
        const engine = makeSyncEngine(makeMockLocalDb(), makeMockClient());

        const idleCalls: boolean[] = [];
        engine.events.onceIdle(() => idleCalls.push(true));

        await engine.start();

        expect(idleCalls).toEqual([true]);
        engine.stop();
    });

    it("pullLoop transitions syncing->connected on received changes", async () => {
        const doc1 = fakeDoc("file:live-a.md");
        const mockClient = makeMockClient({
            changesLongpoll: makeLongpollMock(1, {
                results: [{ id: "file:live-a.md", seq: "5", doc: doc1 }],
                last_seq: "5",
            }),
        });
        const engine = makeSyncEngine(makeMockLocalDb(), mockClient);

        const states: SyncState[] = [];
        engine.events.on("state-change", ({ state }) => states.push(state));

        const pausedCalls: boolean[] = [];
        engine.events.on("paused", () => pausedCalls.push(true));

        await engine.start();
        // Wait for pullLoop to process the longpoll result.
        await new Promise((r) => setTimeout(r, 100));

        // Initial: reconnecting → syncing → connected (catchup)
        // Then pullLoop: syncing → connected (live change received)
        expect(states).toContain("syncing");
        expect(states).toContain("connected");
        // paused: once for catchup, once for pullLoop change
        expect(pausedCalls.length).toBeGreaterThanOrEqual(2);

        engine.stop();
    });

    it("empty longpoll result does not change state", async () => {
        // changesLongpoll returns empty results (max-wait timeout).
        const mockClient = makeMockClient({
            changesLongpoll: makeLongpollMock(2, { results: [], last_seq: "0" }),
        });
        const engine = makeSyncEngine(makeMockLocalDb(), mockClient);

        const states: SyncState[] = [];
        engine.events.on("state-change", ({ state }) => states.push(state));

        await engine.start();
        // Wait for two longpoll cycles.
        await new Promise((r) => setTimeout(r, 100));

        // Only initial transitions: reconnecting → syncing → connected.
        // Empty longpoll results don't trigger additional transitions.
        expect(states).toEqual(["reconnecting", "syncing", "connected"]);

        engine.stop();
    });
});

describe("SyncEngine error integration", () => {
    // Detailed ErrorRecovery tests live in error-recovery.test.ts.
    // These tests verify the SyncEngine ↔ ErrorRecovery integration
    // through public SyncEngine methods only.

    it("start() clears the auth latch", async () => {
        const engine = makeSyncEngine(makeMockLocalDb(), makeMockClient());

        engine.auth.raise(401, "test");
        expect(engine.auth.isBlocked()).toBe(true);

        await engine.start();
        expect(engine.auth.isBlocked()).toBe(false);
        engine.stop();
    });

    it("catchup error from changes() enters hard error with classification", async () => {
        const mockClient = makeMockClient({
            changes: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
        });
        const engine = makeSyncEngine(makeMockLocalDb(), mockClient);

        await engine.start();

        expect(engine.getState()).toBe("error");
        expect(engine.getLastErrorDetail()?.kind).toBe("network");
        engine.stop();
    });
});

describe("SyncEngine catchup pull", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("drains remote changes in batches and applies them to localDb", async () => {
        const doc1 = fakeDoc("file:a.md");
        const doc2 = fakeDoc("file:b.md");
        const doc3 = fakeDoc("file:c.md");

        const changesResponses = [
            { results: [{ id: "file:a.md", seq: "1", doc: doc1 }, { id: "file:b.md", seq: "2", doc: doc2 }], last_seq: "2" },
            { results: [{ id: "file:c.md", seq: "3", doc: doc3 }], last_seq: "3" },
            { results: [], last_seq: "3" },
        ];
        let callIdx = 0;
        const mockClient = makeMockClient({
            changes: vi.fn().mockImplementation(async () => changesResponses[callIdx++] ?? { results: [], last_seq: "3" }),
            changesLongpoll: makeLongpollMock(),
        });
        const localDb = makeMockLocalDb();
        const engine = makeSyncEngine(localDb, mockClient);

        await engine.start();
        await new Promise((r) => setTimeout(r, 50));

        expect(mockClient.changes).toHaveBeenCalledTimes(3);
        expect(localDb.bulkPut).toHaveBeenCalledTimes(2);

        engine.stop();
    });

    it("sets lastHealthyAt on catchup completion", async () => {
        const engine = makeSyncEngine(makeMockLocalDb(), makeMockClient());

        expect(engine.getLastHealthyAt()).toBe(0);
        const before = Date.now();
        await engine.start();
        const after = Date.now();

        expect(engine.getLastHealthyAt()).toBeGreaterThanOrEqual(before);
        expect(engine.getLastHealthyAt()).toBeLessThanOrEqual(after);
        engine.stop();
    });

    // catchup error classification is tested in error-recovery.test.ts
    // and the integration case is in "SyncEngine error integration" above.
});

describe("SyncEngine live sync", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("pull loop fires paused event for pulled docs and transitions syncing->connected", async () => {
        const doc1 = fakeDoc("file:live-a.md");

        const mockClient = makeMockClient({
            changesLongpoll: makeLongpollMock(1, {
                results: [{ id: "file:live-a.md", seq: "5", doc: doc1 }],
                last_seq: "5",
            }),
        });
        const localDb = makeMockLocalDb();
        const engine = makeSyncEngine(localDb, mockClient);

        const pausedCalls: boolean[] = [];
        engine.events.on("paused", () => pausedCalls.push(true));

        await engine.start();
        await new Promise((r) => setTimeout(r, 100));

        expect(pausedCalls.length).toBeGreaterThanOrEqual(1);

        engine.stop();
    });

    it("push loop detects local changes and pushes to remote", async () => {
        const localDoc = fakeDoc("file:notes/test.md");

        const mockClient = makeMockClient({
            changesLongpoll: vi.fn().mockImplementation(() => new Promise(() => {})),
            allDocs: vi.fn().mockResolvedValue({ rows: [], total_rows: 0 }),
        });

        let changeCallNum = 0;
        const localDb = makeMockLocalDb({
            changes: vi.fn().mockImplementation(async () => {
                changeCallNum++;
                if (changeCallNum <= 1) {
                    return {
                        results: [{ id: "file:notes/test.md", seq: 1, doc: localDoc }],
                        last_seq: 1,
                    };
                }
                return { results: [], last_seq: 1 };
            }),
        });

        const engine = makeSyncEngine(localDb, mockClient);
        await engine.start();

        // Wait for the push loop's first iteration to complete.
        await new Promise((r) => setTimeout(r, 100));

        expect(mockClient.bulkDocs).toHaveBeenCalled();
        engine.stop();
    });

    it("push loop skips non-replicated doc IDs", async () => {
        const nonReplicatedDoc = fakeDoc("_local/something");

        const mockClient = makeMockClient({
            changesLongpoll: vi.fn().mockImplementation(() => new Promise(() => {})),
        });

        let changeCallNum = 0;
        const localDb = makeMockLocalDb({
            changes: vi.fn().mockImplementation(async () => {
                changeCallNum++;
                if (changeCallNum <= 1) {
                    return {
                        results: [{ id: "_local/something", seq: 1, doc: nonReplicatedDoc }],
                        last_seq: 1,
                    };
                }
                return { results: [], last_seq: 1 };
            }),
        });

        const engine = makeSyncEngine(localDb, mockClient);
        await engine.start();

        // Wait for push loop first iteration.
        await new Promise((r) => setTimeout(r, 100));

        expect(mockClient.bulkDocs).not.toHaveBeenCalled();
        engine.stop();
    });

    it("pull updates lastHealthyAt after applying changes", async () => {
        const doc1 = fakeDoc("file:pull-healthy.md");
        const mockClient = makeMockClient({
            changesLongpoll: makeLongpollMock(1, {
                results: [{ id: "file:pull-healthy.md", seq: "10", doc: doc1 }],
                last_seq: "10",
            }),
        });
        const engine = makeSyncEngine(makeMockLocalDb(), mockClient);

        await engine.start();
        // Reset to observe pullLoop update.
        (engine as any).lastHealthyAt = 0;

        const before = Date.now();
        await new Promise((r) => setTimeout(r, 100));
        const after = Date.now();

        expect(engine.getLastHealthyAt()).toBeGreaterThanOrEqual(before);
        expect(engine.getLastHealthyAt()).toBeLessThanOrEqual(after);
        engine.stop();
    });

    it("push updates lastHealthyAt after successful push", async () => {
        const localDoc = fakeDoc("file:push-healthy.md");
        const bulkDocsMock = vi.fn().mockResolvedValue([{ ok: true, id: "file:push-healthy.md", rev: "2-new" }]);
        const mockClient = makeMockClient({
            changesLongpoll: vi.fn().mockImplementation(() => new Promise(() => {})),
            allDocs: vi.fn().mockResolvedValue({ rows: [], total_rows: 0 }),
            bulkDocs: bulkDocsMock,
        });

        let changeCallNum = 0;
        const localDb = makeMockLocalDb({
            changes: vi.fn().mockImplementation(async () => {
                changeCallNum++;
                if (changeCallNum <= 1) {
                    return {
                        results: [{ id: "file:push-healthy.md", seq: 1, doc: localDoc }],
                        last_seq: 1,
                    };
                }
                return { results: [], last_seq: 1 };
            }),
        });

        // Capture `before` BEFORE engine creation so any healthyAt write
        // (catchup or push) is guaranteed to land in [before, after].
        const before = Date.now();
        const engine = makeSyncEngine(localDb, mockClient);
        await engine.start();
        // Poll until bulkDocs has been called (push loop ran).
        for (let i = 0; i < 20 && !bulkDocsMock.mock.calls.length; i++) {
            await new Promise((r) => setTimeout(r, 50));
        }
        const after = Date.now();

        expect(bulkDocsMock).toHaveBeenCalled();
        expect(engine.getLastHealthyAt()).toBeGreaterThanOrEqual(before);
        expect(engine.getLastHealthyAt()).toBeLessThanOrEqual(after);
        engine.stop();
    });
});

describe("SyncEngine stall detection (checkHealth)", () => {
    it("seq match → no stall, updates lastHealthyAt", async () => {
        const mockClient = makeMockClient({
            info: vi.fn().mockResolvedValue({ db_name: "test", doc_count: 0, update_seq: "42" }),
        });
        const engine = makeSyncEngine(makeMockLocalDb(), mockClient);

        (engine as any).client = mockClient;
        (engine as any).running = true;
        (engine as any).remoteSeq = "42";
        (engine as any).setState("connected");

        const before = Date.now();
        await (engine as any).checkHealth();
        const after = Date.now();

        expect(engine.getState()).toBe("connected");
        expect(engine.getLastHealthyAt()).toBeGreaterThanOrEqual(before);
        expect(engine.getLastHealthyAt()).toBeLessThanOrEqual(after);
        engine.stop();
    });

    it("seq mismatch on first check → records seq, no stall yet", async () => {
        const mockClient = makeMockClient({
            info: vi.fn().mockResolvedValue({ db_name: "test", doc_count: 0, update_seq: "50" }),
        });
        const engine = makeSyncEngine(makeMockLocalDb(), mockClient);

        (engine as any).client = mockClient;
        (engine as any).running = true;
        (engine as any).remoteSeq = "40";
        (engine as any).setState("syncing");

        await (engine as any).checkHealth();

        // First observation: records the seq but does not trigger stall.
        expect(engine.getState()).toBe("syncing");
        expect((engine as any).lastObservedRemoteSeq).toBe("50");
        engine.stop();
    });

    it("seq mismatch persists across two checks → stall → reconnect", async () => {
        const mockClient = makeMockClient({
            info: vi.fn().mockResolvedValue({ db_name: "test", doc_count: 0, update_seq: "50" }),
        });
        const engine = makeSyncEngine(makeMockLocalDb(), mockClient);

        (engine as any).client = mockClient;
        (engine as any).running = true;
        (engine as any).remoteSeq = "40";
        (engine as any).setState("connected");

        const reconnectSpy = vi
            .spyOn(engine as any, "requestReconnect")
            .mockResolvedValue(undefined);

        // First check: records remote seq.
        await (engine as any).checkHealth();
        expect(reconnectSpy).not.toHaveBeenCalled();

        // Second check: same remote seq, still not consumed → stall.
        await (engine as any).checkHealth();
        expect(reconnectSpy).toHaveBeenCalledWith("stalled");

        reconnectSpy.mockRestore();
        engine.stop();
    });

    it("CouchDB 3.x opaque seq: same numeric prefix → no stall", async () => {
        // CouchDB 3.x returns different opaque suffixes from info() vs _changes
        // for the same logical position. Only the numeric prefix should matter.
        const mockClient = makeMockClient({
            info: vi.fn().mockResolvedValue({
                db_name: "test", doc_count: 0,
                update_seq: "1771-g1AAAACReJz_OPAQUE_FROM_INFO",
            }),
        });
        const engine = makeSyncEngine(makeMockLocalDb(), mockClient);

        (engine as any).client = mockClient;
        (engine as any).running = true;
        // remoteSeq from _changes has different opaque suffix but same numeric prefix
        (engine as any).remoteSeq = "1771-g1AAAACReJz_OPAQUE_FROM_CHANGES";
        (engine as any).setState("connected");

        const reconnectSpy = vi
            .spyOn(engine as any, "requestReconnect")
            .mockResolvedValue(undefined);

        await (engine as any).checkHealth();
        await (engine as any).checkHealth();

        // Same numeric prefix (1771) → NOT a stall.
        expect(reconnectSpy).not.toHaveBeenCalled();

        reconnectSpy.mockRestore();
        engine.stop();
    });

    it("info() failure → hard error", async () => {
        const mockClient = makeMockClient({
            info: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
        });
        const engine = makeSyncEngine(makeMockLocalDb(), mockClient);

        (engine as any).client = mockClient;
        (engine as any).running = true;
        (engine as any).setState("connected");

        await (engine as any).checkHealth();

        expect(engine.getState()).toBe("error");
        expect(engine.getLastErrorDetail()?.kind).toBe("network");
        engine.stop();
    });

    it("auth latch → checkHealth skipped entirely", async () => {
        const mockClient = makeMockClient();
        const engine = makeSyncEngine(makeMockLocalDb(), mockClient);

        (engine as any).client = mockClient;
        (engine as any).running = true;
        engine.auth.raise(401, "blocked");
        (engine as any).setState("connected");

        await (engine as any).checkHealth();
        expect(mockClient.info).not.toHaveBeenCalled();
        engine.stop();
    });

    it("checkHealth skips in reconnecting/error states", async () => {
        const mockClient = makeMockClient();
        const engine = makeSyncEngine(makeMockLocalDb(), mockClient);

        (engine as any).client = mockClient;
        (engine as any).running = true;

        (engine as any).setState("reconnecting");
        await (engine as any).checkHealth();
        expect(mockClient.info).not.toHaveBeenCalled();

        (engine as any).errorRecovery.enterHardError({ kind: "network", message: "down" });
        (mockClient.info as any).mockClear();
        await (engine as any).checkHealth();
        expect(mockClient.info).not.toHaveBeenCalled();
        engine.stop();
    });

    it("checkHealth in disconnected state triggers reconnect", async () => {
        const engine = makeSyncEngine(makeMockLocalDb(), makeMockClient());

        const reconnectSpy = vi
            .spyOn(engine as any, "requestReconnect")
            .mockResolvedValue(undefined);

        (engine as any).setState("disconnected");
        await (engine as any).checkHealth();

        expect(reconnectSpy).toHaveBeenCalledWith("periodic-tick");
        reconnectSpy.mockRestore();
        engine.stop();
    });
});

// vclock guard + atomic commit are tested directly against PullWriter
// in tests/pull-writer.test.ts. SyncEngine just wires the call site.

// One-shot operations (pushToRemote/pullFromRemote/destroyRemote/testConnection)
// moved to VaultRemoteOps. See tests/vault-remote-ops.test.ts.

// Echo suppression unit behavior: tests/echo-tracker.test.ts
// Deletion propagation (handlePulledDeletion): tests/pull-writer.test.ts
// pullLoop / pushLoop backoff + retry: tests/pull-pipeline.test.ts, tests/push-pipeline.test.ts
