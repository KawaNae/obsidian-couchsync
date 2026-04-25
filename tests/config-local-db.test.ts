/**
 * Tests for ConfigLocalDB — DexieStore-backed config document store.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
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

/** Shorthand: single-doc put via runWriteTx. */
function put(db: ConfigLocalDB, doc: CouchSyncDoc): Promise<void> {
    return db.runWriteTx({ docs: [{ doc }] });
}

describe("ConfigLocalDB", () => {
    let db: ConfigLocalDB;

    beforeEach(() => {
        db = new ConfigLocalDB(uniqueName("cdb"));
        db.open();
    });

    afterEach(async () => {
        await db.destroy().catch(() => {});
    });

    describe("runWrite + get", () => {
        it("round-trips a config doc", async () => {
            await put(db, makeConfig(".obsidian/app.json"));
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

        it("overwrites existing doc without CAS by default", async () => {
            await put(db, makeConfig(".obsidian/app.json", { A: 1 }));
            await put(db, makeConfig(".obsidian/app.json", { A: 2 }));
            const got = await db.get(makeConfigId(".obsidian/app.json"));
            expect(got!.vclock).toEqual({ A: 2 });
        });

        it("expectedVclock CAS rejects stale writes", async () => {
            await put(db, makeConfig(".obsidian/app.json", { A: 1 }));
            await expect(
                db.runWriteTx({
                    docs: [{
                        doc: makeConfig(".obsidian/app.json", { A: 2 }),
                        expectedVclock: { A: 99 }, // wrong
                    }],
                }),
            ).rejects.toMatchObject({ kind: "conflict" });
            const got = await db.get(makeConfigId(".obsidian/app.json"));
            expect(got!.vclock).toEqual({ A: 1 });
        });

        it("builder form performs read-then-update atomically", async () => {
            await put(db, makeConfig(".obsidian/app.json", { A: 1 }));
            const committed = await db.runWriteBuilder(async (snap) => {
                const existing = (await snap.get(makeConfigId(".obsidian/app.json"))) as ConfigDoc | null;
                return {
                    docs: [{
                        doc: { ...existing!, vclock: { A: 2 } },
                        expectedVclock: existing!.vclock,
                    }],
                };
            });
            expect(committed).toBe(true);
            const got = await db.get(makeConfigId(".obsidian/app.json"));
            expect(got!.vclock).toEqual({ A: 2 });
        });

        it("builder returning null is a no-op", async () => {
            const before = await db.info();
            const committed = await db.runWriteBuilder(async () => null);
            expect(committed).toBe(false);
            const after = await db.info();
            expect(after.updateSeq).toBe(before.updateSeq);
        });
    });

    describe("multi-doc runWrite", () => {
        it("writes multiple config docs in one tx", async () => {
            await db.runWriteTx({
                docs: [
                    { doc: makeConfig(".obsidian/a.json") },
                    { doc: makeConfig(".obsidian/b.json") },
                    { doc: makeConfig(".obsidian/c.json") },
                ],
            });
            const all = await db.allConfigDocs();
            expect(all.length).toBe(3);
        });
    });

    describe("allConfigDocs", () => {
        it("returns only ConfigDocs (range-bounded)", async () => {
            await put(db, makeConfig(".obsidian/x.json"));
            await put(db, makeConfig(".obsidian/y.json"));
            // Insert an off-prefix doc directly via the underlying store.
            await db.runWriteTx({
                docs: [{
                    doc: {
                        _id: makeFileId("intruder.md"),
                        type: "file",
                        chunks: [],
                        mtime: 0,
                        ctime: 0,
                        size: 0,
                        vclock: {},
                    } as CouchSyncDoc,
                }],
            });

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
        it("deletes all configs in one tx and returns their ids", async () => {
            await put(db, makeConfig(".obsidian/a.json"));
            await put(db, makeConfig(".obsidian/b.json"));
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
            await put(db, makeConfig(".obsidian/a.json", { A: 1 }));
            await put(db, makeConfig(".obsidian/b.json", { A: 1 }));
            expect(await db.findLegacyConfigDoc()).toBeNull();
        });

        it("returns the id of a config without vclock", async () => {
            // Insert a malformed legacy doc via the underlying store.
            await db.runWriteTx({
                docs: [{
                    doc: {
                        _id: makeConfigId(".obsidian/legacy.json"),
                        type: "config",
                        data: "",
                        mtime: 0,
                        size: 0,
                    } as unknown as CouchSyncDoc,
                }],
            });
            const found = await db.findLegacyConfigDoc();
            expect(found).toBe(makeConfigId(".obsidian/legacy.json"));
        });

        it("returns the id of a non-config doc accidentally living here", async () => {
            await db.runWriteTx({
                docs: [{
                    doc: {
                        _id: makeFileId("wrong-place.md"),
                        type: "file",
                        chunks: [],
                        mtime: 0,
                        ctime: 0,
                        size: 0,
                        vclock: { A: 1 },
                    } as CouchSyncDoc,
                }],
            });
            const found = await db.findLegacyConfigDoc();
            expect(found).toBe(makeFileId("wrong-place.md"));
        });
    });
});
