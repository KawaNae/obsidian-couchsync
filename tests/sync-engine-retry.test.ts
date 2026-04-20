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
import { describe, it, expect, afterEach, beforeAll } from "vitest";
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
        expect(backoff.nextDelay()).toBe(2_000);
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
});
