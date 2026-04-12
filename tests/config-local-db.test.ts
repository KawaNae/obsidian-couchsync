/**
 * Tests for ConfigLocalDB — DexieStore-backed config document store.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { DexieStore } from "../src/db/dexie-store.ts";
import { ConfigLocalDB } from "../src/db/config-local-db.ts";
import type { ConfigDoc, CouchSyncDoc } from "../src/types.ts";
import { makeConfigId, makeFileId } from "../src/types/doc-id.ts";

function uniqueName(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function makeConfig(path: string, vclock: Record<string, number> = { test: 1 }): ConfigDoc {
    return {
        _id: makeConfigId(path),
        type: "config",
        data: "ZGF0YQ==", // "data" base64
        mtime: 1000,
        size: 4,
        vclock,
    };
}

describe("ConfigLocalDB", () => {
    let store: DexieStore<CouchSyncDoc>;
    let db: ConfigLocalDB;

    beforeEach(() => {
        store = new DexieStore<CouchSyncDoc>(uniqueName("cdb"));
        db = new ConfigLocalDB(store);
    });

    afterEach(async () => {
        await store.destroy().catch(() => {});
    });

    describe("get / put", () => {
        it("round-trips a config doc", async () => {
            await db.put(makeConfig(".obsidian/app.json"));
            const got = await db.get(makeConfigId(".obsidian/app.json"));
            expect(got).not.toBeNull();
            expect(got!._id).toBe(makeConfigId(".obsidian/app.json"));
            expect(got!.type).toBe("config");
            expect(got!.vclock).toEqual({ test: 1 });
        });

        it("returns null for missing doc", async () => {
            const got = await db.get(makeConfigId("nope.json"));
            expect(got).toBeNull();
        });

        it("put without _rev on existing doc conflicts", async () => {
            await db.put(makeConfig(".obsidian/app.json", { A: 1 }));
            await expect(
                db.put(makeConfig(".obsidian/app.json", { A: 2 })),
            ).rejects.toThrow(/conflict/i);
        });

        it("update performs CAS read-modify-write", async () => {
            await db.put(makeConfig(".obsidian/app.json", { A: 1 }));
            await db.update<ConfigDoc>(makeConfigId(".obsidian/app.json"), (existing) => ({
                ...existing!,
                vclock: { A: 2 },
            }));
            const got = await db.get(makeConfigId(".obsidian/app.json"));
            expect(got!.vclock).toEqual({ A: 2 });
        });

        it("update returns null when fn returns null", async () => {
            await db.put(makeConfig(".obsidian/app.json", { A: 1 }));
            const result = await db.update<ConfigDoc>(
                makeConfigId(".obsidian/app.json"),
                () => null,
            );
            expect(result).toBeNull();
        });
    });

    describe("bulkPut", () => {
        it("writes multiple config docs at once", async () => {
            await db.bulkPut([
                makeConfig(".obsidian/a.json"),
                makeConfig(".obsidian/b.json"),
                makeConfig(".obsidian/c.json"),
            ]);
            const all = await db.allConfigDocs();
            expect(all.length).toBe(3);
        });

        it("preserves revs for already-existing docs", async () => {
            await db.put(makeConfig(".obsidian/a.json", { A: 1 }));
            await db.bulkPut([makeConfig(".obsidian/a.json", { A: 2 })]);
            const got = await db.get(makeConfigId(".obsidian/a.json"));
            expect(got!.vclock).toEqual({ A: 2 });
        });
    });

    describe("allConfigDocs", () => {
        it("returns only ConfigDocs (range-bounded)", async () => {
            await db.put(makeConfig(".obsidian/x.json"));
            await db.put(makeConfig(".obsidian/y.json"));
            // Insert an off-prefix doc directly via DexieStore
            await store.put({
                _id: makeFileId("intruder.md"),
                type: "file",
                chunks: [],
                mtime: 0,
                ctime: 0,
                size: 0,
                vclock: {},
            } as CouchSyncDoc);

            const all = await db.allConfigDocs();
            expect(all.length).toBe(2);
            expect(all.every((d) => d.type === "config")).toBe(true);
        });

        it("returns empty array on empty DB", async () => {
            const all = await db.allConfigDocs();
            expect(all).toEqual([]);
        });
    });

    describe("deleteByPrefix", () => {
        it("deletes all configs and returns their ids", async () => {
            await db.put(makeConfig(".obsidian/a.json"));
            await db.put(makeConfig(".obsidian/b.json"));
            const deleted = await db.deleteByPrefix("config:");
            expect(deleted.length).toBe(2);
            const all = await db.allConfigDocs();
            expect(all).toEqual([]);
        });

        it("returns empty array when nothing matches", async () => {
            const deleted = await db.deleteByPrefix("config:");
            expect(deleted).toEqual([]);
        });
    });

    describe("findLegacyConfigDoc", () => {
        it("returns null for an empty db", async () => {
            expect(await db.findLegacyConfigDoc()).toBeNull();
        });

        it("returns null when all configs have vclock", async () => {
            await db.put(makeConfig(".obsidian/a.json", { A: 1 }));
            await db.put(makeConfig(".obsidian/b.json", { A: 1 }));
            expect(await db.findLegacyConfigDoc()).toBeNull();
        });

        it("returns the id of a config without vclock", async () => {
            // Insert a malformed legacy doc via DexieStore
            await store.put({
                _id: makeConfigId(".obsidian/legacy.json"),
                type: "config",
                data: "",
                mtime: 0,
                size: 0,
            } as unknown as CouchSyncDoc);
            const found = await db.findLegacyConfigDoc();
            expect(found).toBe(makeConfigId(".obsidian/legacy.json"));
        });

        it("returns the id of a non-config doc accidentally living here", async () => {
            await store.put({
                _id: makeFileId("wrong-place.md"),
                type: "file",
                chunks: [],
                mtime: 0,
                ctime: 0,
                size: 0,
                vclock: { A: 1 },
            } as CouchSyncDoc);
            const found = await db.findLegacyConfigDoc();
            expect(found).toBe(makeFileId("wrong-place.md"));
        });
    });
});
