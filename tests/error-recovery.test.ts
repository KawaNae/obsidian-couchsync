import { describe, it, expect, afterEach, vi } from "vitest";
import { ErrorRecovery, type ErrorRecoveryHost } from "../src/db/error-recovery.ts";

function makeHost(overrides?: Partial<ErrorRecoveryHost>): ErrorRecoveryHost & {
    states: { state: string; detail?: any }[];
    errors: string[];
} {
    const states: { state: string; detail?: any }[] = [];
    const errors: string[] = [];
    return {
        states,
        errors,
        getState: vi.fn(() => states.at(-1)?.state ?? "connected"),
        setState: vi.fn((s, d) => { states.push({ state: s, detail: d }); }),
        emitError: vi.fn((m) => { errors.push(m); }),
        setAuthError: vi.fn(),
        teardown: vi.fn(),
        requestReconnect: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

describe("ErrorRecovery.classifyError", () => {
    const host = makeHost();
    const recovery = new ErrorRecovery(host);

    it("401/403 → auth", () => {
        expect(recovery.classifyError({ status: 401, message: "nope" }).kind).toBe("auth");
        expect(recovery.classifyError({ status: 403, message: "nope" }).kind).toBe("auth");
    });

    it("5xx → server", () => {
        expect(recovery.classifyError({ status: 500, message: "oops" }).kind).toBe("server");
        expect(recovery.classifyError({ status: 503, message: "down" }).kind).toBe("server");
    });

    it("timeout patterns → timeout", () => {
        expect(recovery.classifyError({ message: "request timed out" }).kind).toBe("timeout");
        expect(recovery.classifyError(new Error("Catchup timed out")).kind).toBe("timeout");
    });

    it("network patterns → network", () => {
        expect(recovery.classifyError({ message: "ECONNREFUSED" }).kind).toBe("network");
        expect(recovery.classifyError({ message: "Failed to fetch" }).kind).toBe("network");
        expect(recovery.classifyError({ message: "ENOTFOUND host.example" }).kind).toBe("network");
    });

    it("unknown fallback", () => {
        expect(recovery.classifyError({ message: "something weird" }).kind).toBe("unknown");
    });

    it("HTTP code takes priority over message text", () => {
        expect(recovery.classifyError({ status: 401, message: "connection timed out" }).kind).toBe("auth");
    });

    it("preserves status code in detail", () => {
        expect(recovery.classifyError({ status: 503, message: "down" }).code).toBe(503);
    });
});

describe("ErrorRecovery.handleTransientError", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("sets state to reconnecting on first transient error", () => {
        const host = makeHost();
        const recovery = new ErrorRecovery(host);
        recovery.handleTransientError({ message: "ECONNREFUSED" });
        expect(host.setState).toHaveBeenCalledWith("reconnecting");
        recovery.reset();
    });

    it("escalates to hard error after 10s in reconnecting state", async () => {
        vi.useFakeTimers();
        try {
            // Start as "connected" so handleTransientError transitions to "reconnecting",
            // then stay in "reconnecting" so the escalation timer fires.
            let currentState = "connected";
            const host = makeHost({
                getState: vi.fn(() => currentState as any),
                setState: vi.fn((s: any) => { currentState = s; }),
            });
            const recovery = new ErrorRecovery(host);

            recovery.handleTransientError({ message: "ECONNREFUSED" });
            expect(currentState).toBe("reconnecting");

            await vi.advanceTimersByTimeAsync(10_001);

            // Should have escalated to error state
            expect(currentState).toBe("error");
            recovery.reset();
        } finally { vi.useRealTimers(); }
    });

    it("auth errors escalate immediately (no 10s grace)", () => {
        const host = makeHost();
        const recovery = new ErrorRecovery(host);
        recovery.handleTransientError({ status: 401, message: "bad creds" });
        expect(host.setAuthError).toHaveBeenCalled();
        expect(host.states.some((s) => s.state === "error")).toBe(true);
        recovery.reset();
    });
});

describe("ErrorRecovery.enterHardError", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("auth error → pins error state, sets auth flag, no retries", async () => {
        vi.useFakeTimers();
        try {
            const host = makeHost();
            const recovery = new ErrorRecovery(host);
            recovery.enterHardError({ kind: "auth", code: 401, message: "fail" });

            expect(host.setAuthError).toHaveBeenCalled();
            expect(host.teardown).toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(60_000);
            expect(host.requestReconnect).not.toHaveBeenCalled();
            recovery.reset();
        } finally { vi.useRealTimers(); }
    });

    it("network error → schedules backoff retries at 2s, 5s, 10s", async () => {
        vi.useFakeTimers();
        try {
            const host = makeHost({ getState: vi.fn(() => "error") });
            const recovery = new ErrorRecovery(host);
            recovery.enterHardError({ kind: "network", message: "fake down" });

            expect(host.requestReconnect).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(2_000);
            expect(host.requestReconnect).toHaveBeenCalledTimes(1);
            expect(host.requestReconnect).toHaveBeenCalledWith("retry-backoff");

            await vi.advanceTimersByTimeAsync(5_000);
            expect(host.requestReconnect).toHaveBeenCalledTimes(2);

            await vi.advanceTimersByTimeAsync(10_000);
            expect(host.requestReconnect).toHaveBeenCalledTimes(3);

            recovery.reset();
        } finally { vi.useRealTimers(); }
    });

    it("reset() clears backoff step to 0", async () => {
        vi.useFakeTimers();
        try {
            const host = makeHost({ getState: vi.fn(() => "error") });
            const recovery = new ErrorRecovery(host);
            recovery.enterHardError({ kind: "network", message: "fake" });

            await vi.advanceTimersByTimeAsync(2_000); // step 0 fires
            await vi.advanceTimersByTimeAsync(5_000); // step 1 fires
            expect(host.requestReconnect).toHaveBeenCalledTimes(2);

            // Recovery — simulate SyncEngine reaching "connected"
            recovery.reset();

            // Re-enter error: backoff should restart from step 0 (2s)
            (host.requestReconnect as any).mockClear();
            recovery.enterHardError({ kind: "network", message: "again" });
            await vi.advanceTimersByTimeAsync(2_000);
            expect(host.requestReconnect).toHaveBeenCalledTimes(1);

            recovery.reset();
        } finally { vi.useRealTimers(); }
    });
});
