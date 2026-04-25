/**
 * Self-healing tests for ConfigLocalDB.
 *
 * Mirrors the LocalDB self-healing pattern. iOS Safari can force-abort
 * in-flight IndexedDB transactions on visibilitychange→hidden, leaving
 * the wrapped DexieStore handle dead. HandleGuard transparently reopens
 * a fresh handle on the next op.
 */

import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { ConfigLocalDB } from "../src/db/config-local-db.ts";
import { makeConfigId } from "../src/types/doc-id.ts";
import type { ConfigDoc } from "../src/types.ts";

function makeConfig(path: string): ConfigDoc {
    return {
        _id: makeConfigId(path),
        type: "config",
        data: "ZGF0YQ==",
        mtime: 1,
        size: 4,
        vclock: { A: 1 },
    };
}

let n = 0;
function freshDb(): ConfigLocalDB {
    const db = new ConfigLocalDB(`configdb-heal-${Date.now()}-${n++}`);
    db.open();
    return db;
}

describe("ConfigLocalDB self-healing (HandleGuard)", () => {
    it("reopens the handle after an explicit close and keeps data intact", async () => {
        const db = freshDb();
        try {
            const c = makeConfig(".obsidian/app.json");
            await db.runWriteTx({ docs: [{ doc: c }] });

            await db.__closeHandleForTest();

            const got = await db.get(c._id);
            expect(got).not.toBeNull();
            expect(got!._id).toBe(c._id);
        } finally {
            await db.close();
        }
    });

    it("ensureHealthy() succeeds on a fresh db and after a forced close", async () => {
        const db = freshDb();
        try {
            await db.ensureHealthy();
            await db.__closeHandleForTest();
            await db.ensureHealthy();
        } finally {
            await db.close();
        }
    });

    it("auto-opens lazily when runOp is called before open()", async () => {
        const db = new ConfigLocalDB(`configdb-lazy-${Date.now()}-${n++}`);
        try {
            // No explicit open(); first op auto-opens.
            const got = await db.get(makeConfigId("missing.json"));
            expect(got).toBeNull();
        } finally {
            await db.close();
        }
    });

    it("destroy clears the handle and a subsequent op auto-opens a fresh DB", async () => {
        const db = freshDb();
        try {
            await db.runWriteTx({ docs: [{ doc: makeConfig(".obsidian/x.json") }] });
            await db.destroy();

            // After destroy(), a fresh op should auto-open a new (empty) DB.
            const got = await db.get(makeConfigId(".obsidian/x.json"));
            expect(got).toBeNull();
        } finally {
            await db.close();
        }
    });
});
