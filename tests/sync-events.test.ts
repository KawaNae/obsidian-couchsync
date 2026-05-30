import { describe, it, expect, vi } from "vitest";
import { SyncEvents } from "../src/db/sync/sync-events.ts";
import type { FileDoc } from "../src/types.ts";

function makeFileDoc(id: string): FileDoc {
    return {
        _id: id,
        type: "file",
        chunks: [],
        mtime: 0,
        ctime: 0,
        size: 0,
        vclock: {},
    };
}

describe("SyncEvents", () => {
    describe("fire-and-forget (emit / on)", () => {
        it("fans out to all subscribers", () => {
            const ev = new SyncEvents();
            const a = vi.fn();
            const b = vi.fn();
            ev.on("state-change", a);
            ev.on("state-change", b);

            ev.emit("state-change", { state: "connected" });

            expect(a).toHaveBeenCalledWith({ state: "connected" });
            expect(b).toHaveBeenCalledWith({ state: "connected" });
        });

        it("void-payload events emit with no argument", () => {
            const ev = new SyncEvents();
            const h = vi.fn();
            ev.on("paused", h);

            ev.emit("paused");

            expect(h).toHaveBeenCalledTimes(1);
        });

        it("handler exception does not prevent other handlers", () => {
            const ev = new SyncEvents();
            const boom = vi.fn(() => { throw new Error("bug"); });
            const other = vi.fn();
            ev.on("error", boom);
            ev.on("error", other);

            ev.emit("error", { message: "oops" });

            expect(boom).toHaveBeenCalled();
            expect(other).toHaveBeenCalled();
        });

        it("unsubscribe stops further delivery", () => {
            const ev = new SyncEvents();
            const h = vi.fn();
            const off = ev.on("reconnect", h);

            off();
            ev.emit("reconnect");

            expect(h).not.toHaveBeenCalled();
        });
    });

    // The awaited-broadcast API (emitAsync / onAsync) was removed: its
    // sole subscriber was promoted to a constructor-injected callback
    // (`SyncEngine.applyPullWrite`) so vault-write throws now propagate
    // into PullWriter's existing try/catch and increment writeFailCount
    // instead of being silently swallowed by the bus's catch-all.

    // The boolean-aggregated query API (emitAsyncAny / onQuery) was removed in
    // v0.26.2: its sole subscriber was the `pull-delete` unpushed-edit probe,
    // whose catch swallowed I/O errors into a `false` (= apply the deletion),
    // violating the safe-side principle (#err-10). It is now the
    // `probeUnpushed` function DI on the pull-writer, wrapped in a safe-side
    // try/catch — covered by tests/integration/pull-writer.integ.test.ts.

    describe("idle once-latch", () => {
        it("fires every pending callback exactly once when tripped", () => {
            const ev = new SyncEvents();
            const a = vi.fn();
            const b = vi.fn();
            ev.onceIdle(a);
            ev.onceIdle(b);

            ev.fireIdle();
            ev.fireIdle(); // second fire is a no-op

            expect(a).toHaveBeenCalledTimes(1);
            expect(b).toHaveBeenCalledTimes(1);
        });

        it("onceIdle registered after fire runs immediately", () => {
            const ev = new SyncEvents();
            ev.fireIdle();

            const late = vi.fn();
            ev.onceIdle(late);

            expect(late).toHaveBeenCalledTimes(1);
        });

        it("resetIdle lets a new session trip the latch again", () => {
            const ev = new SyncEvents();
            const cb = vi.fn();
            ev.onceIdle(cb);
            ev.fireIdle();
            expect(cb).toHaveBeenCalledTimes(1);

            ev.resetIdle();
            const cb2 = vi.fn();
            ev.onceIdle(cb2);
            ev.fireIdle();

            expect(cb2).toHaveBeenCalledTimes(1);
        });
    });
});
