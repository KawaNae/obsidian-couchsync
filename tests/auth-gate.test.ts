import { describe, it, expect, vi } from "vitest";
import { AuthGate } from "../src/db/sync/auth-gate.ts";

describe("AuthGate", () => {
    it("starts unblocked with null lastError", () => {
        const gate = new AuthGate();
        expect(gate.isBlocked()).toBe(false);
        expect(gate.getLastError()).toBeNull();
    });

    it("raise latches the gate and exposes the detail", () => {
        const gate = new AuthGate();
        gate.raise(401, "invalid password");
        expect(gate.isBlocked()).toBe(true);
        expect(gate.getLastError()).toEqual({ status: 401, reason: "invalid password" });
    });

    it("raise without reason stores empty string", () => {
        const gate = new AuthGate();
        gate.raise(403);
        expect(gate.getLastError()).toEqual({ status: 403, reason: "" });
    });

    it("clear resets both the latch and lastError", () => {
        const gate = new AuthGate();
        gate.raise(401, "bad");
        gate.clear();
        expect(gate.isBlocked()).toBe(false);
        expect(gate.getLastError()).toBeNull();
    });

    it("repeated raise fires onChange only once (idempotency)", () => {
        const gate = new AuthGate();
        const listener = vi.fn();
        gate.onChange(listener);

        gate.raise(401, "first");
        gate.raise(403, "second"); // second raise updates detail but must not fire
        gate.raise(401, "third");

        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith({ status: 401, reason: "first" });
    });

    it("second raise updates lastError without firing onChange", () => {
        const gate = new AuthGate();
        const listener = vi.fn();
        gate.onChange(listener);

        gate.raise(401, "first");
        gate.raise(403, "second");

        expect(gate.getLastError()).toEqual({ status: 403, reason: "second" });
    });

    it("repeated clear is a no-op", () => {
        const gate = new AuthGate();
        const listener = vi.fn();
        gate.onChange(listener);

        gate.clear();
        gate.clear();

        expect(listener).not.toHaveBeenCalled();
    });

    it("onChange fires on raise with detail, on clear with null", () => {
        const gate = new AuthGate();
        const listener = vi.fn();
        gate.onChange(listener);

        gate.raise(401, "bad");
        gate.clear();

        expect(listener).toHaveBeenNthCalledWith(1, { status: 401, reason: "bad" });
        expect(listener).toHaveBeenNthCalledWith(2, null);
    });

    it("unsubscribe stops further onChange notifications", () => {
        const gate = new AuthGate();
        const listener = vi.fn();
        const unsubscribe = gate.onChange(listener);

        unsubscribe();
        gate.raise(401);

        expect(listener).not.toHaveBeenCalled();
    });

    it("a listener throwing does not break other listeners", () => {
        const gate = new AuthGate();
        const boom = vi.fn(() => { throw new Error("listener bug"); });
        const other = vi.fn();

        gate.onChange(boom);
        gate.onChange(other);
        gate.raise(401);

        expect(boom).toHaveBeenCalled();
        expect(other).toHaveBeenCalled();
    });
});
