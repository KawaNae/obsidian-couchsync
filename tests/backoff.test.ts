import { describe, it, expect } from "vitest";
import { BackoffSchedule } from "../src/db/sync/backoff.ts";

describe("BackoffSchedule", () => {
    it("returns the first delay before any failure is recorded", () => {
        const b = new BackoffSchedule([2_000, 5_000, 10_000]);
        expect(b.nextDelay()).toBe(2_000);
        expect(b.currentStep).toBe(0);
    });

    it("advances through the delay table on recordFailure()", () => {
        const b = new BackoffSchedule([2_000, 5_000, 10_000, 20_000, 30_000]);
        b.recordFailure();
        expect(b.currentStep).toBe(1);
        expect(b.nextDelay()).toBe(5_000);
        b.recordFailure();
        expect(b.nextDelay()).toBe(10_000);
        b.recordFailure();
        expect(b.nextDelay()).toBe(20_000);
        b.recordFailure();
        expect(b.nextDelay()).toBe(30_000);
    });

    it("caps at the last delay once the table is exhausted", () => {
        const b = new BackoffSchedule([2_000, 5_000, 10_000]);
        for (let i = 0; i < 10; i++) b.recordFailure();
        expect(b.currentStep).toBe(10);
        expect(b.nextDelay()).toBe(10_000);
    });

    it("recordSuccess() resets the step to 0", () => {
        const b = new BackoffSchedule([2_000, 5_000, 10_000]);
        b.recordFailure();
        b.recordFailure();
        expect(b.currentStep).toBe(2);
        b.recordSuccess();
        expect(b.currentStep).toBe(0);
        expect(b.nextDelay()).toBe(2_000);
    });

    it("uses the production default table when no delays supplied", () => {
        const b = new BackoffSchedule();
        expect(b.nextDelay()).toBe(2_000);
        b.recordFailure();
        expect(b.nextDelay()).toBe(5_000);
        b.recordFailure();
        expect(b.nextDelay()).toBe(10_000);
        b.recordFailure();
        expect(b.nextDelay()).toBe(20_000);
        b.recordFailure();
        expect(b.nextDelay()).toBe(30_000);
        b.recordFailure();
        expect(b.nextDelay()).toBe(30_000);
    });

    it("throws if constructed with an empty delay table", () => {
        expect(() => new BackoffSchedule([])).toThrow();
    });
});
