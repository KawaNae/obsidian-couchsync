/**
 * Tests for DexieStore — Dexie-based ILocalStore implementation.
 *
 * Covers all ILocalStore methods plus DexieStore-specific features
 * (meta table, CAS semantics). Uses fake-indexeddb for Node/Vitest.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestStore } from "./helpers/dexie-test-store.ts";
import { DexieStore } from "../src/db/dexie-store.ts";
import type { FileDoc, ChunkDoc, ConfigDoc, CouchSyncDoc } from "../src/types.ts";
import { makeFileId, makeChunkId, makeConfigId } from "../src/types/doc-id.ts";

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

describe("DexieStore", () => {
    let store: DexieStore<CouchSyncDoc>;

    beforeEach(() => {
        store = createTestStore<CouchSyncDoc>("dexie-store");
    });

    afterEach(async () => {
        await store.destroy();
    });

    // ── get / put ───────────────────────────────────────

    describe("get / put", () => {
        it("round-trips a FileDoc", async () => {
            const file = makeFile("hello.md");
            const resp = await store.put(file);
            expect(resp.ok).toBe(true);
            expect(resp.id).toBe(file._id);
            expect(resp.rev).toBe("1-dexie");

            const got = await store.get(file._id);
            expect(got).not.toBeNull();
            expect(got!._id).toBe(file._id);
            expect(got!.type).toBe("file");
            expect((got as FileDoc).vclock).toEqual({ A: 1 });
            expect(got!._rev).toBe("1-dexie");
        });

        it("round-trips a ChunkDoc", async () => {
            const chunk = makeChunk("abc123", "QUFB");
            await store.put(chunk);
            const got = await store.get(chunk._id);
            expect(got).not.toBeNull();
            expect((got as ChunkDoc).data).toBe("QUFB");
        });

        it("round-trips a ConfigDoc", async () => {
            const config = makeConfig(".obsidian/app.json");
            await store.put(config);
            const got = await store.get(config._id);
            expect(got).not.toBeNull();
            expect(got!.type).toBe("config");
        });

        it("returns null for missing doc", async () => {
            const got = await store.get("nonexistent");
            expect(got).toBeNull();
        });

        it("updates existing doc (increments version)", async () => {
            const file = makeFile("a.md", { A: 1 });
            const r1 = await store.put(file);
            expect(r1.rev).toBe("1-dexie");

            const existing = await store.get(file._id);
            const r2 = await store.put({ ...existing!, vclock: { A: 2 } } as CouchSyncDoc);
            expect(r2.rev).toBe("2-dexie");

            const got = await store.get(file._id);
            expect((got as FileDoc).vclock).toEqual({ A: 2 });
        });

        it("put without _rev on existing doc conflicts (CAS)", async () => {
            await store.put(makeFile("a.md", { A: 1 }));
            // Put again without fetching _rev — stale write
            await expect(
                store.put(makeFile("a.md", { A: 2 })),
            ).rejects.toThrow(/conflict/i);
        });

        it("throws on missing _id", async () => {
            await expect(
                store.put({ type: "file" } as any),
            ).rejects.toThrow(/_id/);
        });
    });

    // ── update (CAS) ────────────────────────────────────

    describe("update (CAS)", () => {
        it("creates a new doc when none exists", async () => {
            const resp = await store.update<FileDoc>(makeFileId("new.md"), (existing) => {
                expect(existing).toBeNull();
                return makeFile("new.md");
            });
            expect(resp).not.toBeNull();
            expect(resp!.rev).toBe("1-dexie");

            const got = await store.get(makeFileId("new.md"));
            expect((got as FileDoc).vclock).toEqual({ A: 1 });
        });

        it("reads existing and applies update", async () => {
            await store.put(makeFile("a.md", { A: 1 }));
            await store.update<FileDoc>(makeFileId("a.md"), (existing) => ({
                ...existing!,
                vclock: { A: 2 },
            }));
            const got = await store.get(makeFileId("a.md"));
            expect((got as FileDoc).vclock).toEqual({ A: 2 });
        });

        it("skips write when fn returns null", async () => {
            await store.put(makeFile("a.md", { A: 1 }));
            const result = await store.update<FileDoc>(makeFileId("a.md"), () => null);
            expect(result).toBeNull();
        });

        it("retries on concurrent write", async () => {
            await store.put(makeFile("a.md", { A: 1 }));
            let callCount = 0;

            await store.update<FileDoc>(makeFileId("a.md"), (existing) => {
                callCount++;
                if (callCount === 1) {
                    // Simulate concurrent write by directly mutating DB
                    store.getDexie().docs.put({
                        ...(existing as any),
                        _id: makeFileId("a.md"),
                        _version: 2,
                        vclock: { A: 99 },
                    });
                }
                return { ...existing!, vclock: { A: callCount * 10 } };
            });

            expect(callCount).toBe(2);
            const got = await store.get(makeFileId("a.md"));
            expect((got as FileDoc).vclock).toEqual({ A: 20 });
        });

        it("throws after exhausting retries", async () => {
            await store.put(makeFile("a.md", { A: 1 }));
            let callCount = 0;

            await expect(
                store.update<FileDoc>(
                    makeFileId("a.md"),
                    (existing) => {
                        callCount++;
                        // Always cause a version mismatch
                        store.getDexie().docs.put({
                            ...(existing as any),
                            _id: makeFileId("a.md"),
                            _version: 100 + callCount,
                            vclock: { A: callCount * 100 },
                        });
                        return { ...existing!, vclock: { A: callCount } };
                    },
                    2,
                ),
            ).rejects.toThrow(/conflict/i);

            expect(callCount).toBe(3);
        });
    });

    // ── bulkPut ─────────────────────────────────────────

    describe("bulkPut", () => {
        it("writes multiple docs at once", async () => {
            const chunks: ChunkDoc[] = [
                makeChunk("aaa", "AAAA"),
                makeChunk("bbb", "BBBB"),
            ];
            const results = await store.bulkPut(chunks);
            expect(results).toHaveLength(2);
            expect(results[0].ok).toBe(true);
            expect(results[1].ok).toBe(true);
        });

        it("tolerates duplicate content-addressed chunks", async () => {
            const chunk = makeChunk("ccc", "CCCC");
            await store.put(chunk);
            // Same chunk ID again — should tolerate silently
            const results = await store.bulkPut([chunk]);
            expect(results).toHaveLength(1);
            expect(results[0].ok).toBe(true);
        });

        it("updates existing docs (increments version)", async () => {
            await store.put(makeFile("a.md", { A: 1 }));
            await store.bulkPut([makeFile("a.md", { A: 2 })]);
            const got = await store.get(makeFileId("a.md"));
            expect((got as FileDoc).vclock).toEqual({ A: 2 });
        });

        it("returns empty for empty input", async () => {
            const results = await store.bulkPut([]);
            expect(results).toEqual([]);
        });
    });

    // ── delete ──────────────────────────────────────────

    describe("delete", () => {
        it("removes an existing doc", async () => {
            await store.put(makeFile("a.md"));
            await store.delete(makeFileId("a.md"));
            const got = await store.get(makeFileId("a.md"));
            expect(got).toBeNull();
        });

        it("is a no-op for nonexistent doc", async () => {
            await expect(store.delete("nonexistent")).resolves.toBeUndefined();
        });
    });

    // ── allDocs ─────────────────────────────────────────

    describe("allDocs", () => {
        it("returns all docs sorted by _id", async () => {
            await store.put(makeFile("b.md"));
            await store.put(makeFile("a.md"));
            await store.put(makeFile("c.md"));

            const result = await store.allDocs();
            expect(result.rows).toHaveLength(3);
            expect(result.rows[0].id).toBe(makeFileId("a.md"));
            expect(result.rows[1].id).toBe(makeFileId("b.md"));
            expect(result.rows[2].id).toBe(makeFileId("c.md"));
        });

        it("includes docs when include_docs is true", async () => {
            await store.put(makeFile("a.md"));
            const result = await store.allDocs({ include_docs: true });
            expect(result.rows[0].doc).not.toBeUndefined();
            expect(result.rows[0].doc!._id).toBe(makeFileId("a.md"));
        });

        it("omits docs when include_docs is false", async () => {
            await store.put(makeFile("a.md"));
            const result = await store.allDocs();
            expect(result.rows[0].doc).toBeUndefined();
        });

        it("range query with startkey/endkey", async () => {
            await store.put(makeFile("a.md"));
            await store.put(makeConfig(".obsidian/app.json"));
            await store.put(makeChunk("xxx", "data"));

            const result = await store.allDocs({
                startkey: "file:",
                endkey: "file:\ufff0",
            });
            expect(result.rows).toHaveLength(1);
            expect(result.rows[0].id).toBe(makeFileId("a.md"));
        });

        it("keys query fetches specific docs", async () => {
            await store.put(makeFile("a.md"));
            await store.put(makeFile("b.md"));
            await store.put(makeFile("c.md"));

            const result = await store.allDocs({
                keys: [makeFileId("a.md"), makeFileId("c.md")],
            });
            expect(result.rows).toHaveLength(2);
        });

        it("keys query omits missing docs", async () => {
            await store.put(makeFile("a.md"));
            const result = await store.allDocs({
                keys: [makeFileId("a.md"), makeFileId("missing.md")],
            });
            expect(result.rows).toHaveLength(1);
        });

        it("limit constrains result count", async () => {
            await store.put(makeFile("a.md"));
            await store.put(makeFile("b.md"));
            await store.put(makeFile("c.md"));

            const result = await store.allDocs({ limit: 2 });
            expect(result.rows).toHaveLength(2);
        });

        it("returns empty for empty store", async () => {
            const result = await store.allDocs();
            expect(result.rows).toEqual([]);
        });

        it("row.value.rev matches doc version", async () => {
            await store.put(makeFile("a.md"));
            const result = await store.allDocs();
            expect(result.rows[0].value.rev).toBe("1-dexie");
        });
    });

    // ── info ────────────────────────────────────────────

    describe("info", () => {
        it("returns updateSeq (doc count as default)", async () => {
            const info = await store.info();
            expect(info.updateSeq).toBe(0);
        });

        it("updateSeq reflects written docs", async () => {
            await store.put(makeFile("a.md"));
            const info = await store.info();
            // put() internally bumps the seq counter
            expect(info.updateSeq).toBe(1);
        });
    });

    // ── meta table ──────────────────────────────────────

    describe("meta table", () => {
        it("round-trips a meta value", async () => {
            await store.putMeta("scan-cursor", { lastScanStartedAt: 1000 });
            const got = await store.getMeta("scan-cursor");
            expect(got).toEqual({ lastScanStartedAt: 1000 });
        });

        it("returns null for missing key", async () => {
            const got = await store.getMeta("nonexistent");
            expect(got).toBeNull();
        });

        it("overwrites existing meta", async () => {
            await store.putMeta("key", "v1");
            await store.putMeta("key", "v2");
            expect(await store.getMeta("key")).toBe("v2");
        });

        it("deletes meta", async () => {
            await store.putMeta("key", "value");
            await store.deleteMeta("key");
            expect(await store.getMeta("key")).toBeNull();
        });
    });

    // ── close / destroy ─────────────────────────────────

    // ── atomicFileWrite ──────────────────────────────────

    describe("atomicFileWrite", () => {
        it("writes chunks and FileDoc atomically", async () => {
            const chunk1 = makeChunk("h1", "Y2h1bmsx");
            const chunk2 = makeChunk("h2", "Y2h1bmsy");
            const fileId = makeFileId("atomic.md");

            const result = await store.atomicFileWrite<FileDoc>(
                fileId,
                [chunk1, chunk2],
                (_existing) => ({
                    _id: fileId,
                    type: "file",
                    chunks: [chunk1._id, chunk2._id],
                    mtime: 1000,
                    ctime: 1000,
                    size: 10,
                    vclock: { A: 1 },
                }),
            );

            expect(result).not.toBeNull();
            expect(result!.ok).toBe(true);

            // Both chunks should exist.
            const c1 = await store.get(chunk1._id);
            const c2 = await store.get(chunk2._id);
            expect(c1).not.toBeNull();
            expect(c2).not.toBeNull();

            // FileDoc should exist with correct chunks.
            const doc = await store.get(fileId) as FileDoc;
            expect(doc).not.toBeNull();
            expect(doc.chunks).toEqual([chunk1._id, chunk2._id]);
        });

        it("skips existing chunks (content-addressed)", async () => {
            const chunk = makeChunk("existing", "ZXhpc3Q=");
            await store.put(chunk);
            const fileId = makeFileId("reuse.md");

            await store.atomicFileWrite<FileDoc>(
                fileId,
                [chunk],
                () => ({
                    _id: fileId,
                    type: "file",
                    chunks: [chunk._id],
                    mtime: 1000,
                    ctime: 1000,
                    size: 5,
                    vclock: { A: 1 },
                }),
            );

            // FileDoc written, chunk still exists (not duplicated).
            const doc = await store.get(fileId);
            expect(doc).not.toBeNull();
        });

        it("aborts when buildDoc returns null — nothing written", async () => {
            const chunk = makeChunk("unused", "dW51c2Vk");
            const fileId = makeFileId("abort.md");

            const result = await store.atomicFileWrite<FileDoc>(
                fileId,
                [chunk],
                () => null,
            );

            expect(result).toBeNull();
            // FileDoc should not exist.
            const doc = await store.get(fileId);
            expect(doc).toBeNull();
            // Chunks should also not exist (abort is side-effect-free).
            const chunkDoc = await store.get(chunk._id);
            expect(chunkDoc).toBeNull();
        });

        it("increments version on update", async () => {
            const fileId = makeFileId("version.md");
            // First write
            await store.atomicFileWrite<FileDoc>(
                fileId,
                [],
                () => ({
                    _id: fileId, type: "file", chunks: [],
                    mtime: 1, ctime: 1, size: 0, vclock: { A: 1 },
                }),
            );

            // Second write
            const result = await store.atomicFileWrite<FileDoc>(
                fileId,
                [],
                (existing) => ({
                    ...existing!,
                    mtime: 2,
                    vclock: { A: 2 },
                }),
            );

            expect(result!.rev).toBe("2-dexie");
        });
    });

    // ── runWrite (atomic compound batch) ────────────────

    describe("runWrite", () => {
        it("writes docs + chunks + vclocks + meta in one tx", async () => {
            const fileId = makeFileId("compound.md");
            const chunk = makeChunk("ch1", "Y2g=");
            await store.runWrite({
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

        it("a single tx bumps _update_seq exactly once", async () => {
            const before = await store.info();
            const fileId = makeFileId("seq.md");
            await store.runWrite({
                chunks: [makeChunk("a", "QQ=="), makeChunk("b", "Qg==")],
                docs: [{ doc: { ...makeFile("seq.md"), chunks: ["chunk:a", "chunk:b"] } }],
                vclocks: [{ path: "seq.md", op: "set", clock: { A: 1 } }],
            });
            const after = await store.info();
            expect((after.updateSeq as number) - (before.updateSeq as number)).toBe(1);
        });

        it("vclock CAS rejects mismatch", async () => {
            const fileId = makeFileId("cas.md");
            await store.runWrite({
                docs: [{ doc: makeFile("cas.md", { A: 1 }) }],
                vclocks: [{ path: "cas.md", op: "set", clock: { A: 1 } }],
            });
            await expect(
                store.runWrite({
                    docs: [{
                        doc: makeFile("cas.md", { A: 2 }),
                        expectedVclock: { A: 99 }, // wrong
                    }],
                }),
            ).rejects.toThrow(/CAS failed/);
            // Original doc untouched.
            const got = await store.get(fileId);
            expect((got as FileDoc).vclock).toEqual({ A: 1 });
        });

        it("vclock op delete removes the meta entry", async () => {
            await store.runWrite({
                vclocks: [{ path: "p", op: "set", clock: { A: 5 } }],
            });
            expect(await store.getDexie().meta.get("_local/vclock/p")).toBeDefined();
            await store.runWrite({
                vclocks: [{ path: "p", op: "delete" }],
            });
            expect(await store.getDexie().meta.get("_local/vclock/p")).toBeUndefined();
        });

        it("getMetaByPrefix returns all per-path vclocks", async () => {
            await store.runWrite({
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

        it("classifies thrown errors as DbError", async () => {
            // Force a synthetic conflict via expectedVclock CAS failure.
            try {
                await store.runWrite({
                    docs: [{
                        doc: makeFile("err.md"),
                        expectedVclock: { ghost: 42 },
                    }],
                });
                throw new Error("expected throw");
            } catch (e: any) {
                expect(e.constructor.name).toBe("DbError");
                expect(e.kind).toBe("conflict");
            }
        });

        it("deletes via runWrite remove the doc", async () => {
            const fileId = makeFileId("dele.md");
            await store.put(makeFile("dele.md"));
            await store.runWrite({ deletes: [fileId] });
            expect(await store.get(fileId)).toBeNull();
        });
    });

    describe("lifecycle", () => {
        it("close is idempotent", async () => {
            await store.close();
            await store.close(); // no throw
        });

        it("destroy removes the database", async () => {
            await store.put(makeFile("a.md"));
            await store.destroy();
            // Create a new store with the same name — should be empty
            // (can't actually verify because name was unique, but destroy
            // should not throw)
        });
    });
});
