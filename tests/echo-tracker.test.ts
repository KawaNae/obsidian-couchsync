import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EchoTracker } from "../src/db/sync/echo-tracker.ts";

describe("EchoTracker", () => {
    describe("pull-echo detection", () => {
        it("returns false for unrecorded IDs", () => {
            const t = new EchoTracker();
            expect(t.isPullEcho("file:a.md", 5)).toBe(false);
        });

        it("returns true when change seq is <= recorded pull seq", () => {
            const t = new EchoTracker();
            t.recordPullWrites(["file:a.md"], 10);
            expect(t.isPullEcho("file:a.md", 5)).toBe(true);
            expect(t.isPullEcho("file:a.md", 10)).toBe(true);
        });

        it("returns false when change seq > recorded pull seq (genuine post-pull edit)", () => {
            const t = new EchoTracker();
            t.recordPullWrites(["file:a.md"], 10);
            expect(t.isPullEcho("file:a.md", 11)).toBe(false);
        });

        it("sweepPullWritten removes seen IDs so they can re-record later", () => {
            const t = new EchoTracker();
            t.recordPullWrites(["file:a.md"], 10);
            t.sweepPullWritten(["file:a.md"]);
            expect(t.sizePullWritten()).toBe(0);
        });
    });

    describe("pull-echo TTL", () => {
        beforeEach(() => { vi.useFakeTimers(); });
        afterEach(() => { vi.useRealTimers(); });

        it("sweepPullWritten evicts entries past TTL", () => {
            const t = new EchoTracker(1_000);
            t.recordPullWrites(["file:a.md"], 10);

            vi.advanceTimersByTime(2_000);
            t.sweepPullWritten([]);

            expect(t.sizePullWritten()).toBe(0);
        });

        it("sweepPullWritten keeps entries within TTL", () => {
            const t = new EchoTracker(10_000);
            t.recordPullWrites(["file:a.md"], 10);

            vi.advanceTimersByTime(5_000);
            t.sweepPullWritten([]);

            expect(t.sizePullWritten()).toBe(1);
        });
    });

    describe("clear (teardown)", () => {
        it("clear removes pull-echo state", () => {
            const t = new EchoTracker();
            t.recordPullWrites(["file:a.md"], 10);

            t.clear();

            expect(t.sizePullWritten()).toBe(0);
        });
    });
});
