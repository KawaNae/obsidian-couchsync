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
        // Seed the legacy doc directly via the meta store.
        await db.runMetaWriteTx({
            meta: [{
                op: "put",
                key: "_local/last-synced-vclocks",
                value: {
                    clocks: {
                        "alpha.md": { A: 1, B: 2 },
                        "sub/beta.md": { A: 3 },
                    },
                },
            }],
        });

        // First load — should migrate. Legacy entries lack chunks/size
        // (the old layout didn't track them); they get the partial
        // LastSynced shape and ramp up on the next push/pull.
        const loaded = await db.loadAllSyncedVclocks();
        expect(loaded.get("alpha.md")).toEqual({ vclock: { A: 1, B: 2 } });
        expect(loaded.get("sub/beta.md")).toEqual({ vclock: { A: 3 } });

        // Legacy doc is gone from the (separate) meta store.
        const legacy = await db.getMetaStoreValue("_local/last-synced-vclocks");
        expect(legacy).toBeNull();
    });

    it("second load returns same map without re-migrating", async () => {
        db = new LocalDB(`mig2-${Date.now()}`);
        db.open();
        await db.runWriteTx({
            vclocks: [
                { path: "x.md", op: "set", clock: { A: 1 }, chunks: ["c1"], size: 5 },
            ],
        });
        const first = await db.loadAllSyncedVclocks();
        const second = await db.loadAllSyncedVclocks();
        const expected = { vclock: { A: 1 }, chunks: ["c1"], size: 5 };
        expect(first.get("x.md")).toEqual(expected);
        expect(second.get("x.md")).toEqual(expected);
    });

    it("per-path values supersede legacy on conflict", async () => {
        db = new LocalDB(`mig3-${Date.now()}`);
        db.open();
        await db.runWriteTx({
            vclocks: [{
                path: "shared.md", op: "set", clock: { A: 9 },
                chunks: ["c1"], size: 7,
            }],
        });
        // Now seed legacy with a stale value for the same path.
        await db.runMetaWriteTx({
            meta: [{
                op: "put",
                key: "_local/last-synced-vclocks",
                value: { clocks: { "shared.md": { A: 1 } } },
            }],
        });
        const loaded = await db.loadAllSyncedVclocks();
        // Per-path wins (full new shape).
        expect(loaded.get("shared.md")).toEqual({
            vclock: { A: 9 }, chunks: ["c1"], size: 7,
        });
    });

    it("treats pre-extension entries (raw VectorClock value) as legacy", async () => {
        // Pre-extension write: someone wrote a raw VectorClock to the
        // vclock meta key (matches the old DexieStore.runWriteTx code).
        db = new LocalDB(`mig4-${Date.now()}`);
        db.open();
        await db.runWriteTx({
            meta: [{
                op: "put",
                key: "_local/vclock/legacy.md",
                value: { A: 7, B: 3 } as any,
            }],
        });
        const loaded = await db.loadAllSyncedVclocks();
        // chunks/size undefined → divergent-edit guard skips the path
        // until the next push/pull rewrites it in the full shape.
        expect(loaded.get("legacy.md")).toEqual({ vclock: { A: 7, B: 3 } });
    });
});
