import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CompositionGate } from "../src/sync/composition-gate.ts";
import { FakeCompositionTracker } from "./helpers/fake-composition-tracker.ts";

describe("CompositionGate", () => {
    let tracker: FakeCompositionTracker;
    let gate: CompositionGate;

    beforeEach(() => {
        vi.useFakeTimers();
        tracker = new FakeCompositionTracker();
        gate = new CompositionGate(tracker, { timeoutMs: 30_000 });
        gate.start();
    });

    afterEach(() => {
        gate.stop();
        vi.useRealTimers();
    });

    // ── fast path ──────────────────────────────────────────

    it("runs op immediately when path is not composing", async () => {
        const fn = vi.fn(async () => "ok");
        const result = await gate.defer("a.md", fn);
        expect(result).toBe("ok");
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("propagates op return values", async () => {
        const result = await gate.defer("a.md", async () => 42);
        expect(result).toBe(42);
    });

    it("propagates op errors", async () => {
        await expect(gate.defer("a.md", async () => { throw new Error("boom"); }))
            .rejects.toThrow("boom");
    });

    // ── deferred path ──────────────────────────────────────

    it("queues op while composing and runs on compositionend", async () => {
        tracker.startComposition("a.md");
        const fn = vi.fn(async () => "deferred");

        const promise = gate.defer("a.md", fn);
        // Microtask drain
        await Promise.resolve();
        expect(fn).not.toHaveBeenCalled();
        expect(gate.pendingCount("a.md")).toBe(1);

        tracker.endComposition("a.md");
        const result = await promise;

        expect(result).toBe("deferred");
        expect(fn).toHaveBeenCalledTimes(1);
        expect(gate.pendingCount("a.md")).toBe(0);
    });

    it("preserves FIFO order across multiple defers for same path", async () => {
        tracker.startComposition("a.md");
        const log: string[] = [];

        const p1 = gate.defer("a.md", async () => { log.push("first"); });
        const p2 = gate.defer("a.md", async () => { log.push("second"); });
        const p3 = gate.defer("a.md", async () => { log.push("third"); });

        await Promise.resolve();
        expect(log).toEqual([]);

        tracker.endComposition("a.md");
        await Promise.all([p1, p2, p3]);

        expect(log).toEqual(["first", "second", "third"]);
    });

    it("isolates queues by path", async () => {
        tracker.startComposition("a.md");
        const aFn = vi.fn(async () => "a");
        const bFn = vi.fn(async () => "b");

        const aPromise = gate.defer("a.md", aFn);
        const bResult = await gate.defer("b.md", bFn);  // not composing

        expect(bResult).toBe("b");
        expect(bFn).toHaveBeenCalledTimes(1);
        expect(aFn).not.toHaveBeenCalled();

        tracker.endComposition("a.md");
        await aPromise;
        expect(aFn).toHaveBeenCalledTimes(1);
    });

    it("only drains the path whose composition ended", async () => {
        tracker.startComposition("a.md");
        tracker.startComposition("b.md");

        const aFn = vi.fn(async () => "a");
        const bFn = vi.fn(async () => "b");
        const aPromise = gate.defer("a.md", aFn);
        const bPromise = gate.defer("b.md", bFn);

        tracker.endComposition("a.md");
        await aPromise;

        expect(aFn).toHaveBeenCalledTimes(1);
        expect(bFn).not.toHaveBeenCalled();

        tracker.endComposition("b.md");
        await bPromise;
        expect(bFn).toHaveBeenCalledTimes(1);
    });

    // ── timeout safety net ─────────────────────────────────

    it("force-drains a stuck composition after timeout", async () => {
        tracker.startComposition("a.md");
        const fn = vi.fn(async () => "stuck");

        const promise = gate.defer("a.md", fn);
        await Promise.resolve();
        expect(fn).not.toHaveBeenCalled();

        // Advance just before timeout — still pending
        vi.advanceTimersByTime(29_999);
        await Promise.resolve();
        expect(fn).not.toHaveBeenCalled();

        // Cross the threshold — drain happens
        vi.advanceTimersByTime(2);
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result).toBe("stuck");
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("clears timer when composition ends naturally", async () => {
        tracker.startComposition("a.md");
        const promise = gate.defer("a.md", async () => "ok");

        tracker.endComposition("a.md");
        await promise;

        // Advancing past timeout now is a no-op; nothing should re-fire.
        vi.advanceTimersByTime(60_000);
        await vi.runAllTimersAsync();
        // No assertion target — absence of throw / re-run is the check.
        expect(gate.pendingCount("a.md")).toBe(0);
    });

    // ── force flush ────────────────────────────────────────

    it("forceFlush drains regardless of composition state", async () => {
        tracker.startComposition("a.md");
        const fn = vi.fn(async () => "forced");
        const promise = gate.defer("a.md", fn);

        await gate.forceFlush("a.md");
        const result = await promise;

        expect(result).toBe("forced");
        expect(fn).toHaveBeenCalledTimes(1);
        // tracker still says composing, but op was forced through.
        expect(tracker.isComposing("a.md")).toBe(true);
    });

    it("forceFlush on empty path is a no-op", async () => {
        await expect(gate.forceFlush("nothing.md")).resolves.toBeUndefined();
    });

    // ── flushAll (unload) ──────────────────────────────────

    it("flushAll rejects pending ops without running them", async () => {
        tracker.startComposition("a.md");
        const fn = vi.fn(async () => "should not run");
        const promise = gate.defer("a.md", fn);

        gate.flushAll();

        await expect(promise).rejects.toThrow(/CompositionGate flushed/);
        expect(fn).not.toHaveBeenCalled();
        expect(gate.pendingCount("a.md")).toBe(0);
    });

    it("flushAll clears timers", async () => {
        tracker.startComposition("a.md");
        const promise = gate.defer("a.md", async () => "x");

        gate.flushAll();
        await expect(promise).rejects.toThrow();

        // Advancing past what would have been timeout — no resurrection.
        vi.advanceTimersByTime(60_000);
        await vi.runAllTimersAsync();
        expect(gate.pendingCount("a.md")).toBe(0);
    });

    // ── lifecycle ──────────────────────────────────────────

    it("stop unsubscribes from tracker", () => {
        expect(tracker.listenerCount).toBe(1);
        gate.stop();
        expect(tracker.listenerCount).toBe(0);
    });

    it("stop is idempotent", () => {
        gate.stop();
        gate.stop();
        expect(tracker.listenerCount).toBe(0);
    });

    it("start is idempotent", () => {
        gate.start();
        gate.start();
        expect(tracker.listenerCount).toBe(1);
    });

    // ── race: composition resumes mid-drain ────────────────

    it("pauses drain when composition resumes between ops", async () => {
        tracker.startComposition("a.md");
        const log: string[] = [];

        const p1 = gate.defer("a.md", async () => {
            log.push("first");
            // Simulate user starting another composition while drain runs.
            tracker.startComposition("a.md");
        });
        const p2 = gate.defer("a.md", async () => { log.push("second"); });

        // Initial composition ends → drain starts.
        tracker.endComposition("a.md");
        await p1;

        // p1 ran; p2 should be blocked because the drain saw composing
        // resume after p1 completed.
        expect(log).toEqual(["first"]);
        expect(gate.pendingCount("a.md")).toBe(1);

        // Now end the resumed composition → drain finishes.
        tracker.endComposition("a.md");
        await p2;
        expect(log).toEqual(["first", "second"]);
    });
});
