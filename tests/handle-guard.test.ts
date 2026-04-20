import { describe, it, expect, vi } from "vitest";
import { HandleGuard } from "../src/db/handle-guard.ts";
import { DbError } from "../src/db/write-transaction.ts";

function makeFakeError(name: string): Error {
    const e = new Error(`fake ${name}`);
    e.name = name;
    return e;
}

describe("HandleGuard", () => {
    it("lazily opens the underlying handle on first runOp", async () => {
        const factory = vi.fn(() => ({ id: "inner" }));
        const guard = new HandleGuard({
            factory,
            cleanup: vi.fn().mockResolvedValue(undefined),
        });
        expect(factory).not.toHaveBeenCalled();

        const result = await guard.runOp(async (inner) => inner.id, "probe");
        expect(result).toBe("inner");
        expect(factory).toHaveBeenCalledTimes(1);
    });

    it("re-uses the same handle across multiple successful runOps", async () => {
        const factory = vi.fn(() => ({ id: "inner" }));
        const guard = new HandleGuard({
            factory,
            cleanup: vi.fn().mockResolvedValue(undefined),
        });

        await guard.runOp(async (i) => i.id, "op1");
        await guard.runOp(async (i) => i.id, "op2");
        await guard.runOp(async (i) => i.id, "op3");

        expect(factory).toHaveBeenCalledTimes(1);
    });

    it("transparently re-opens on InvalidStateError and retries once", async () => {
        const factory = vi.fn(() => ({ id: "inner" }));
        const cleanup = vi.fn().mockResolvedValue(undefined);
        const guard = new HandleGuard({ factory, cleanup });

        let calls = 0;
        const result = await guard.runOp(async () => {
            calls++;
            if (calls === 1) throw makeFakeError("InvalidStateError");
            return "ok";
        }, "write");

        expect(result).toBe("ok");
        expect(factory).toHaveBeenCalledTimes(2);
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("passes non-handle errors straight through without reopening", async () => {
        const factory = vi.fn(() => ({ id: "inner" }));
        const cleanup = vi.fn().mockResolvedValue(undefined);
        const guard = new HandleGuard({ factory, cleanup });

        const err = new Error("business logic blew up");
        await expect(
            guard.runOp(async () => { throw err; }, "write"),
        ).rejects.toBe(err);

        expect(factory).toHaveBeenCalledTimes(1);
        expect(cleanup).not.toHaveBeenCalled();
    });

    it("throws DbError(degraded, halt) after maxReopen consecutive failures", async () => {
        const factory = vi.fn(() => ({ id: "inner" }));
        const cleanup = vi.fn().mockResolvedValue(undefined);
        const guard = new HandleGuard({ factory, cleanup, maxReopen: 3 });

        const op = async () => { throw makeFakeError("InvalidStateError"); };

        const err = await guard
            .runOp(op, "write")
            .catch((e) => e);

        expect(err).toBeInstanceOf(DbError);
        expect((err as DbError).kind).toBe("degraded");
        expect((err as DbError).recovery).toBe("halt");
        expect((err as DbError).userMessage).toBeTruthy();
        // 1 initial open + 3 reopen attempts = 4 factory calls
        expect(factory).toHaveBeenCalledTimes(4);
    });

    it("also triggers reopen on DatabaseClosedError name", async () => {
        const factory = vi.fn(() => ({ id: "inner" }));
        const guard = new HandleGuard({
            factory,
            cleanup: vi.fn().mockResolvedValue(undefined),
        });

        let calls = 0;
        const result = await guard.runOp(async () => {
            calls++;
            if (calls === 1) throw makeFakeError("DatabaseClosedError");
            return "ok";
        }, "meta");

        expect(result).toBe("ok");
        expect(factory).toHaveBeenCalledTimes(2);
    });

    it("ensureHealthy() probes the handle and reopens once if it fails", async () => {
        const factory = vi.fn(() => ({ id: "inner" }));
        const cleanup = vi.fn().mockResolvedValue(undefined);
        let probeCalls = 0;
        const guard = new HandleGuard({
            factory,
            cleanup,
            probe: async () => {
                probeCalls++;
                if (probeCalls === 1) throw makeFakeError("InvalidStateError");
            },
        });

        await guard.ensureHealthy();

        expect(probeCalls).toBe(2);
        expect(factory).toHaveBeenCalledTimes(2);
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("close() cleans up the handle and drops the reference", async () => {
        const factory = vi.fn(() => ({ id: "inner" }));
        const cleanup = vi.fn().mockResolvedValue(undefined);
        const guard = new HandleGuard({ factory, cleanup });

        await guard.runOp(async () => "init", "probe");
        await guard.close();

        expect(cleanup).toHaveBeenCalledTimes(1);

        await guard.runOp(async () => "again", "probe");
        expect(factory).toHaveBeenCalledTimes(2);
    });

    it("swallows cleanup errors during reopen so the retry can proceed", async () => {
        const factory = vi.fn(() => ({ id: "inner" }));
        const cleanup = vi.fn().mockRejectedValue(new Error("close already disposed"));
        const guard = new HandleGuard({ factory, cleanup });

        let calls = 0;
        const result = await guard.runOp(async () => {
            calls++;
            if (calls === 1) throw makeFakeError("InvalidStateError");
            return "ok";
        }, "write");

        expect(result).toBe("ok");
        expect(factory).toHaveBeenCalledTimes(2);
    });
});
