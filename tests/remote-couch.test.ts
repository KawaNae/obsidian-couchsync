/**
 * Tests for the stateless remote-couch helpers (Phase 2).
 *
 * Phase 2 replaces PouchDB replication with ILocalStore + ICouchClient
 * abstractions. Tests use in-memory stubs for both sides.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
    pushDocs,
    pullByPrefix,
    listRemoteByPrefix,
    destroyRemote,
    pushAll,
    pullAll,
} from "../src/db/remote-couch.ts";
import type { CouchSyncDoc, FileDoc } from "../src/types.ts";
import type {
    ILocalStore,
    ICouchClient,
    PutResponse,
    AllDocsResult,
    AllDocsRow,
    BulkDocsResult,
} from "../src/db/interfaces.ts";
import { makeFileId, makeChunkId } from "../src/types/doc-id.ts";

// ── In-memory ILocalStore stub ──────────────────────────

function createLocalStub(): ILocalStore<CouchSyncDoc> & { _docs: Map<string, any> } {
    const _docs = new Map<string, any>();
    let _rev = 0;
    return {
        _docs,
        get: async (id: string) => _docs.get(id) ?? null,
        put: async (doc: any) => {
            const rev = `${++_rev}-stub`;
            _docs.set(doc._id, { ...doc, _rev: rev });
            return { ok: true, id: doc._id, rev };
        },
        bulkPut: async (docs: any[]) => {
            const results: PutResponse[] = [];
            for (const doc of docs) {
                const rev = `${++_rev}-stub`;
                _docs.set(doc._id, { ...doc, _rev: rev });
                results.push({ ok: true, id: doc._id, rev });
            }
            return results;
        },
        runWrite: (async (arg: any) => {
            const tx = typeof arg === "function" ? await arg({
                get: async (id: string) => _docs.get(id) ?? null,
                getMeta: async () => null,
                getMetaByPrefix: async () => [],
            }) : arg;
            if (!tx) return false;
            if (tx.docs) {
                for (const { doc } of tx.docs) {
                    _docs.set(doc._id, { ...doc, _rev: `${++_rev}-stub` });
                }
            }
            if (tx.chunks) {
                for (const c of tx.chunks) {
                    if (!_docs.has(c._id)) {
                        _docs.set(c._id, { ...c, _rev: `${++_rev}-stub` });
                    }
                }
            }
            if (tx.deletes) for (const id of tx.deletes) _docs.delete(id);
            if (tx.onCommit) await tx.onCommit();
            return typeof arg === "function" ? true : undefined;
        }) as any,
        update: async () => null,
        delete: async (id: string) => { _docs.delete(id); },
        allDocs: async (opts?: any) => {
            let entries = Array.from(_docs.entries());
            if (opts?.keys) {
                const keySet = new Set(opts.keys);
                entries = entries.filter(([k]) => keySet.has(k));
            } else {
                if (opts?.startkey) entries = entries.filter(([k]) => k >= opts.startkey);
                if (opts?.endkey) entries = entries.filter(([k]) => k <= opts.endkey);
            }
            const rows: AllDocsRow<CouchSyncDoc>[] = entries.map(([id, doc]) => ({
                id,
                key: id,
                value: { rev: doc._rev || "1-stub" },
                ...(opts?.include_docs ? { doc } : {}),
            }));
            return { rows } as AllDocsResult<CouchSyncDoc>;
        },
        info: async () => ({ updateSeq: 0 }),
        close: async () => {},
        destroy: async () => { _docs.clear(); },
    };
}

// ── In-memory ICouchClient stub ─────────────────────────

function createRemoteStub(): ICouchClient & { _docs: Map<string, any>, _destroyed: boolean } {
    const _docs = new Map<string, any>();
    let _rev = 0;
    return {
        _docs,
        _destroyed: false,
        info: async () => ({ db_name: "test", doc_count: _docs.size, update_seq: 0 }),
        getDoc: async (id: string) => _docs.get(id) ?? null,
        bulkGet: async (ids: string[]) => ids.map((id) => _docs.get(id)).filter(Boolean),
        bulkDocs: async (docs: any[]) => {
            const results: BulkDocsResult[] = [];
            for (const doc of docs) {
                const rev = `${++_rev}-remote`;
                _docs.set(doc._id, { ...doc, _rev: rev });
                results.push({ ok: true, id: doc._id, rev });
            }
            return results;
        },
        allDocs: async (opts?: any) => {
            let entries = Array.from(_docs.entries());
            if (opts?.keys) {
                const keySet = new Set(opts.keys);
                entries = entries.filter(([k]) => keySet.has(k));
            } else {
                if (opts?.startkey) entries = entries.filter(([k]) => k >= opts.startkey);
                if (opts?.endkey) entries = entries.filter(([k]) => k <= opts.endkey);
            }
            const rows: AllDocsRow<CouchSyncDoc>[] = entries.map(([id, doc]) => ({
                id,
                key: id,
                value: { rev: doc._rev || "1-remote" },
                ...(opts?.include_docs ? { doc } : {}),
            }));
            return { rows } as AllDocsResult<CouchSyncDoc>;
        },
        changes: async () => ({ results: [], last_seq: 0 }),
        changesLongpoll: async () => ({ results: [], last_seq: 0 }),
        destroy: async function (this: any) { this._destroyed = true; _docs.clear(); },
    };
}

function makeFileDoc(path: string, body: string): FileDoc {
    return {
        _id: makeFileId(path),
        type: "file",
        chunks: [makeChunkId(`hash-${body}`)],
        mtime: 1000,
        ctime: 1000,
        size: body.length,
        vclock: { test: 1 },
    };
}

describe("remote-couch (Phase 2 — ILocalStore + ICouchClient)", () => {
    let local: ReturnType<typeof createLocalStub>;
    let remote: ReturnType<typeof createRemoteStub>;

    beforeEach(() => {
        local = createLocalStub();
        remote = createRemoteStub();
    });

    describe("pushDocs", () => {
        it("pushes specified docs to remote and reports progress", async () => {
            await local.put(makeFileDoc("a.md", "alpha"));
            await local.put(makeFileDoc("b.md", "beta"));
            await local.put(makeFileDoc("c.md", "gamma"));

            const seen: string[] = [];
            const written = await pushDocs(
                local,
                remote,
                [makeFileId("a.md"), makeFileId("b.md")],
                (id) => seen.push(id),
            );
            expect(written).toBe(2);
            expect(new Set(seen)).toEqual(
                new Set([makeFileId("a.md"), makeFileId("b.md")]),
            );

            // c.md was NOT in the doc_ids list — should not appear on remote
            expect(remote._docs.has(makeFileId("a.md"))).toBe(true);
            expect(remote._docs.has(makeFileId("b.md"))).toBe(true);
            expect(remote._docs.has(makeFileId("c.md"))).toBe(false);
        });

        it("returns 0 immediately for an empty id list", async () => {
            const written = await pushDocs(local, remote, [], () => {});
            expect(written).toBe(0);
        });
    });

    describe("pullByPrefix", () => {
        it("pulls only docs matching the prefix", async () => {
            // Seed remote with file docs and a chunk doc.
            remote._docs.set(makeFileId("a.md"), { ...makeFileDoc("a.md", "x"), _rev: "1-r" });
            remote._docs.set(makeFileId("b.md"), { ...makeFileDoc("b.md", "y"), _rev: "1-r" });
            remote._docs.set(makeChunkId("orphan"), {
                _id: makeChunkId("orphan"), type: "chunk", data: "ZGF0YQ==", _rev: "1-r",
            });

            const written = await pullByPrefix(local, remote, "file:");
            expect(written).toBe(2);

            expect(local._docs.has(makeFileId("a.md"))).toBe(true);
            expect(local._docs.has(makeFileId("b.md"))).toBe(true);
            expect(local._docs.has(makeChunkId("orphan"))).toBe(false);
        });

        it("returns 0 when prefix matches nothing", async () => {
            const written = await pullByPrefix(local, remote, "config:");
            expect(written).toBe(0);
        });
    });

    describe("listRemoteByPrefix", () => {
        it("returns ids matching the prefix", async () => {
            remote._docs.set(makeFileId("notes/x.md"), { _id: makeFileId("notes/x.md"), _rev: "1-r" });
            remote._docs.set(makeFileId("notes/y.md"), { _id: makeFileId("notes/y.md"), _rev: "1-r" });
            remote._docs.set(makeChunkId("nope"), { _id: makeChunkId("nope"), _rev: "1-r" });

            const ids = await listRemoteByPrefix(remote, "file:");
            expect(ids).toContain(makeFileId("notes/x.md"));
            expect(ids).toContain(makeFileId("notes/y.md"));
            expect(ids).not.toContain(makeChunkId("nope"));
        });

        it("returns empty array for missing prefix", async () => {
            const ids = await listRemoteByPrefix(remote, "config:");
            expect(ids).toEqual([]);
        });
    });

    describe("destroyRemote", () => {
        it("destroys the remote", async () => {
            remote._docs.set(makeFileId("doomed.md"), { _id: makeFileId("doomed.md") });
            await destroyRemote(remote);
            expect(remote._destroyed).toBe(true);
            expect(remote._docs.size).toBe(0);
        });
    });

    describe("pushAll", () => {
        it("pushes every local doc to remote", async () => {
            await local.put(makeFileDoc("a.md", "1"));
            await local.put(makeFileDoc("b.md", "2"));

            const seen: string[] = [];
            const written = await pushAll(local, remote, (id) => seen.push(id));
            expect(written).toBe(2);
            expect(seen.length).toBe(2);
        });
    });

    describe("pullAll", () => {
        it("pulls every remote doc to local and returns the docs", async () => {
            const docA = { ...makeFileDoc("a.md", "1"), _rev: "1-r" };
            const docB = { ...makeFileDoc("b.md", "2"), _rev: "1-r" };
            remote._docs.set(docA._id, docA);
            remote._docs.set(docB._id, docB);

            const seen: string[] = [];
            const result = await pullAll(local, remote, (id) => seen.push(id));
            expect(result.written).toBe(2);
            expect(result.docs.length).toBe(2);
            expect(seen.length).toBe(2);
        });
    });
});
