/**
 * SyncEngine retry supervisor tests.
 *
 * These verify the structural invariants that replaced the v0.15.x
 * infinite-retry storm:
 *
 *   I1  enterError(network) schedules a retry timer using BackoffSchedule
 *       delays and does NOT reset the step.
 *   I2  setState("reconnecting" → "syncing") during normal bring-up must
 *       not reset the backoff step (the v0.15.x bug).
 *   I3  A successful catchup is the ONLY path that resets the step.
 *   I4  enterError is the single owner of the retry timer; a repeated
 *       enterError call re-schedules rather than spawning a second timer.
 *   I5  enterError(auth) raises the latch and stops the retry timer.
 *   I6  handleDegraded pins error state, halts retries, and makes further
 *       enterError calls a no-op.
 */

import "fake-indexeddb/auto";
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { createSyncHarness, type SyncHarness } from "./harness/sync-harness.ts";
import { DbError } from "../src/db/write-transaction.ts";

const noop = () => {};
beforeAll(() => {
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
});

describe("SyncEngine retry supervisor", () => {
    let h: SyncHarness;

    afterEach(async () => {
        if (h) await h.destroyAll();
    });

    it("fresh engine starts with backoff step 0", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        const backoff = (a.engine as any).backoff;
        expect(backoff.currentStep).toBe(0);
        expect(backoff.nextDelay()).toBe(1_000);
    });

    it("successful catchup leaves backoff step at 0 (I3)", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        await a.engine.start();
        expect(a.engine.getState()).toBe("connected");
        const backoff = (a.engine as any).backoff;
        expect(backoff.currentStep).toBe(0);
        a.engine.stop();
    });

    it("setState('reconnecting' → 'syncing') does NOT reset step (I2)", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        const backoff = (a.engine as any).backoff;

        // Pre-bump to step 3 to simulate a session recovering from earlier
        // transient errors.
        backoff.recordFailure();
        backoff.recordFailure();
        backoff.recordFailure();
        expect(backoff.currentStep).toBe(3);

        // Legal transitions during bring-up: reconnecting → syncing.
        (a.engine as any).setState("reconnecting");
        (a.engine as any).setState("syncing");
        expect(backoff.currentStep).toBe(3);

        // Now reaching connected via the official bring-up path triggers
        // recordSuccess once, resetting the step.
        (a.engine as any).setState("connected");
        // setState itself never resets; openSession/startLive's own call
        // to backoff.recordSuccess() does. Simulate that final step.
        backoff.recordSuccess();
        expect(backoff.currentStep).toBe(0);
    });

    it("enterError(network) advances step and schedules one retry timer (I1, I4)", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        const backoff = (a.engine as any).backoff;

        (a.engine as any).enterError({ kind: "network", message: "down" });
        expect(a.engine.getState()).toBe("error");
        expect(backoff.currentStep).toBe(1);
        expect((a.engine as any).retryTimer).not.toBeNull();

        const firstTimer = (a.engine as any).retryTimer;

        // Second enterError cancels the first timer and lays a new one.
        (a.engine as any).enterError({ kind: "network", message: "still down" });
        expect(backoff.currentStep).toBe(2);
        const secondTimer = (a.engine as any).retryTimer;
        expect(secondTimer).not.toBeNull();
        expect(secondTimer).not.toBe(firstTimer);
    });

    it("first retry after a fresh error fires at the 1s Fibonacci head, not 5s (resume-recovery fix)", async () => {
        // Regression for the schedule-before-record ordering bug: enterError
        // must schedule the retry using the step-0 delay (1s) BEFORE advancing
        // the backoff. Recording first skipped delays[0] and made the first
        // mobile-resume retry land at 5s, delaying recovery (and flush of
        // local edits) on every app foreground.
        h = createSyncHarness();
        const a = h.addDevice("dev-A");

        const realSetTimeout = globalThis.setTimeout;
        const scheduled: number[] = [];
        (globalThis as any).setTimeout = ((fn: any, ms?: number) => {
            scheduled.push(ms ?? 0);
            // Hand back a real (far-future, no-op) handle so stopRetryTimer /
            // stop() can clear it; never actually fire the retry here.
            return realSetTimeout(() => {}, 1_000_000);
        }) as any;
        try {
            (a.engine as any).enterError({ kind: "network", message: "down" });
        } finally {
            (globalThis as any).setTimeout = realSetTimeout;
        }

        expect(scheduled).toContain(1_000);
        expect(scheduled).not.toContain(5_000);
        // The failure was still recorded — step advanced exactly one.
        expect((a.engine as any).backoff.currentStep).toBe(1);
        a.engine.stop();
    });

    it("verify: suspend-frozen abort is inconclusive — re-verifies silently, no hard error (#1b/#6/#7)", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        await a.engine.start();
        expect(a.engine.getState()).toBe("connected");

        // A single probe whose wall-clock dwarfs the per-attempt timeout is the
        // signature of a background freeze (the OS froze the process mid-fetch),
        // not a genuine timeout. Model it with fake timers: the probe rejects
        // AbortError after 10s of wall-clock have elapsed within one attempt.
        vi.useFakeTimers();
        try {
            (a.engine as any).session.client.info = () => {
                vi.setSystemTime(Date.now() + 10_000);
                return Promise.reject(
                    Object.assign(new Error("The operation was aborted."), { name: "AbortError" }),
                );
            };
            const ok = await (a.engine as any).verifyReachable(1, "app-resume");
            expect(ok).toBe(false);
        } finally {
            vi.useRealTimers();
        }

        // The key invariant: a suspend-abort must NOT enter the hard error
        // state (which produced the spurious "Server unreachable" toast and
        // the connected→error churn). It stays reconnecting and schedules a
        // silent re-verify.
        expect(a.engine.getState()).toBe("reconnecting");
        expect((a.engine as any).retryTimer).not.toBeNull();
        a.engine.stop();
    });

    it("verify: every probe failing until budget exhaustion enters a network error (#1b contrast)", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        await a.engine.start();

        vi.useFakeTimers();
        let attempts = 0;
        try {
            (a.engine as any).session.client.info = () => {
                attempts++;
                // Each probe is aborted at the 3s per-attempt ceiling — a
                // genuinely unreachable server, not a freeze (elapsed ≈ ceiling).
                vi.setSystemTime(Date.now() + 3_000);
                return Promise.reject(
                    Object.assign(new Error("The operation was aborted."), { name: "AbortError" }),
                );
            };
            await (a.engine as any).verifyReachable(1, "app-resume");
        } finally {
            vi.useRealTimers();
        }
        // 15s budget / 3s per attempt → 5 probes, then a hard network error.
        expect(attempts).toBe(5);
        expect(a.engine.getState()).toBe("error");
        expect((a.engine as any).lastErrorDetail?.kind).toBe("network");
        a.engine.stop();
    });

    it("verify: abandons a stuck probe and succeeds on a fresh re-probe (dead-socket recovery)", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        await a.engine.start();

        vi.useFakeTimers();
        let attempts = 0;
        let result: boolean | undefined;
        try {
            (a.engine as any).session.client.info = () => {
                attempts++;
                if (attempts === 1) {
                    // First probe rides the suspend-killed socket: aborted at
                    // the 3s ceiling (elapsed ≈ ceiling, so NOT a freeze).
                    vi.setSystemTime(Date.now() + 3_000);
                    return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
                }
                // Fresh probe connects immediately.
                return Promise.resolve({ db_name: "fake", doc_count: 0, update_seq: 0 });
            };
            result = await (a.engine as any).verifyReachable(1, "app-resume");
        } finally {
            vi.useRealTimers();
        }
        expect(attempts).toBe(2);
        expect(result).toBe(true);
        expect(a.engine.getState()).not.toBe("error");
        a.engine.stop();
    });

    it("verify: a live-but-slow probe under the per-attempt ceiling succeeds in one attempt (no regression)", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        await a.engine.start();

        vi.useFakeTimers();
        let attempts = 0;
        let result: boolean | undefined;
        try {
            (a.engine as any).session.client.info = () => {
                attempts++;
                // 2s — slower than typical but well under the 3s ceiling, so it
                // must NOT be falsely abandoned.
                vi.setSystemTime(Date.now() + 2_000);
                return Promise.resolve({ db_name: "fake", doc_count: 0, update_seq: 0 });
            };
            result = await (a.engine as any).verifyReachable(1, "app-resume");
        } finally {
            vi.useRealTimers();
        }
        expect(attempts).toBe(1);
        expect(result).toBe(true);
        a.engine.stop();
    });

    it("verify: fast-failing probes are spaced, bounding the attempt count within budget", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        await a.engine.start();

        vi.useFakeTimers();
        let attempts = 0;
        try {
            (a.engine as any).session.client.info = () => {
                attempts++;
                // Network momentarily down: fetch rejects instantly.
                return Promise.reject(new Error("Failed to fetch"));
            };
            const p = (a.engine as any).verifyReachable(1, "app-resume");
            // Drive the ~1s inter-probe spacing across the whole 15s budget.
            await vi.advanceTimersByTimeAsync(15_000);
            await p;
        } finally {
            vi.useRealTimers();
        }
        // ~1 probe/second over 15s — bounded, NOT a tight fetch busy-loop.
        expect(attempts).toBeGreaterThan(10);
        expect(attempts).toBeLessThanOrEqual(16);
        expect(a.engine.getState()).toBe("error");
        expect((a.engine as any).lastErrorDetail?.kind).toBe("network");
        a.engine.stop();
    });

    it("verify: a server-answered failure (auth) bails immediately without re-probing", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        await a.engine.start();

        let attempts = 0;
        (a.engine as any).session.client.info = () => {
            attempts++;
            return Promise.reject(Object.assign(new Error("unauthorized"), { status: 401 }));
        };
        const result = await (a.engine as any).verifyReachable(1, "app-resume");
        expect(attempts).toBe(1);
        expect(result).toBe(false);
        // auth is terminal — re-probing can't help, and the latch must respond.
        expect(a.engine.getState()).toBe("error");
        expect((a.engine as any).lastErrorDetail?.kind).toBe("auth");
        a.engine.stop();
    });

    it("enterError(encryption-paused) is terminal: stops retries, no auto-recovery (#1c)", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");

        (a.engine as any).enterError({ kind: "encryption-paused", message: "wrong passphrase" });
        expect(a.engine.getState()).toBe("error");
        expect((a.engine as any).retryTimer).toBeNull();
    });

    it("watchdog leaves TERMINAL error states alone — no 30s re-kick of schema-mismatch/encryption-paused (regression)", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        const reconnectSpy = vi
            .spyOn(a.engine as any, "requestReconnect")
            .mockResolvedValue(undefined);

        for (const kind of ["schema-mismatch", "encryption-paused"] as const) {
            (a.engine as any).enterError({ kind, message: `${kind} terminal` });
            expect(a.engine.getState()).toBe("error");
            expect((a.engine as any).retryTimer).toBeNull(); // terminal: no retry by design
            reconnectSpy.mockClear();
            // The watchdog sees "error + no retry timer" but MUST NOT resurrect
            // a terminal state (that re-toasted the migration/pause Notice and
            // probed the server every health interval forever).
            await (a.engine as any).checkHealth();
            expect(reconnectSpy.mock.calls.length).toBe(0);
        }
        reconnectSpy.mockRestore();
    });

    it("openSession gate: a stop() during the encryption gate await aborts — no zombie session (regression)", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");

        // Inject a controllable encryption gate (preCatchupCheck) so we can
        // hold openSession in the pre-session await window, then stop() mid-gate.
        let release: () => void = () => {};
        const gate = new Promise<void>((r) => { release = r; });
        (a.engine as any).preCatchupCheck = () => gate;

        // Kick openSession but don't await — it parks in the gate await.
        const opening = (a.engine as any).openSession();
        // User stops sync while the gate holds no registered session.
        a.engine.stop();
        expect((a.engine as any).session).toBeNull();
        // Gate now resolves; the post-gate generation check must abort.
        release();
        await opening;

        // The torn-down engine must NOT have built/started a live session.
        expect((a.engine as any).session).toBeNull();
        expect(a.engine.getState()).toBe("disconnected");
    });

    it("openSession gate: a stop() during a FAILING gate does not re-arm the retry timer (regression)", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");

        let reject: (e: any) => void = () => {};
        const gate = new Promise<void>((_r, rej) => { reject = rej; });
        (a.engine as any).preCatchupCheck = () => gate;

        const opening = (a.engine as any).openSession();
        a.engine.stop(); // clears timers + bumps lifecycle generation
        reject(new Error("Failed to fetch")); // transient gate failure after stop
        await opening.catch(() => {});

        // stop() cleared the retry timer; the superseded gate failure must not
        // re-arm it (that would reconnect into a closing localDb).
        expect((a.engine as any).retryTimer).toBeNull();
        expect(a.engine.getState()).toBe("disconnected");
    });

    it("enterError(auth) stops the retry timer and raises the auth latch (I5)", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");

        (a.engine as any).enterError({ kind: "auth", code: 401, message: "bad creds" });
        expect(a.engine.getState()).toBe("error");
        expect(a.engine.auth.isBlocked()).toBe(true);
        expect((a.engine as any).retryTimer).toBeNull();
    });

    it("handleDegraded pins error state and subsequent enterError is a no-op (I6)", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");

        const e = new DbError(
            "degraded",
            new Error("handle dead"),
            "handle degraded",
        );
        (a.engine as any).handleDegraded(e);
        expect(a.engine.getState()).toBe("error");
        expect((a.engine as any).degraded).toBe(true);
        expect((a.engine as any).retryTimer).toBeNull();

        // A later error cannot revive the retry loop.
        (a.engine as any).enterError({ kind: "network", message: "irrelevant" });
        expect((a.engine as any).retryTimer).toBeNull();
    });

    it("stop() halts the retry timer and resets backoff", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        const backoff = (a.engine as any).backoff;

        (a.engine as any).enterError({ kind: "network", message: "down" });
        expect((a.engine as any).retryTimer).not.toBeNull();
        expect(backoff.currentStep).toBe(1);

        a.engine.stop();
        expect((a.engine as any).retryTimer).toBeNull();
        expect(backoff.currentStep).toBe(0);
        expect(a.engine.getState()).toBe("disconnected");
    });

    it("start() after handleDegraded() clears the degraded latch", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");

        (a.engine as any).handleDegraded(
            new DbError("degraded", new Error("x"), "halt"),
        );
        expect((a.engine as any).degraded).toBe(true);

        // The user restarted sync: degraded flag must clear so the next
        // bring-up can run.
        await a.engine.start();
        expect((a.engine as any).degraded).toBe(false);
        expect(a.engine.getState()).toBe("connected");
        a.engine.stop();
    });

    // ── v0.20.3: C-chain fix ────────────────────────────────

    it("successful openSession stops a pending retry timer (C-chain fix)", async () => {
        // Scenario: enterError scheduled a retry, then an external trigger
        // (e.g. app-resume) calls restart which succeeds. The old retry
        // timer should be dead — otherwise it fires after reconnect and
        // tears the live session down for no reason.
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        await a.engine.start();
        expect(a.engine.getState()).toBe("connected");

        // Simulate a pending retry from a prior transient error.
        (a.engine as any).enterError({ kind: "network", message: "flap" });
        expect((a.engine as any).retryTimer).not.toBeNull();

        // A fresh reconnect succeeds.
        await a.engine.requestReconnect("app-resume");
        expect(a.engine.getState()).toBe("connected");

        // The old retry timer must be cancelled now that we're connected.
        expect((a.engine as any).retryTimer).toBeNull();
        a.engine.stop();
    });

    it("concurrent requestReconnect calls are serialized (in-flight guard)", async () => {
        // Without the guard, two requestReconnect calls race: both enter
        // verify-then-restart, each creates a session, and the second
        // tears down the first. Observable symptom in the field: sess#N
        // incrementing rapidly during an app-resume + retry-backoff race.
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        await a.engine.start();
        const epochBefore = (a.engine as any).sessionEpoch;

        // Fire two reconnects back-to-back from the same tick.
        await Promise.all([
            a.engine.requestReconnect("app-resume"),
            a.engine.requestReconnect("retry-backoff"),
        ]);

        const epochAfter = (a.engine as any).sessionEpoch;
        // With the guard, at most ONE new session is created.
        expect(epochAfter - epochBefore).toBeLessThanOrEqual(1);
        a.engine.stop();
    });

    it("verifyReachable re-probes hanging calls within the budget, then gives up (real timers)", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        await a.engine.start();

        // Replace session.client.info() with one that hangs forever unless its
        // signal is aborted. With the default reason (periodic-tick → 5s
        // budget), the engine abandons each stuck probe at the 3s per-attempt
        // ceiling and re-issues a fresh one, giving up when the budget runs out.
        const session = (a.engine as any).session;
        let attempts = 0;
        let gotSignal: AbortSignal | undefined;
        session.client.info = (signal?: AbortSignal) => {
            attempts++;
            gotSignal = signal;
            return new Promise((_resolve, reject) => {
                signal?.addEventListener("abort", () => {
                    const e: any = new Error("aborted");
                    e.name = "AbortError";
                    reject(e);
                });
            });
        };

        const t0 = Date.now();
        const result = await (a.engine as any).verifyReachable(99);
        const elapsed = Date.now() - t0;

        expect(result).toBe(false);
        expect(gotSignal).toBeDefined();
        // Re-probed rather than waiting out one long call.
        expect(attempts).toBeGreaterThanOrEqual(2);
        // Total bounded by the ~5s budget; must not wait the default 30s.
        expect(elapsed).toBeLessThan(7_000);
        expect(elapsed).toBeGreaterThan(3_500);
        a.engine.stop();
    }, 10_000);
});
