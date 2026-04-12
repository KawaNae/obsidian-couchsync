import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import type { ICouchClient, ChangesResult, DbInfo } from "../src/db/interfaces.ts";
import type { CouchSyncSettings } from "../src/settings.ts";
import type { CouchSyncDoc } from "../src/types.ts";

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
    const metaStore: Record<string, any> = {};
    return {
        bulkPut: vi.fn().mockResolvedValue([]),
        changes: vi.fn().mockResolvedValue({ results: [], last_seq: 0 }),
        info: vi.fn().mockResolvedValue({ updateSeq: 0 }),
        getMetaStore: () => ({
            getMeta: vi.fn(async (key: string) => metaStore[key] ?? null),
            putMeta: vi.fn(async (key: string, value: any) => { metaStore[key] = value; }),
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

        const states: string[] = [];
        engine.onStateChange((s) => states.push(s));

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

    it("onPaused fires immediately after catchup completes", async () => {
        const engine = makeSyncEngine(makeMockLocalDb(), makeMockClient());

        const pausedCalls: boolean[] = [];
        engine.onPaused(() => pausedCalls.push(true));

        await engine.start();

        // onPaused fires during start(), no longpoll wait needed.
        expect(pausedCalls).toEqual([true]);
        expect(engine.getState()).toBe("connected");
        engine.stop();
    });

    it("onceIdle fires immediately after catchup completes", async () => {
        const engine = makeSyncEngine(makeMockLocalDb(), makeMockClient());

        const idleCalls: boolean[] = [];
        engine.onceIdle(() => idleCalls.push(true));

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

        const states: string[] = [];
        engine.onStateChange((s) => states.push(s));

        const pausedCalls: boolean[] = [];
        engine.onPaused(() => pausedCalls.push(true));

        await engine.start();
        // Wait for pullLoop to process the longpoll result.
        await new Promise((r) => setTimeout(r, 100));

        // Initial: reconnecting → syncing → connected (catchup)
        // Then pullLoop: syncing → connected (live change received)
        expect(states).toContain("syncing");
        expect(states).toContain("connected");
        // onPaused: once for catchup, once for pullLoop change
        expect(pausedCalls.length).toBeGreaterThanOrEqual(2);

        engine.stop();
    });

    it("empty longpoll result does not change state", async () => {
        // changesLongpoll returns empty results (max-wait timeout).
        const mockClient = makeMockClient({
            changesLongpoll: makeLongpollMock(2, { results: [], last_seq: "0" }),
        });
        const engine = makeSyncEngine(makeMockLocalDb(), mockClient);

        const states: string[] = [];
        engine.onStateChange((s) => states.push(s));

        await engine.start();
        // Wait for two longpoll cycles.
        await new Promise((r) => setTimeout(r, 100));

        // Only initial transitions: reconnecting → syncing → connected.
        // Empty longpoll results don't trigger additional transitions.
        expect(states).toEqual(["reconnecting", "syncing", "connected"]);

        engine.stop();
    });
});

describe("SyncEngine error handling", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("auth error -> state=error, isAuthBlocked=true, no retries scheduled", async () => {
        vi.useFakeTimers();
        try {
            const engine = makeSyncEngine(makeMockLocalDb(), makeMockClient());

            (engine as any).enterHardError({
                kind: "auth", code: 401,
                message: "Authentication failed (401).",
            });

            expect(engine.getState()).toBe("error");
            expect(engine.isAuthBlocked()).toBe(true);
            expect((engine as any).errorRetryTimer).toBeNull();

            await vi.advanceTimersByTimeAsync(60_000);
            expect(engine.getState()).toBe("error");
            engine.stop();
        } finally { vi.useRealTimers(); }
    });

    it("transient error -> reconnecting, escalates to error after 10s", async () => {
        vi.useFakeTimers();
        try {
            const engine = makeSyncEngine(makeMockLocalDb(), makeMockClient());
            const retrySpy = vi.spyOn(engine as any, "requestReconnect").mockResolvedValue(undefined);

            (engine as any).handleTransientError({ message: "ECONNREFUSED" });

            expect(engine.getState()).toBe("reconnecting");
            expect(engine.getLastErrorDetail()).toBeNull();

            await vi.advanceTimersByTimeAsync(9_999);
            expect(engine.getState()).toBe("reconnecting");

            await vi.advanceTimersByTimeAsync(2);
            expect(engine.getState()).toBe("error");
            expect(engine.getLastErrorDetail()?.kind).toBe("network");

            retrySpy.mockRestore();
            engine.stop();
        } finally { vi.useRealTimers(); }
    });

    it("transient error that recovers before 10s -> no escalation", async () => {
        vi.useFakeTimers();
        try {
            const engine = makeSyncEngine(makeMockLocalDb(), makeMockClient());

            (engine as any).handleTransientError({ message: "ECONNREFUSED" });
            expect(engine.getState()).toBe("reconnecting");

            (engine as any).setState("syncing");
            expect((engine as any).transientErrorTimer).toBeNull();

            await vi.advanceTimersByTimeAsync(11_000);
            expect(engine.getState()).toBe("syncing");
            expect(engine.getLastErrorDetail()).toBeNull();
            engine.stop();
        } finally { vi.useRealTimers(); }
    });

    it("hard error fires backoff retries at 2s, 5s, 10s schedule", async () => {
        vi.useFakeTimers();
        try {
            const engine = makeSyncEngine(makeMockLocalDb(), makeMockClient());
            const retrySpy = vi.spyOn(engine as any, "requestReconnect").mockResolvedValue(undefined);

            (engine as any).enterHardError({ kind: "network", message: "fake down" });

            expect(retrySpy).toHaveBeenCalledTimes(0);
            await vi.advanceTimersByTimeAsync(2_000);
            expect(retrySpy).toHaveBeenCalledTimes(1);
            expect(retrySpy).toHaveBeenLastCalledWith("retry-backoff");

            await vi.advanceTimersByTimeAsync(5_000);
            expect(retrySpy).toHaveBeenCalledTimes(2);

            await vi.advanceTimersByTimeAsync(10_000);
            expect(retrySpy).toHaveBeenCalledTimes(3);

            retrySpy.mockRestore();
            engine.stop();
        } finally { vi.useRealTimers(); }
    });

    it("recovery resets backoff step to 0", async () => {
        vi.useFakeTimers();
        try {
            const engine = makeSyncEngine(makeMockLocalDb(), makeMockClient());
            const retrySpy = vi.spyOn(engine as any, "requestReconnect").mockResolvedValue(undefined);

            (engine as any).enterHardError({ kind: "network", message: "fake" });
            await vi.advanceTimersByTimeAsync(2_000); // step 0
            await vi.advanceTimersByTimeAsync(5_000); // step 1
            expect((engine as any).errorRetryStep).toBe(2);

            (engine as any).setState("connected");
            expect((engine as any).errorRetryStep).toBe(0);
            expect((engine as any).errorRetryTimer).toBeNull();

            retrySpy.mockClear();
            (engine as any).enterHardError({ kind: "network", message: "again" });
            await vi.advanceTimersByTimeAsync(2_000);
            expect(retrySpy).toHaveBeenCalledTimes(1);

            retrySpy.mockRestore();
            engine.stop();
        } finally { vi.useRealTimers(); }
    });

    it("start() clears authError flag", async () => {
        const engine = makeSyncEngine(makeMockLocalDb(), makeMockClient());

        (engine as any).enterHardError({
            kind: "auth", code: 401,
            message: "Authentication failed (401).",
        });
        expect(engine.isAuthBlocked()).toBe(true);

        await engine.start();
        expect(engine.isAuthBlocked()).toBe(false);
        engine.stop();
    });

    it("classifyError heuristics", () => {
        const engine = makeSyncEngine(makeMockLocalDb(), makeMockClient());
        const classify = (err: any) => (engine as any).classifyError(err);

        expect(classify({ status: 401, message: "nope" }).kind).toBe("auth");
        expect(classify({ status: 403, message: "nope" }).kind).toBe("auth");
        expect(classify({ status: 500, message: "oops" }).kind).toBe("server");
        expect(classify({ status: 503, message: "down" }).kind).toBe("server");
        expect(classify({ message: "request timed out" }).kind).toBe("timeout");
        expect(classify({ message: "ECONNREFUSED" }).kind).toBe("network");
        expect(classify({ message: "Failed to fetch" }).kind).toBe("network");
        expect(classify({ message: "ENOTFOUND host.example" }).kind).toBe("network");
        expect(classify({ message: "something weird" }).kind).toBe("unknown");
        // HTTP code takes priority over message.
        expect(classify({ status: 401, message: "connection timed out" }).kind).toBe("auth");
        // Code is preserved.
        expect(classify({ status: 503, message: "down" }).code).toBe(503);

        engine.stop();
    });
});

describe("SyncEngine catchup pull", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("drains remote changes in batches and fires onChange", async () => {
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

        const changedDocs: string[] = [];
        engine.onChange((doc) => changedDocs.push((doc as any)._id));

        await engine.start();
        await new Promise((r) => setTimeout(r, 50));

        expect(mockClient.changes).toHaveBeenCalledTimes(3);
        expect(localDb.bulkPut).toHaveBeenCalledTimes(2);
        expect(changedDocs).toContain("file:a.md");
        expect(changedDocs).toContain("file:b.md");
        expect(changedDocs).toContain("file:c.md");

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

    it("catchup timeout message is classified as timeout kind", () => {
        // The catchup loop throws "Catchup timed out" when 60s pass
        // with no progress. Verify this message classifies correctly.
        const engine = makeSyncEngine(makeMockLocalDb(), makeMockClient());
        const detail = (engine as any).classifyError(new Error("Catchup timed out"));
        expect(detail.kind).toBe("timeout");
        engine.stop();
    });
});

describe("SyncEngine live sync", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("pull loop fires onChange for pulled docs and transitions syncing->connected", async () => {
        const doc1 = fakeDoc("file:live-a.md");

        const mockClient = makeMockClient({
            changesLongpoll: makeLongpollMock(1, {
                results: [{ id: "file:live-a.md", seq: "5", doc: doc1 }],
                last_seq: "5",
            }),
        });
        const localDb = makeMockLocalDb();
        const engine = makeSyncEngine(localDb, mockClient);

        const changedDocs: string[] = [];
        engine.onChange((doc) => changedDocs.push((doc as any)._id));

        const pausedCalls: boolean[] = [];
        engine.onPaused(() => pausedCalls.push(true));

        await engine.start();
        await new Promise((r) => setTimeout(r, 100));

        expect(changedDocs).toContain("file:live-a.md");
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

        const engine = makeSyncEngine(localDb, mockClient);
        await engine.start();

        // Wait for push loop to complete its first iteration.
        const before = Date.now();
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

describe("SyncEngine health probing", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("probe success does not change state (pure health check)", async () => {
        const mockClient = makeMockClient();
        const engine = makeSyncEngine(makeMockLocalDb(), mockClient);

        (engine as any).client = mockClient;
        (engine as any).running = true;
        (engine as any).setState("connected");

        await (engine as any).probeHealth();

        // Probe only updates lastHealthyAt — no state transitions.
        expect(engine.getState()).toBe("connected");
        engine.stop();
    });

    it("probe success during syncing stays syncing", async () => {
        const mockClient = makeMockClient();
        const engine = makeSyncEngine(makeMockLocalDb(), mockClient);

        (engine as any).client = mockClient;
        (engine as any).running = true;
        (engine as any).setState("syncing");

        await (engine as any).probeHealth();

        expect(engine.getState()).toBe("syncing");
        engine.stop();
    });

    it("probe failure -> hard error", async () => {
        const mockClient = makeMockClient({
            info: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
        });
        const engine = makeSyncEngine(makeMockLocalDb(), mockClient);

        (engine as any).client = mockClient;
        (engine as any).running = true;
        (engine as any).setState("connected");

        await (engine as any).probeHealth();

        expect(engine.getState()).toBe("error");
        expect(engine.getLastErrorDetail()?.kind).toBe("network");
        engine.stop();
    });

    it("probe deduplication: concurrent callers share one Promise", async () => {
        let infoCalls = 0;
        let resolveInfo: () => void = () => {};
        const mockClient = makeMockClient({
            info: vi.fn().mockImplementation(() => {
                infoCalls++;
                return new Promise<DbInfo>((res) => {
                    resolveInfo = () => res({ db_name: "test", doc_count: 0, update_seq: "0" });
                });
            }),
        });
        const engine = makeSyncEngine(makeMockLocalDb(), mockClient);

        (engine as any).client = mockClient;
        (engine as any).running = true;
        (engine as any).setState("connected");

        const probes = [
            (engine as any).probeHealth(),
            (engine as any).probeHealth(),
            (engine as any).probeHealth(),
        ];
        expect(infoCalls).toBe(1);

        const first = probes[0];
        for (const p of probes) expect(p).toBe(first);

        resolveInfo();
        const results = await Promise.all(probes);
        for (const r of results) expect(r).toBe(true);

        expect(infoCalls).toBe(1);
        engine.stop();
    });

    it("probe success updates lastHealthyAt", async () => {
        const mockClient = makeMockClient();
        const engine = makeSyncEngine(makeMockLocalDb(), mockClient);

        (engine as any).client = mockClient;
        (engine as any).running = true;
        (engine as any).lastHealthyAt = 0;
        (engine as any).setState("connected");

        const before = Date.now();
        await (engine as any).probeHealth();
        const after = Date.now();

        expect(engine.getLastHealthyAt()).toBeGreaterThanOrEqual(before);
        expect(engine.getLastHealthyAt()).toBeLessThanOrEqual(after);
        engine.stop();
    });

    it("probe timeout (5s) enters hard error", async () => {
        vi.useFakeTimers();
        try {
            const mockClient = makeMockClient({
                info: vi.fn().mockImplementation(() => new Promise(() => {})),
            });
            const engine = makeSyncEngine(makeMockLocalDb(), mockClient);

            (engine as any).client = mockClient;
            (engine as any).running = true;
            (engine as any).setState("syncing");

            const probePromise = (engine as any).probeHealth();
            await vi.advanceTimersByTimeAsync(5_001);
            await probePromise;

            expect(engine.getState()).toBe("error");
            engine.stop();
        } finally { vi.useRealTimers(); }
    });

    it("checkHealth skips probe in reconnecting/error states", async () => {
        const mockClient = makeMockClient();
        const engine = makeSyncEngine(makeMockLocalDb(), mockClient);

        (engine as any).client = mockClient;
        (engine as any).running = true;

        (engine as any).setState("reconnecting");
        await (engine as any).checkHealth();
        expect(mockClient.info).not.toHaveBeenCalled();

        (engine as any).enterHardError({ kind: "network", message: "down" });
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

describe("SyncEngine one-shot operations", () => {
    it("testConnectionWith returns error string on unreachable server", async () => {
        const engine = makeSyncEngine(makeMockLocalDb(), makeMockClient());

        const result = await engine.testConnectionWith(
            "http://test.invalid", "user", "pass", "db",
        );
        expect(typeof result).toBe("string");
        engine.stop();
    });
});
