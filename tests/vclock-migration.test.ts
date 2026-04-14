/**
 * Test that LocalDB.loadAllSyncedVclocks migrates the legacy
 * `_local/last-synced-vclocks` single-doc layout to the per-path
 * `_local/vclock/<path>` representation transparently on first read.
 */

import { describe, it, expect, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { LocalDB } from "../src/db/local-db.ts";

describe("vclock per-path migration", () => {
    let db: LocalDB | null = null;

    afterEach(async () => {
        if (db) {
            await db.destroy();
            db = null;
        }
    });

    it("migrates legacy single-doc into per-path entries on first load", async () => {
        db = new LocalDB(`mig-${Date.now()}`);
        db.open();
        // Seed the legacy doc directly via metaStore.
        const meta = db.getMetaStore();
        await meta.putMeta("_local/last-synced-vclocks", {
            clocks: {
                "alpha.md": { A: 1, B: 2 },
                "sub/beta.md": { A: 3 },
            },
        });

        // First load — should migrate.
        const loaded = await db.loadAllSyncedVclocks();
        expect(loaded.get("alpha.md")).toEqual({ A: 1, B: 2 });
        expect(loaded.get("sub/beta.md")).toEqual({ A: 3 });

        // Per-path entries now live in the docs store's meta table.
        const docsDexie = db.getStore().getDexie();
        const alpha = await docsDexie.meta.get("_local/vclock/alpha.md");
        expect(alpha?.value).toEqual({ A: 1, B: 2 });
        const beta = await docsDexie.meta.get("_local/vclock/sub/beta.md");
        expect(beta?.value).toEqual({ A: 3 });

        // Legacy doc is gone from the (separate) meta store.
        const legacy = await meta.getDexie().meta.get(
            "_local/last-synced-vclocks",
        );
        expect(legacy).toBeUndefined();
    });

    it("second load returns same map without re-migrating", async () => {
        db = new LocalDB(`mig2-${Date.now()}`);
        db.open();
        await db.runWrite({
            vclocks: [
                { path: "x.md", op: "set", clock: { A: 1 } },
            ],
        });
        const first = await db.loadAllSyncedVclocks();
        const second = await db.loadAllSyncedVclocks();
        expect(first.get("x.md")).toEqual({ A: 1 });
        expect(second.get("x.md")).toEqual({ A: 1 });
    });

    it("per-path values supersede legacy on conflict", async () => {
        db = new LocalDB(`mig3-${Date.now()}`);
        db.open();
        await db.runWrite({
            vclocks: [{ path: "shared.md", op: "set", clock: { A: 9 } }],
        });
        // Now seed legacy with a stale value for the same path.
        await db.getMetaStore().putMeta("_local/last-synced-vclocks", {
            clocks: { "shared.md": { A: 1 } },
        });
        const loaded = await db.loadAllSyncedVclocks();
        // Per-path wins.
        expect(loaded.get("shared.md")).toEqual({ A: 9 });
    });
});
