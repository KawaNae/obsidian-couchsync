/**
 * Tests for DexieStore — Dexie-based IDocStore implementation.
 *
 * Post-Step C refactor: the write paths are `runWriteBuilder` and
 * `runWriteTx`. These tests cover the full surface: builder + fixed-tx
 * forms, atomic batch of docs/chunks/deletes/vclocks/meta, CAS semantics,
 * lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestStore } from "./helpers/dexie-test-store.ts";
import { DexieStore } from "../src/db/dexie-store.ts";
import { DbError } from "../src/db/write-transaction.ts";
import type { FileDoc, ChunkDoc, ConfigDoc, CouchSyncDoc } from "../src/types.ts";
import { makeFileId, makeChunkId, makeConfigId } from "../src/types/doc-id.ts";

// ── Test fixtures ────────────────────────────────────────

function makeFile(path: string, vc: Record<string, number> = { A: 1 }): FileDoc {
    return {
        _id: makeFileId(path),
        type: "file",
        chunks: [],
        mtime: 1000,
        ctime: 1000,
        size: 0,
        vclock: vc,
    };
}

function makeChunk(hash: string, data: string): ChunkDoc {
    return {
        _id: makeChunkId(hash),
        type: "chunk",
        data,
    };
}

function makeConfig(path: string, vc: Record<string, number> = { test: 1 }): ConfigDoc {
    return {
        _id: makeConfigId(path),
        type: "config",
        data: "ZGF0YQ==",
        mtime: 1000,
        size: 4,
        vclock: vc,
    };
}

/** Shorthand: single-doc put via fixed-tx runWriteTx. */
async function put(store: DexieStore<CouchSyncDoc>, doc: CouchSyncDoc): Promise<void> {
    await store.runWriteTx({ docs: [{ doc }] });
}

// ── Suite ────────────────────────────────────────────────

describe("DexieStore", () => {
    let store: DexieStore<CouchSyncDoc>;

    beforeEach(() => {
        store = createTestStore<CouchSyncDoc>("dexie-store");
    });

    afterEach(async () => {
        await store.destroy();
    });

    // ── get + runWrite(tx) ──────────────────────────────

    describe("runWrite (fixed tx) + get", () => {
        it("round-trips a FileDoc", async () => {
            const file = makeFile("hello.md");
            await put(store, file);
            const got = await store.get(file._id);
            expect(got).not.toBeNull();
            expect(got!._id).toBe(file._id);
            expect(got!.type).toBe("file");
            expect((got as FileDoc).vclock).toEqual({ A: 1 });
            expect(got!._rev).toBe("1-dexie");
        });

        it("round-trips a ChunkDoc", async () => {
            const chunk = makeChunk("abc123", "QUFB");
            await put(store, chunk);
            const got = await store.get(chunk._id);
            expect(got).not.toBeNull();
            expect((got as ChunkDoc).data).toBe("QUFB");
        });

        it("round-trips a ConfigDoc", async () => {
            const config = makeConfig(".obsidian/app.json");
            await put(store, config);
            const got = await store.get(config._id);
            expect(got).not.toBeNull();
            expect(got!.type).toBe("config");
        });

        it("returns null for missing doc", async () => {
            expect(await store.get("nonexistent")).toBeNull();
        });

        it("overwrites existing doc without CAS by default", async () => {
            await put(store, makeFile("a.md", { A: 1 }));
            await put(store, makeFile("a.md", { A: 2 }));
            const got = await store.get(makeFileId("a.md"));
            expect((got as FileDoc).vclock).toEqual({ A: 2 });
            expect(got!._rev).toBe("2-dexie");
        });

        it("vclock CAS rejects stale writes", async () => {
            await put(store, makeFile("a.md", { A: 1 }));
            await expect(
                store.runWriteTx({
                    docs: [{
                        doc: makeFile("a.md", { A: 2 }),
                        expectedVclock: { A: 99 }, // wrong
                    }],
                }),
            ).rejects.toMatchObject({ kind: "conflict" });
            const got = await store.get(makeFileId("a.md"));
            expect((got as FileDoc).vclock).toEqual({ A: 1 });
        });
    });

    // ── chunks (content-addressed put-if-absent) ────────

    describe("chunks", () => {
        it("writes fresh chunks via runWrite.chunks", async () => {
            const chunks = [makeChunk("aaa", "AAAA"), makeChunk("bbb", "BBBB")];
            await store.runWriteTx({ chunks });
            expect(await store.get(chunks[0]._id)).not.toBeNull();
            expect(await store.get(chunks[1]._id)).not.toBeNull();
        });

        it("skips duplicate content-addressed chunks silently", async () => {
            const chunk = makeChunk("ccc", "CCCC");
            await store.runWriteTx({ chunks: [chunk] });
            // Same chunk id again — no throw, no version bump.
            await store.runWriteTx({ chunks: [chunk] });
            const got = await store.get(chunk._id);
            expect(got!._rev).toBe("1-dexie"); // still version 1
        });

        it("empty tx still consumes one _update_seq (opaque marker)", async () => {
            // A no-op runWrite still opens a tx and bumps seq — documented
            // behaviour so callers can't rely on seq as a "real write" counter.
            const before = await store.info();
            await store.runWriteTx({});
            const after = await store.info();
            expect((after.updateSeq as number) - (before.updateSeq as number)).toBe(1);
        });
    });

    // ── deletes ─────────────────────────────────────────

    describe("deletes", () => {
        it("removes an existing doc", async () => {
            await put(store, makeFile("a.md"));
            await store.runWriteTx({ deletes: [makeFileId("a.md")] });
            expect(await store.get(makeFileId("a.md"))).toBeNull();
        });

        it("is a no-op for nonexistent id", async () => {
            await expect(
                store.runWriteTx({ deletes: ["nonexistent"] }),
            ).resolves.toBeUndefined();
        });

        it("batches multiple deletes in one tx (one seq bump)", async () => {
            await put(store, makeFile("a.md"));
            await put(store, makeFile("b.md"));
            await put(store, makeFile("c.md"));
            const before = await store.info();
            await store.runWriteTx({
                deletes: [makeFileId("a.md"), makeFileId("b.md"), makeFileId("c.md")],
            });
            const after = await store.info();
            expect((after.updateSeq as number) - (before.updateSeq as number)).toBe(1);
            expect(await store.get(makeFileId("a.md"))).toBeNull();
            expect(await store.get(makeFileId("b.md"))).toBeNull();
            expect(await store.get(makeFileId("c.md"))).toBeNull();
        });
    });

    // ── runWrite (builder form) ─────────────────────────

    describe("runWrite (builder)", () => {
        it("builder sees snapshot and commits", async () => {
            const fileId = makeFileId("b.md");
            const committed = await store.runWriteBuilder(async (snap) => {
                expect(await snap.get(fileId)).toBeNull();
                return { docs: [{ doc: makeFile("b.md", { A: 1 }) }] };
            });
            expect(committed).toBe(true);
            expect(await store.get(fileId)).not.toBeNull();
        });

        it("null return is a side-effect-free no-op", async () => {
            const before = await store.info();
            const committed = await store.runWriteBuilder(async () => null);
            expect(committed).toBe(false);
            const after = await store.info();
            expect(after.updateSeq).toBe(before.updateSeq);
        });

        it("retries on vclock CAS conflict", async () => {
            const fileId = makeFileId("race.md");
            await put(store, makeFile("race.md", { A: 1 }));
            let calls = 0;
            const committed = await store.runWriteBuilder(async (snap) => {
                calls++;
                const cur = (await snap.get(fileId)) as FileDoc;
                const stale = calls === 1 ? { A: 0 } : cur.vclock;
                return {
                    docs: [{
                        doc: { ...cur, vclock: { A: (cur.vclock.A ?? 0) + 1 } },
                        expectedVclock: stale,
                    }],
                };
            });
            expect(committed).toBe(true);
            expect(calls).toBe(2);
            const got = (await store.get(fileId)) as FileDoc;
            expect(got.vclock).toEqual({ A: 2 });
        });

        it("throws DbError(conflict) after exhausting maxAttempts", async () => {
            await put(store, makeFile("exh.md", { A: 1 }));
            await expect(
                store.runWriteBuilder(
                    async () => ({
                        docs: [{
                            doc: makeFile("exh.md", { A: 2 }),
                            expectedVclock: { ghost: 99 },
                        }],
                    }),
                    { maxAttempts: 2 },
                ),
            ).rejects.toMatchObject({ kind: "conflict", recovery: "fail" });
        });

        it("onCommit fires once after a successful commit", async () => {
            let fired = 0;
            await store.runWriteBuilder(async () => ({
                meta: [{ op: "put", key: "k", value: 1 }],
                onCommit: () => { fired++; },
            }));
            expect(fired).toBe(1);
        });

        it("onCommit does NOT fire when the builder aborts", async () => {
            let fired = 0;
            await expect(
                store.runWriteBuilder(
                    async () => ({
                        docs: [{
                            doc: makeFile("z.md"),
                            expectedVclock: { ghost: 7 },
                        }],
                        onCommit: () => { fired++; },
                    }),
                    { maxAttempts: 1 },
                ),
            ).rejects.toThrow();
            expect(fired).toBe(0);
        });
    });

    // ── compound atomic batch ───────────────────────────

    describe("runWrite atomic batch", () => {
        it("writes docs + chunks + vclocks + meta in one tx", async () => {
            const fileId = makeFileId("compound.md");
            const chunk = makeChunk("ch1", "Y2g=");
            await store.runWriteTx({
                chunks: [chunk],
                docs: [{ doc: { ...makeFile("compound.md", { A: 1 }), chunks: [chunk._id] } }],
                vclocks: [{ path: "compound.md", op: "set", clock: { A: 1 } }],
                meta: [{ op: "put", key: "marker", value: 42 }],
            });

            expect(await store.get(fileId)).not.toBeNull();
            expect(await store.get(chunk._id)).not.toBeNull();
            expect(await store.getMeta("marker")).toBe(42);
            expect(
                await store.getDexie().meta.get("_local/vclock/compound.md"),
            ).toMatchObject({ value: { A: 1 } });
        });

        it("bumps _update_seq exactly once per compound tx", async () => {
            const before = await store.info();
            await store.runWriteTx({
                chunks: [makeChunk("a", "QQ=="), makeChunk("b", "Qg==")],
                docs: [{ doc: { ...makeFile("seq.md"), chunks: ["chunk:a", "chunk:b"] } }],
                vclocks: [{ path: "seq.md", op: "set", clock: { A: 1 } }],
            });
            const after = await store.info();
            expect((after.updateSeq as number) - (before.updateSeq as number)).toBe(1);
        });

        it("vclock op delete removes the meta entry", async () => {
            await store.runWriteTx({
                vclocks: [{ path: "p", op: "set", clock: { A: 5 } }],
            });
            expect(await store.getDexie().meta.get("_local/vclock/p")).toBeDefined();
            await store.runWriteTx({
                vclocks: [{ path: "p", op: "delete" }],
            });
            expect(await store.getDexie().meta.get("_local/vclock/p")).toBeUndefined();
        });

        it("classifies thrown errors as DbError with recovery", async () => {
            try {
                await store.runWriteTx({
                    docs: [{
                        doc: makeFile("err.md"),
                        expectedVclock: { ghost: 42 },
                    }],
                });
                throw new Error("expected throw");
            } catch (e: any) {
                expect(e).toBeInstanceOf(DbError);
                expect(e.kind).toBe("conflict");
                expect(e.recovery).toBe("fail");
            }
        });
    });

    // ── chunk-equivalent of atomicFileWrite (builder) ──

    describe("atomic file write (builder form)", () => {
        it("writes chunks + FileDoc atomically via runWrite builder", async () => {
            const chunk1 = makeChunk("h1", "Y2h1bmsx");
            const chunk2 = makeChunk("h2", "Y2h1bmsy");
            const fileId = makeFileId("atomic.md");

            const committed = await store.runWriteBuilder(async () => ({
                chunks: [chunk1, chunk2],
                docs: [{
                    doc: {
                        _id: fileId,
                        type: "file",
                        chunks: [chunk1._id, chunk2._id],
                        mtime: 1000,
                        ctime: 1000,
                        size: 10,
                        vclock: { A: 1 },
                    } as FileDoc,
                }],
            }));
            expect(committed).toBe(true);

            expect(await store.get(chunk1._id)).not.toBeNull();
            expect(await store.get(chunk2._id)).not.toBeNull();
            const doc = (await store.get(fileId)) as FileDoc;
            expect(doc.chunks).toEqual([chunk1._id, chunk2._id]);
        });

        it("aborting via null return writes nothing — no orphan chunks", async () => {
            const chunk = makeChunk("unused", "dW51c2Vk");
            const fileId = makeFileId("abort.md");
            const committed = await store.runWriteBuilder(async () => null);
            expect(committed).toBe(false);
            expect(await store.get(fileId)).toBeNull();
            expect(await store.get(chunk._id)).toBeNull();
        });

        it("increments version on subsequent write", async () => {
            const fileId = makeFileId("version.md");
            await store.runWriteTx({
                docs: [{
                    doc: {
                        _id: fileId, type: "file", chunks: [],
                        mtime: 1, ctime: 1, size: 0, vclock: { A: 1 },
                    } as FileDoc,
                }],
            });
            const first = await store.get(fileId);
            expect(first!._rev).toBe("1-dexie");

            await store.runWriteBuilder(async (snap) => {
                const existing = (await snap.get(fileId)) as FileDoc;
                return {
                    docs: [{
                        doc: { ...existing, mtime: 2, vclock: { A: 2 } },
                        expectedVclock: existing.vclock,
                    }],
                };
            });
            const second = await store.get(fileId);
            expect(second!._rev).toBe("2-dexie");
        });
    });

    // ── allDocs ─────────────────────────────────────────

    describe("allDocs", () => {
        it("returns all docs sorted by _id", async () => {
            await put(store, makeFile("b.md"));
            await put(store, makeFile("a.md"));
            await put(store, makeFile("c.md"));

            const result = await store.allDocs();
            expect(result.rows).toHaveLength(3);
            expect(result.rows[0].id).toBe(makeFileId("a.md"));
            expect(result.rows[1].id).toBe(makeFileId("b.md"));
            expect(result.rows[2].id).toBe(makeFileId("c.md"));
        });

        it("includes docs when include_docs is true", async () => {
            await put(store, makeFile("a.md"));
            const result = await store.allDocs({ include_docs: true });
            expect(result.rows[0].doc).not.toBeUndefined();
            expect(result.rows[0].doc!._id).toBe(makeFileId("a.md"));
        });

        it("omits docs when include_docs is false", async () => {
            await put(store, makeFile("a.md"));
            const result = await store.allDocs();
            expect(result.rows[0].doc).toBeUndefined();
        });

        it("range query with startkey/endkey", async () => {
            await put(store, makeFile("a.md"));
            await put(store, makeConfig(".obsidian/app.json"));
            await put(store, makeChunk("xxx", "data"));

            const result = await store.allDocs({
                startkey: "file:",
                endkey: "file:\ufff0",
            });
            expect(result.rows).toHaveLength(1);
            expect(result.rows[0].id).toBe(makeFileId("a.md"));
        });

        it("keys query fetches specific docs", async () => {
            await put(store, makeFile("a.md"));
            await put(store, makeFile("b.md"));
            await put(store, makeFile("c.md"));

            const result = await store.allDocs({
                keys: [makeFileId("a.md"), makeFileId("c.md")],
            });
            expect(result.rows).toHaveLength(2);
        });

        it("keys query omits missing docs", async () => {
            await put(store, makeFile("a.md"));
            const result = await store.allDocs({
                keys: [makeFileId("a.md"), makeFileId("missing.md")],
            });
            expect(result.rows).toHaveLength(1);
        });

        it("limit constrains result count", async () => {
            await put(store, makeFile("a.md"));
            await put(store, makeFile("b.md"));
            await put(store, makeFile("c.md"));

            const result = await store.allDocs({ limit: 2 });
            expect(result.rows).toHaveLength(2);
        });

        it("returns empty for empty store", async () => {
            const result = await store.allDocs();
            expect(result.rows).toEqual([]);
        });

        it("row.value.rev matches doc version", async () => {
            await put(store, makeFile("a.md"));
            const result = await store.allDocs();
            expect(result.rows[0].value.rev).toBe("1-dexie");
        });
    });

    // ── listIds (id-only range scan, no body load) ──────

    describe("listIds", () => {
        it("returns ids in lex order, inclusive bounds, body never loaded", async () => {
            await put(store, makeChunk("b", "data"));
            await put(store, makeChunk("a", "data"));
            await put(store, makeChunk("c", "data"));
            await put(store, makeFile("f.md"));

            const ids = await store.listIds({
                startkey: "chunk:",
                endkey: "chunk:\ufff0",
            });
            expect(ids).toEqual([
                makeChunkId("a"),
                makeChunkId("b"),
                makeChunkId("c"),
            ]);
        });

        it("honours limit", async () => {
            await put(store, makeChunk("a", "x"));
            await put(store, makeChunk("b", "x"));
            await put(store, makeChunk("c", "x"));
            const ids = await store.listIds({
                startkey: "chunk:",
                endkey: "chunk:\ufff0",
                limit: 2,
            });
            expect(ids).toEqual([makeChunkId("a"), makeChunkId("b")]);
        });

        it("returns empty array when range is empty", async () => {
            const ids = await store.listIds({
                startkey: "chunk:",
                endkey: "chunk:\ufff0",
            });
            expect(ids).toEqual([]);
        });

        it("startkey advances for paging via lastId + \\x00", async () => {
            await put(store, makeChunk("a", "x"));
            await put(store, makeChunk("b", "x"));
            await put(store, makeChunk("c", "x"));
            const first = await store.listIds({
                startkey: "chunk:",
                endkey: "chunk:\ufff0",
                limit: 1,
            });
            expect(first).toEqual([makeChunkId("a")]);
            const second = await store.listIds({
                startkey: first[0] + "\x00",
                endkey: "chunk:\ufff0",
                limit: 1,
            });
            expect(second).toEqual([makeChunkId("b")]);
        });
    });

    // ── info ────────────────────────────────────────────

    describe("info", () => {
        it("returns updateSeq 0 on empty store", async () => {
            const info = await store.info();
            expect(info.updateSeq).toBe(0);
        });

        it("updateSeq advances on each runWrite", async () => {
            await put(store, makeFile("a.md"));
            const info = await store.info();
            expect(info.updateSeq).toBe(1);
        });
    });

    // ── meta read + prefix ──────────────────────────────

    describe("meta read surface", () => {
        it("round-trips a meta value via runWrite + getMeta", async () => {
            await store.runWriteTx({
                meta: [{ op: "put", key: "scan-cursor", value: { lastScanStartedAt: 1000 } }],
            });
            expect(await store.getMeta("scan-cursor"))
                .toEqual({ lastScanStartedAt: 1000 });
        });

        it("returns null for missing key", async () => {
            expect(await store.getMeta("nonexistent")).toBeNull();
        });

        it("runWrite overwrites existing meta", async () => {
            await store.runWriteTx({ meta: [{ op: "put", key: "k", value: "v1" }] });
            await store.runWriteTx({ meta: [{ op: "put", key: "k", value: "v2" }] });
            expect(await store.getMeta("k")).toBe("v2");
        });

        it("runWrite can delete meta", async () => {
            await store.runWriteTx({ meta: [{ op: "put", key: "k", value: "value" }] });
            await store.runWriteTx({ meta: [{ op: "delete", key: "k" }] });
            expect(await store.getMeta("k")).toBeNull();
        });

        it("getMetaByPrefix returns all matching entries", async () => {
            await store.runWriteTx({
                vclocks: [
                    { path: "a.md", op: "set", clock: { A: 1 } },
                    { path: "sub/b.md", op: "set", clock: { B: 2 } },
                ],
            });
            const rows = await store.getMetaByPrefix("_local/vclock/");
            const map = new Map(rows.map((r) => [r.key, r.value]));
            expect(map.get("_local/vclock/a.md")).toEqual({ A: 1 });
            expect(map.get("_local/vclock/sub/b.md")).toEqual({ B: 2 });
        });
    });

    // ── lifecycle ───────────────────────────────────────

    describe("lifecycle", () => {
        it("close is idempotent", async () => {
            await store.close();
            await store.close();
        });

        it("destroy removes the database", async () => {
            await put(store, makeFile("a.md"));
            await store.destroy();
            // destroy should not throw; we can't verify absence because
            // the DB name was unique per test.
        });
    });
});
