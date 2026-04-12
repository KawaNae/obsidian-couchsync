import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import PouchDB from "pouchdb";
import memoryAdapter from "pouchdb-adapter-memory";
import type { CouchSyncDoc } from "../src/types.ts";
import type { CouchSyncSettings } from "../src/settings.ts";

PouchDB.plugin(memoryAdapter);

// Stub browser globals that pouchdb-browser and Replicator reference at
// module load / in start(). Must run before the dynamic import below.
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

// Dynamic import so the stubs above are in place before pouchdb-browser
// (transitive dependency of Replicator) is evaluated.
let Replicator: typeof import("../src/db/replicator.ts").Replicator;
beforeAll(async () => {
    ({ Replicator } = await import("../src/db/replicator.ts"));
});

const dummySettings = (): CouchSyncSettings => ({
    couchdbUri: "http://test.invalid",
    couchdbUser: "",
    couchdbPassword: "",
    couchdbDbName: "test",
    couchdbConfigDbName: "",
} as any);

function makeLocalShim(db: PouchDB.Database<CouchSyncDoc>) {
    return { getDb: () => db } as any;
}

/** Builds a Replicator whose prepareRemoteDb() is overridden to return the
 *  given memory PouchDB. Bypasses getRemoteUrl() entirely. */
function makeReplicator(
    local: PouchDB.Database<CouchSyncDoc>,
    remoteFactory: () => PouchDB.Database<CouchSyncDoc>,
): Replicator {
    const r = new Replicator(makeLocalShim(local), dummySettings, false);
    (r as any).prepareRemoteDb = remoteFactory;
    return r;
}

describe("Replicator lifecycle reliability", () => {
    let local: PouchDB.Database<CouchSyncDoc>;
    let remote: PouchDB.Database<CouchSyncDoc>;

    beforeEach(() => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        local = new PouchDB(`rel-local-${id}`, { adapter: "memory" });
        remote = new PouchDB(`rel-remote-${id}`, { adapter: "memory" });
    });

    afterEach(async () => {
        try { await local.destroy(); } catch { /* ignore */ }
        try { await remote.destroy(); } catch { /* ignore */ }
    });

    it("catchup sets lastHealthyAt so status bar shows 'just now' on resume", async () => {
        const r = makeReplicator(local, () => remote);
        expect(r.getLastHealthyAt()).toBe(0);

        const before = Date.now();
        await r.start();
        const after = Date.now();

        const healthyAt = r.getLastHealthyAt();
        expect(healthyAt).toBeGreaterThanOrEqual(before);
        expect(healthyAt).toBeLessThanOrEqual(after);
        r.stop();
    });

    it("concurrent start() calls share one in-flight catchup (dedup)", async () => {
        const replicateSpy = vi.spyOn(local.replicate, "from");
        const r = makeReplicator(local, () => remote);

        await Promise.all([r.start(), r.start(), r.start()]);

        // Only one catchup replicate was kicked off. (The subsequent live
        // db.sync() doesn't go through replicate.from.)
        expect(replicateSpy).toHaveBeenCalledTimes(1);
        r.stop();
        replicateSpy.mockRestore();
    });

    it("stop() while catchup is in-flight cancels the running replication", async () => {
        // Fake replication that never settles on its own — exposes
        // whether Replicator actually calls cancel() on teardown.
        const listeners: Record<string, ((arg?: any) => void)[]> = {};
        const fakeRep: any = {
            on(event: string, fn: (arg?: any) => void) {
                (listeners[event] ||= []).push(fn);
                return this;
            },
            cancel: vi.fn(() => {
                // Mimic PouchDB: cancel triggers a complete event with
                // cancelled flag; our handler resolves on complete.
                for (const fn of listeners["complete"] ?? []) fn({ docs_read: 0, last_seq: 0 });
            }),
        };
        vi.spyOn(local.replicate, "from").mockReturnValue(fakeRep);

        const r = makeReplicator(local, () => remote);
        // Kick off start() but don't await — catchup is now blocked on
        // the fake rep that never fires change/complete by itself.
        const startPromise = r.start();
        // Give the microtask queue a chance to reach the `await catchupPull`.
        await Promise.resolve();

        r.stop();
        await startPromise;

        expect(fakeRep.cancel).toHaveBeenCalled();
    });

    it("catchup idle-timeouts after 60s of no progress", async () => {
        vi.useFakeTimers();
        try {
            // Fake replication that never fires change/complete/error.
            const fakeRep: any = {
                on() { return this; },
                cancel: vi.fn(),
            };
            vi.spyOn(local.replicate, "from").mockReturnValue(fakeRep);

            const r = makeReplicator(local, () => remote);
            const startPromise = r.start();

            // Advance past the 60s idle timeout (the replicator uses 60000ms).
            await vi.advanceTimersByTimeAsync(61_000);
            await startPromise;

            expect(fakeRep.cancel).toHaveBeenCalled();
            expect(r.getState()).toBe("error");
            // Timeout classification should surface as `Error (timeout)`.
            const detail = r.getLastErrorDetail();
            expect(detail?.kind).toBe("timeout");
            r.stop();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("Replicator error classification & routing", () => {
    let local: PouchDB.Database<CouchSyncDoc>;
    let remote: PouchDB.Database<CouchSyncDoc>;

    beforeEach(() => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        local = new PouchDB(`rel-err-local-${id}`, { adapter: "memory" });
        remote = new PouchDB(`rel-err-remote-${id}`, { adapter: "memory" });
    });

    afterEach(async () => {
        try { await local.destroy(); } catch { /* ignore */ }
        try { await remote.destroy(); } catch { /* ignore */ }
    });

    it("classifyError: HTTP status and message heuristics", () => {
        const r = makeReplicator(local, () => remote);
        const classify = (err: any) => (r as any).classifyError(err);

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

        // code is preserved in the detail for status-bar display.
        expect(classify({ status: 503, message: "down" }).code).toBe(503);
    });

    it("transient error stays in reconnecting, escalates after TRANSIENT_ESCALATION_MS", async () => {
        vi.useFakeTimers();
        try {
            const r = makeReplicator(local, () => remote);
            // Bypass start() so we don't need a live PouchDB session.
            // We're only testing the timer-driven escalation path.
            (r as any).handleTransientError({ message: "ECONNREFUSED" });

            // Should be in reconnecting, not error yet.
            expect(r.getState()).toBe("reconnecting");
            expect(r.getLastErrorDetail()).toBeNull();

            // Just before escalation — still transient.
            await vi.advanceTimersByTimeAsync(9_999);
            expect(r.getState()).toBe("reconnecting");

            // Stop the error retry chain before it fires (we're just
            // asserting the escalation to hard error here).
            const retrySpy = vi.spyOn(r as any, "requestReconnect").mockResolvedValue(undefined);

            // Cross the threshold → escalates.
            await vi.advanceTimersByTimeAsync(2);
            expect(r.getState()).toBe("error");
            expect(r.getLastErrorDetail()?.kind).toBe("network");

            retrySpy.mockRestore();
            r.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it("transient error that recovers before escalation stays invisible", async () => {
        vi.useFakeTimers();
        try {
            const r = makeReplicator(local, () => remote);
            (r as any).handleTransientError({ message: "ECONNREFUSED" });
            expect(r.getState()).toBe("reconnecting");

            // Simulate PouchDB recovering (change event would fire setState).
            (r as any).setState("syncing");

            // The escalation timer should have been cancelled.
            expect((r as any).transientErrorTimer).toBeNull();

            // Advance past the escalation threshold — should NOT escalate.
            await vi.advanceTimersByTimeAsync(11_000);
            expect(r.getState()).toBe("syncing");
            expect(r.getLastErrorDetail()).toBeNull();
            r.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it("hard error fires backoff retry on the documented schedule", async () => {
        vi.useFakeTimers();
        try {
            const r = makeReplicator(local, () => remote);
            const retrySpy = vi
                .spyOn(r as any, "requestReconnect")
                .mockResolvedValue(undefined);

            (r as any).enterHardError({ kind: "network", message: "fake down" });

            // First retry at 2s.
            expect(retrySpy).toHaveBeenCalledTimes(0);
            await vi.advanceTimersByTimeAsync(2_000);
            expect(retrySpy).toHaveBeenCalledTimes(1);
            expect(retrySpy).toHaveBeenLastCalledWith("retry-backoff");

            // State is still error → chain re-schedules at delays[1] = 5s.
            await vi.advanceTimersByTimeAsync(5_000);
            expect(retrySpy).toHaveBeenCalledTimes(2);

            // delays[2] = 10s.
            await vi.advanceTimersByTimeAsync(10_000);
            expect(retrySpy).toHaveBeenCalledTimes(3);

            retrySpy.mockRestore();
            r.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it("successful recovery resets the backoff step to 0", async () => {
        vi.useFakeTimers();
        try {
            const r = makeReplicator(local, () => remote);
            const retrySpy = vi
                .spyOn(r as any, "requestReconnect")
                .mockResolvedValue(undefined);

            (r as any).enterHardError({ kind: "network", message: "fake" });
            await vi.advanceTimersByTimeAsync(2_000); // fires at step 0
            await vi.advanceTimersByTimeAsync(5_000); // fires at step 1
            expect((r as any).errorRetryStep).toBe(2);

            // Simulate recovery.
            (r as any).setState("connected");
            expect((r as any).errorRetryStep).toBe(0);
            expect((r as any).errorRetryTimer).toBeNull();

            // Another error → should restart from 2s.
            retrySpy.mockClear();
            (r as any).enterHardError({ kind: "network", message: "fake again" });
            await vi.advanceTimersByTimeAsync(2_000);
            expect(retrySpy).toHaveBeenCalledTimes(1);

            retrySpy.mockRestore();
            r.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it("auth error does not schedule backoff retries (latch)", async () => {
        vi.useFakeTimers();
        try {
            const r = makeReplicator(local, () => remote);
            const retrySpy = vi
                .spyOn(r as any, "requestReconnect")
                .mockResolvedValue(undefined);

            (r as any).enterHardError({
                kind: "auth",
                code: 401,
                message: "Authentication failed (401).",
            });

            expect(r.getState()).toBe("error");
            expect((r as any).errorRetryTimer).toBeNull();
            expect((r as any).authError).toBe(true);

            // Nothing should fire even well past the schedule.
            await vi.advanceTimersByTimeAsync(60_000);
            expect(retrySpy).not.toHaveBeenCalled();

            retrySpy.mockRestore();
            r.stop();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("Replicator healthy-signal guards (asymmetric fault)", () => {
    let local: PouchDB.Database<CouchSyncDoc>;
    let remote: PouchDB.Database<CouchSyncDoc>;

    beforeEach(() => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        local = new PouchDB(`rel-sig-local-${id}`, { adapter: "memory" });
        remote = new PouchDB(`rel-sig-remote-${id}`, { adapter: "memory" });
    });

    afterEach(async () => {
        try { await local.destroy(); } catch { /* ignore */ }
        try { await remote.destroy(); } catch { /* ignore */ }
    });

    async function waitForProbe(r: InstanceType<typeof Replicator>): Promise<void> {
        for (let i = 0; i < 100; i++) {
            const p = (r as any).probePromise;
            if (p) { await p.catch(() => {}); return; }
            await new Promise((res) => setTimeout(res, 5));
        }
    }

    it("handlePaused(no err) while state=reconnecting promotes via probe", async () => {
        const r = makeReplicator(local, () => remote);
        await r.start();
        (r as any).handleTransientError({ message: "ECONNREFUSED" });
        expect(r.getState()).toBe("reconnecting");

        await (r as any).handlePaused(undefined);

        // Probe succeeds (real memory remote) → reconnecting → syncing,
        // then pausedPending drives syncing → connected + callbacks.
        expect(r.getState()).toBe("connected");
        r.stop();
    });

    it("handlePaused(no err) while state=error does NOT transition to connected", async () => {
        const r = makeReplicator(local, () => remote);
        await r.start();
        (r as any).enterHardError({ kind: "network", message: "fake" });
        expect(r.getState()).toBe("error");

        await (r as any).handlePaused(undefined);

        // Probe succeeds (real memory remote) but error state is
        // preserved — recovery goes through backoff retry only.
        expect(r.getState()).toBe("error");
        r.stop();
    });

    it("handlePaused(no err) from state=syncing kicks probe → connected", async () => {
        const r = makeReplicator(local, () => remote);
        await r.start();
        (r as any).setState("syncing");
        expect(r.getState()).toBe("syncing");

        await (r as any).handlePaused(undefined);

        expect(r.getState()).toBe("connected");
        r.stop();
    });

    it("handlePaused(no err) from syncing updates lastHealthyAt via probe", async () => {
        const r = makeReplicator(local, () => remote);
        await r.start();
        const baseline = r.getLastHealthyAt();
        await new Promise((res) => setTimeout(res, 15));

        (r as any).setState("syncing");
        await (r as any).handlePaused(undefined);

        expect(r.getState()).toBe("connected");
        expect(r.getLastHealthyAt()).toBeGreaterThan(baseline);
        r.stop();
    });
});

describe("Replicator active health probe", () => {
    let local: PouchDB.Database<CouchSyncDoc>;
    let remote: PouchDB.Database<CouchSyncDoc>;

    beforeEach(() => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        local = new PouchDB(`rel-probe-local-${id}`, { adapter: "memory" });
        remote = new PouchDB(`rel-probe-remote-${id}`, { adapter: "memory" });
    });

    afterEach(async () => {
        try { await local.destroy(); } catch { /* ignore */ }
        try { await remote.destroy(); } catch { /* ignore */ }
    });

    async function waitForProbe(r: InstanceType<typeof Replicator>): Promise<void> {
        for (let i = 0; i < 100; i++) {
            if (!(r as any).probeInFlight) return;
            await new Promise((res) => setTimeout(res, 5));
        }
        throw new Error("probe did not settle within 500ms");
    }

    it("probe success in connected state updates lastHealthyAt", async () => {
        const r = makeReplicator(local, () => remote);
        await r.start();
        // After start(), state is connected and lastHealthyAt was set by
        // catchup. Reset lastHealthyAt so we can observe a fresh update.
        (r as any).lastHealthyAt = 0;
        (r as any).setState("connected");

        await (r as any).checkHealth();

        expect(r.getLastHealthyAt()).toBeGreaterThan(0);
        expect(r.getState()).toBe("connected");
        r.stop();
    });

    it("probe success from syncing stays syncing without pausedPending", async () => {
        const r = makeReplicator(local, () => remote);
        await r.start();
        (r as any).setState("syncing");

        await (r as any).probeHealth();

        expect(r.getState()).toBe("syncing");
        r.stop();
    });

    it("probe success from syncing with pausedPending promotes to connected", async () => {
        const r = makeReplicator(local, () => remote);
        await r.start();
        (r as any).setState("syncing");
        (r as any).pausedPending = true;

        await (r as any).probeHealth();

        expect(r.getState()).toBe("connected");
        expect((r as any).pausedPending).toBe(false);
        r.stop();
    });

    it("probe failure enters hard error immediately (no transient window)", async () => {
        const r = makeReplicator(local, () => remote);
        await r.start();
        (r as any).remoteDb = {
            info: () => Promise.reject(new Error("ECONNREFUSED")),
            close: () => Promise.resolve(),
        };
        (r as any).setState("connected");
        const baseline = r.getLastHealthyAt();

        await (r as any).checkHealth();

        // Fresh HTTP failure → enterHardError directly, NOT reconnecting.
        expect(r.getState()).toBe("error");
        expect(r.getLastErrorDetail()?.kind).toBe("network");
        expect((r as any).errorRetryTimer).not.toBeNull();
        expect(r.getLastHealthyAt()).toBe(baseline);
        r.stop();
    });

    it("probe timeout (5s) enters hard error immediately", async () => {
        vi.useFakeTimers();
        try {
            const r = makeReplicator(local, () => remote);
            await r.start();
            (r as any).remoteDb = {
                info: () => new Promise(() => { /* hang forever */ }),
                close: () => Promise.resolve(),
            };
            (r as any).setState("syncing");

            const checkPromise = (r as any).checkHealth();
            await vi.advanceTimersByTimeAsync(5_001);
            await checkPromise;

            expect(r.getState()).toBe("error");
            r.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it("checkHealth skips probe in reconnecting/error, reconnects in disconnected", async () => {
        const r = makeReplicator(local, () => remote);
        await r.start();

        let infoCalls = 0;
        (r as any).remoteDb = {
            info: () => { infoCalls++; return Promise.resolve({}); },
            close: () => Promise.resolve(),
        };

        (r as any).setState("reconnecting");
        await (r as any).checkHealth();
        expect(infoCalls).toBe(0);

        (r as any).enterHardError({ kind: "network", message: "down" });
        await (r as any).checkHealth();
        expect(infoCalls).toBe(0);

        const reconnectSpy = vi
            .spyOn(r as any, "requestReconnect")
            .mockResolvedValue(undefined);
        (r as any).setState("disconnected");
        await (r as any).checkHealth();
        expect(infoCalls).toBe(0);
        expect(reconnectSpy).toHaveBeenCalledWith("periodic-tick");

        reconnectSpy.mockRestore();
        r.stop();
    });

    it("probe success from reconnecting promotes to syncing", async () => {
        const r = makeReplicator(local, () => remote);
        await r.start();
        (r as any).handleTransientError({ message: "ECONNREFUSED" });
        expect(r.getState()).toBe("reconnecting");

        await (r as any).probeHealth();

        expect(r.getState()).toBe("syncing");
        r.stop();
    });

    it("change event kicks a probe (deterministic lastHealthyAt update)", async () => {
        const r = makeReplicator(local, () => remote);
        await r.start();
        await new Promise((res) => setTimeout(res, 50));
        (r as any).lastHealthyAt = 1;

        const sync: any = (r as any).sync;
        sync.emit("change", {
            direction: "pull",
            change: { ok: true, docs_written: 1, doc_write_failures: 0, docs: [] },
        });
        // Grab probePromise synchronously — the polling waitForProbe
        // races with PouchDB's own async events (paused fires after
        // change, triggering its own probe that clears ours).
        const p = (r as any).probePromise;
        expect(p).toBeTruthy();
        await p;

        expect(r.getLastHealthyAt()).toBeGreaterThan(1);
        r.stop();
    });

    it("probe in flight deduplicates concurrent callers via shared promise", async () => {
        const r = makeReplicator(local, () => remote);
        await r.start();

        let infoCalls = 0;
        let resolveInfo: () => void = () => {};
        (r as any).remoteDb = {
            info: () => {
                infoCalls++;
                return new Promise<any>((res) => {
                    resolveInfo = () => res({});
                });
            },
            close: () => Promise.resolve(),
        };
        (r as any).setState("connected");

        const probes = [
            (r as any).probeHealth(),
            (r as any).probeHealth(),
            (r as any).probeHealth(),
            (r as any).probeHealth(),
            (r as any).probeHealth(),
        ];
        expect(infoCalls).toBe(1);

        // All callers share the same Promise.
        const first = probes[0];
        for (const p of probes) expect(p).toBe(first);

        resolveInfo();
        const results = await Promise.all(probes);
        for (const r of results) expect(r).toBe(true);

        expect(infoCalls).toBe(1);
        r.stop();
    });

    it("change event → probe failure escalates straight to hard error", async () => {
        const r = makeReplicator(local, () => remote);
        await r.start();
        await new Promise((res) => setTimeout(res, 50));
        (r as any).remoteDb = {
            info: () => Promise.reject(new Error("ECONNREFUSED")),
            close: () => Promise.resolve(),
        };
        (r as any).setState("connected");

        const sync: any = (r as any).sync;
        sync.emit("change", {
            direction: "push",
            change: { ok: true, docs_written: 1, doc_write_failures: 0, docs: [] },
        });
        const p = (r as any).probePromise;
        expect(p).toBeTruthy();
        await p.catch(() => {});

        expect(r.getState()).toBe("error");
        expect(r.getLastErrorDetail()?.kind).toBe("network");
        r.stop();
    });

    it("probe failure clears pausedPending to prevent stale callback fires", async () => {
        const r = makeReplicator(local, () => remote);
        await r.start();
        (r as any).remoteDb = {
            info: () => Promise.reject(new Error("ECONNREFUSED")),
            close: () => Promise.resolve(),
        };
        (r as any).setState("syncing");
        (r as any).pausedPending = true;

        await (r as any).probeHealth();

        expect(r.getState()).toBe("error");
        expect((r as any).pausedPending).toBe(false);
        r.stop();
    });

    it("handlePaused gates callbacks on probe completion", async () => {
        const r = makeReplicator(local, () => remote);
        await r.start();
        (r as any).setState("syncing");

        const callOrder: string[] = [];
        r.onPaused(() => callOrder.push("paused"));

        await (r as any).handlePaused(undefined);

        expect(r.getState()).toBe("connected");
        expect(callOrder).toEqual(["paused"]);
        r.stop();
    });

    it("handlePaused with probe failure does not fire callbacks", async () => {
        const r = makeReplicator(local, () => remote);
        await r.start();
        (r as any).remoteDb = {
            info: () => Promise.reject(new Error("ECONNREFUSED")),
            close: () => Promise.resolve(),
        };
        (r as any).setState("syncing");

        const pausedCalled: boolean[] = [];
        r.onPaused(() => pausedCalled.push(true));

        await (r as any).handlePaused(undefined);

        expect(r.getState()).toBe("error");
        expect(pausedCalled).toEqual([]);
        r.stop();
    });
});
