/**
 * ConfigLastSynced — unit tests for the per-config-path baseline cache.
 *
 * Drives the in-memory map + meta-store persistence directly. The
 * ConfigSync.scan() short-circuit that consumes this cache is exercised
 * separately in tests/config-sync.test.ts.
 *
 * v0.26: payload shape switched from `{vclock, size, dataHash}` to
 * `{vclock, size, chunks}` (vault parity). Legacy entries without
 * `chunks: string[]` are silently dropped by `ensureLoaded`, ensuring
 * the host's `findLegacyConfigDoc` migration guard owns the user-
 * facing "please re-init" path.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConfigLocalDB } from "../src/db/config-local-db.ts";
import {
    ConfigLastSynced,
    CONFIG_LAST_SYNCED_PREFIX,
    configLastSyncedKey,
} from "../src/db/sync/config-last-synced.ts";

describe("ConfigLastSynced", () => {
    let db: ConfigLocalDB;
    let lastSynced: ConfigLastSynced;

    beforeEach(() => {
        db = new ConfigLocalDB(`config-last-synced-test-${Date.now()}-${Math.random()}`);
        db.open();
        lastSynced = new ConfigLastSynced(db);
    });

    afterEach(async () => {
        await db.destroy();
    });

    describe("ensureLoaded", () => {
        it("populates cache from meta on first call", async () => {
            await db.runWriteTx({
                meta: [{
                    op: "put",
                    key: configLastSyncedKey(".obsidian/app.json"),
                    value: {
                        vclock: { "dev-A": 3 },
                        size: 42,
                        chunks: ["chunk:x64:deadbeef00000000"],
                    },
                }],
            });

            await lastSynced.ensureLoaded();

            const v = lastSynced.get(".obsidian/app.json");
            expect(v).toEqual({
                vclock: { "dev-A": 3 },
                size: 42,
                chunks: ["chunk:x64:deadbeef00000000"],
            });
        });

        it("is idempotent — second call is a no-op against fresh meta", async () => {
            await lastSynced.ensureLoaded();
            // After loaded, a fresh meta write should NOT be auto-discovered.
            await db.runWriteTx({
                meta: [{
                    op: "put",
                    key: configLastSyncedKey(".obsidian/late.json"),
                    value: {
                        vclock: { "dev-A": 1 },
                        size: 1,
                        chunks: ["chunk:x64:0000000000000000"],
                    },
                }],
            });
            await lastSynced.ensureLoaded(); // no-op

            expect(lastSynced.get(".obsidian/late.json")).toBeUndefined();
        });

        it("reload() picks up changes after disk-side mutation", async () => {
            await lastSynced.ensureLoaded();
            await db.runWriteTx({
                meta: [{
                    op: "put",
                    key: configLastSyncedKey(".obsidian/late.json"),
                    value: {
                        vclock: { "dev-A": 1 },
                        size: 1,
                        chunks: ["chunk:x64:0000000000000000"],
                    },
                }],
            });

            await lastSynced.reload();

            expect(lastSynced.get(".obsidian/late.json")).toMatchObject({ size: 1 });
        });

        it("drops legacy v2 dataHash-shaped entries silently (migration path)", async () => {
            // Pre-v0.26 entries used `dataHash: string` instead of `chunks`.
            // The migration guard handles re-init; the loader just refuses
            // to surface them so the in-memory cache stays consistent.
            await db.runWriteTx({
                meta: [{
                    op: "put",
                    key: configLastSyncedKey(".obsidian/legacy.json"),
                    value: { vclock: { "dev-A": 1 }, size: 5, dataHash: "deadbeef" },
                }],
            });

            await lastSynced.ensureLoaded();

            expect(lastSynced.get(".obsidian/legacy.json")).toBeUndefined();
        });
    });

    describe("set / get / delete / clear", () => {
        it("set + get round-trip in memory only (no auto-persist)", async () => {
            lastSynced.set(".obsidian/app.json", {
                vclock: { "dev-A": 1 },
                size: 10,
                chunks: ["chunk:x64:1111111111111111"],
            });
            expect(lastSynced.get(".obsidian/app.json")).toMatchObject({ size: 10 });

            // Caller is responsible for persisting via tx.meta — without
            // that, getMetaByPrefix returns nothing.
            const rows = await db.getMetaByPrefix(CONFIG_LAST_SYNCED_PREFIX);
            expect(rows).toHaveLength(0);
        });

        it("delete drops the in-memory entry", () => {
            lastSynced.set("a.json", {
                vclock: {}, size: 1, chunks: ["chunk:x64:2222222222222222"],
            });
            lastSynced.delete("a.json");
            expect(lastSynced.get("a.json")).toBeUndefined();
        });

        it("clear empties the cache and forces reload on next ensureLoaded", async () => {
            await db.runWriteTx({
                meta: [{
                    op: "put",
                    key: configLastSyncedKey("a.json"),
                    value: {
                        vclock: {},
                        size: 1,
                        chunks: ["chunk:x64:3333333333333333"],
                    },
                }],
            });
            await lastSynced.ensureLoaded();
            expect(lastSynced.get("a.json")).toBeDefined();

            lastSynced.clear();
            expect(lastSynced.get("a.json")).toBeUndefined();

            // ensureLoaded re-reads from disk.
            await lastSynced.ensureLoaded();
            expect(lastSynced.get("a.json")).toBeDefined();
        });
    });
});
