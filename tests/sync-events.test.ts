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

    describe("awaited notifications (emitAsync / onAsync)", () => {
        it("awaits every subscriber serially", async () => {
            const ev = new SyncEvents();
            const order: string[] = [];

            ev.onAsync("pull-write", async () => {
                await new Promise((r) => setTimeout(r, 5));
                order.push("a-done");
            });
            ev.onAsync("pull-write", async () => {
                order.push("b-start");
            });

            await ev.emitAsync("pull-write", { doc: makeFileDoc("file:a.md") });

            expect(order).toEqual(["a-done", "b-start"]);
        });

        it("rejection in one async handler is logged but not thrown", async () => {
            const ev = new SyncEvents();
            const boom = vi.fn(async () => { throw new Error("boom"); });
            const other = vi.fn(async () => {});
            ev.onAsync("pull-write", boom);
            ev.onAsync("pull-write", other);

            await expect(
                ev.emitAsync("pull-write", { doc: makeFileDoc("file:a.md") }),
            ).resolves.toBeUndefined();
            expect(other).toHaveBeenCalled();
        });
    });

    describe("queries (emitAsyncAny / onQuery)", () => {
        it("returns true when any handler returns true", async () => {
            const ev = new SyncEvents();
            ev.onQuery("pull-delete", async () => false);
            ev.onQuery("pull-delete", async () => true);

            const result = await ev.emitAsyncAny("pull-delete", {
                path: "x.md",
                localDoc: makeFileDoc("file:x.md"),
            });

            expect(result).toBe(true);
        });

        it("returns false when all handlers return false", async () => {
            const ev = new SyncEvents();
            ev.onQuery("pull-delete", async () => false);
            ev.onQuery("pull-delete", async () => false);

            const result = await ev.emitAsyncAny("pull-delete", {
                path: "x.md",
                localDoc: makeFileDoc("file:x.md"),
            });

            expect(result).toBe(false);
        });

        it("returns false when no subscriber is registered", async () => {
            const ev = new SyncEvents();

            const result = await ev.emitAsyncAny("pull-delete", {
                path: "x.md",
                localDoc: makeFileDoc("file:x.md"),
            });

            expect(result).toBe(false);
        });

        it("a throwing query handler does not block others", async () => {
            const ev = new SyncEvents();
            ev.onQuery("pull-delete", async () => { throw new Error("bad"); });
            ev.onQuery("pull-delete", async () => true);

            const result = await ev.emitAsyncAny("pull-delete", {
                path: "x.md",
                localDoc: makeFileDoc("file:x.md"),
            });

            expect(result).toBe(true);
        });
    });

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
