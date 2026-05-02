import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ChangeTracker } from "../src/sync/change-tracker.ts";
import { FakeVaultEvents } from "./helpers/fake-vault-events.ts";
import { makeSettings } from "./helpers/settings-factory.ts";

/** Minimal VaultSync stub — records calls for assertions. */
function makeVaultSyncStub() {
    const calls = {
        fileToDb: [] as string[],
        markDeleted: [] as string[],
        handleRename: [] as Array<{ newPath: string; oldPath: string }>,
    };
    return {
        calls,
        async fileToDb(path: string) { calls.fileToDb.push(path); },
        async markDeleted(path: string) { calls.markDeleted.push(path); },
        async handleRename(newPath: string, oldPath: string) {
            calls.handleRename.push({ newPath, oldPath });
        },
    };
}

const stat = { mtime: 1000, ctime: 1000, size: 100 };

describe("ChangeTracker", () => {
    let events: FakeVaultEvents;
    let vaultSync: ReturnType<typeof makeVaultSyncStub>;
    let settings: ReturnType<typeof makeSettings>;
    let tracker: ChangeTracker;

    beforeEach(() => {
        vi.useFakeTimers();
        events = new FakeVaultEvents();
        vaultSync = makeVaultSyncStub();
        settings = makeSettings({ syncDebounceMs: 100, syncMinIntervalMs: 0 });
        tracker = new ChangeTracker(events, vaultSync as any, () => settings);
    });

    afterEach(() => {
        tracker.stop();
        vi.useRealTimers();
    });

    // ── Event routing ───────────────────────────────────

    describe("event routing", () => {
        it("modify fires fileToDb after debounce", async () => {
            tracker.start();
            events.emit("modify", "a.md", stat);

            expect(vaultSync.calls.fileToDb).toHaveLength(0);
            vi.advanceTimersByTime(100);
            await vi.runAllTimersAsync();

            expect(vaultSync.calls.fileToDb).toEqual(["a.md"]);
        });

        it("create fires fileToDb after debounce", async () => {
            tracker.start();
            events.emit("create", "b.md", stat);

            vi.advanceTimersByTime(100);
            await vi.runAllTimersAsync();

            expect(vaultSync.calls.fileToDb).toEqual(["b.md"]);
        });

        it("delete fires markDeleted immediately", async () => {
            tracker.start();
            events.emit("delete", "c.md");

            await vi.runAllTimersAsync();
            expect(vaultSync.calls.markDeleted).toEqual(["c.md"]);
        });

        it("rename fires handleRename", async () => {
            tracker.start();
            events.emit("rename", "new.md", "old.md", stat);

            await vi.runAllTimersAsync();
            expect(vaultSync.calls.handleRename).toEqual([
                { newPath: "new.md", oldPath: "old.md" },
            ]);
        });
    });

    // ── ignoreDelete ─────────────────────────────────────
    //
    // ignoreWrite / clearIgnore retired in v0.21.0: the modify-path
    // echo is now suppressed by `chunksEqual` idempotency in
    // fileToDb. ignoreDelete remains because deletions have no
    // chunksEqual analog.

    describe("ignoreDelete", () => {
        it("suppresses next delete for ignored path", async () => {
            tracker.start();
            tracker.ignoreDelete("d.md");
            events.emit("delete", "d.md");

            await vi.runAllTimersAsync();
            expect(vaultSync.calls.markDeleted).toHaveLength(0);
        });
    });

    // ── debounce ────────────────────────────────────────

    describe("debounce", () => {
        it("only fires once for rapid edits within debounce window", async () => {
            tracker.start();
            events.emit("modify", "a.md", stat);
            vi.advanceTimersByTime(50);
            events.emit("modify", "a.md", stat);
            vi.advanceTimersByTime(50);
            events.emit("modify", "a.md", stat);

            vi.advanceTimersByTime(200);
            await vi.runAllTimersAsync();

            expect(vaultSync.calls.fileToDb).toEqual(["a.md"]);
        });

        it("fires separately for different files", async () => {
            tracker.start();
            events.emit("modify", "a.md", stat);
            events.emit("modify", "b.md", stat);

            vi.advanceTimersByTime(200);
            await vi.runAllTimersAsync();

            expect(vaultSync.calls.fileToDb).toContain("a.md");
            expect(vaultSync.calls.fileToDb).toContain("b.md");
        });
    });

    // ── lifecycle ───────────────────────────────────────

    describe("lifecycle", () => {
        it("stop clears all timers and unsubscribes", () => {
            tracker.start();
            expect(events.subscriberCount).toBe(4);

            events.emit("modify", "a.md", stat); // pending timer

            tracker.stop();
            expect(events.subscriberCount).toBe(0);

            // Timer should not fire after stop
            vi.advanceTimersByTime(500);
            expect(vaultSync.calls.fileToDb).toHaveLength(0);
        });

        it("can start → stop → start again", async () => {
            tracker.start();
            tracker.stop();
            tracker.start();

            events.emit("modify", "a.md", stat);
            vi.advanceTimersByTime(200);
            await vi.runAllTimersAsync();

            expect(vaultSync.calls.fileToDb).toEqual(["a.md"]);
        });
    });

    // ── minInterval ─────────────────────────────────────

    describe("syncMinIntervalMs", () => {
        it("delays second sync when within min interval", async () => {
            settings.syncMinIntervalMs = 500;
            tracker.start();

            events.emit("modify", "a.md", stat);
            vi.advanceTimersByTime(100); // debounce fires → first sync
            await vi.runAllTimersAsync();
            expect(vaultSync.calls.fileToDb).toEqual(["a.md"]);

            // Second edit immediately after first sync
            events.emit("modify", "a.md", stat);
            vi.advanceTimersByTime(100); // debounce fires, trySync sees minInterval
            // Don't runAllTimersAsync yet — just advance to debounce point
            await Promise.resolve();

            // At this point the pending min-interval timer should be queued
            // but not yet resolved. Advance to just before interval expires.
            vi.advanceTimersByTime(200);
            await Promise.resolve();
            expect(vaultSync.calls.fileToDb).toHaveLength(1); // still 1

            // Advance past the full min interval
            vi.advanceTimersByTime(300);
            await vi.runAllTimersAsync();
            expect(vaultSync.calls.fileToDb).toHaveLength(2);
        });
    });
});
