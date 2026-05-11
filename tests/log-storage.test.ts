import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { LogStorage, approxEntryBytes, type PersistedLogEntry } from "../src/log/log-storage.ts";

function uniqueVaultName(): string {
    return `test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function makeEntry(ts: number, level: "debug" | "info" | "warn" | "error" = "info", msg = "x"): PersistedLogEntry {
    return { timestamp: ts, level, message: msg };
}

describe("LogStorage", () => {
    let storage: LogStorage;

    beforeEach(() => {
        storage = new LogStorage(uniqueVaultName());
    });

    afterEach(async () => {
        storage.close();
    });

    it("bulkAppend + getAll round-trip preserves order", async () => {
        await storage.bulkAppend([
            makeEntry(100, "info", "a"),
            makeEntry(200, "warn", "b"),
            makeEntry(300, "error", "c"),
        ]);
        const all = await storage.getAll();
        expect(all.map((e) => e.message)).toEqual(["a", "b", "c"]);
    });

    it("getAll(sinceTs) is inclusive lower bound", async () => {
        await storage.bulkAppend([
            makeEntry(100, "info", "a"),
            makeEntry(200, "info", "b"),
            makeEntry(300, "info", "c"),
        ]);
        const filtered = await storage.getAll(200);
        expect(filtered.map((e) => e.message)).toEqual(["b", "c"]);
    });

    it("deleteBefore deletes strictly older entries", async () => {
        await storage.bulkAppend([
            makeEntry(100),
            makeEntry(200),
            makeEntry(300),
        ]);
        const removed = await storage.deleteBefore(200);
        expect(removed).toBe(1);
        const remaining = await storage.getAll();
        expect(remaining.map((e) => e.timestamp)).toEqual([200, 300]);
    });

    it("trimToCount drops oldest entries", async () => {
        const entries: PersistedLogEntry[] = [];
        for (let i = 0; i < 10; i++) {
            entries.push(makeEntry(i * 100, "info", String(i)));
        }
        await storage.bulkAppend(entries);
        const removed = await storage.trimToCount(3);
        expect(removed).toBe(7);
        const remaining = await storage.getAll();
        expect(remaining.map((e) => e.message)).toEqual(["7", "8", "9"]);
    });

    it("trimToCount is a no-op when count <= maxEntries", async () => {
        await storage.bulkAppend([makeEntry(100), makeEntry(200)]);
        expect(await storage.trimToCount(5)).toBe(0);
        expect(await storage.trimToCount(2)).toBe(0);
    });

    it("getStats returns count / range / level counts", async () => {
        await storage.bulkAppend([
            makeEntry(100, "debug", "d"),
            makeEntry(200, "info", "ii"),
            makeEntry(300, "warn", "www"),
            makeEntry(400, "error", "eeee"),
        ]);
        const stats = await storage.getStats();
        expect(stats.count).toBe(4);
        expect(stats.oldestTs).toBe(100);
        expect(stats.newestTs).toBe(400);
        expect(stats.levels).toEqual({ debug: 1, info: 1, warn: 1, error: 1 });
        // approxBytes is monotonic with message length but exact value is
        // not asserted — it's a budget proxy, not an accurate measure.
        expect(stats.approxBytes).toBeGreaterThan(0);
    });

    it("getStats on empty DB returns zeros", async () => {
        const stats = await storage.getStats();
        expect(stats).toEqual({ count: 0, oldestTs: null, newestTs: null, approxBytes: 0 });
    });

    it("clearAll empties the table", async () => {
        await storage.bulkAppend([makeEntry(100), makeEntry(200)]);
        await storage.clearAll();
        const stats = await storage.getStats();
        expect(stats.count).toBe(0);
    });

    it("approxEntryBytes scales with message length", () => {
        const small = approxEntryBytes(makeEntry(0, "info", "a"));
        const large = approxEntryBytes(makeEntry(0, "info", "a".repeat(100)));
        expect(large).toBeGreaterThan(small);
        expect(large - small).toBeCloseTo(99 * 2, -1);  // 99 extra chars * 2 bytes
    });

    it("deleteDatabase clears state and remains usable afterward", async () => {
        await storage.bulkAppend([makeEntry(100), makeEntry(200)]);
        await storage.deleteDatabase();
        const stats = await storage.getStats();
        expect(stats.count).toBe(0);
        // Re-append after reset works.
        await storage.bulkAppend([makeEntry(500)]);
        const after = await storage.getAll();
        expect(after.map((e) => e.timestamp)).toEqual([500]);
    });

    it("bulkAppend of empty array is a no-op (no throw)", async () => {
        await expect(storage.bulkAppend([])).resolves.toBeUndefined();
    });
});
