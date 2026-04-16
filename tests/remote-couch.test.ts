/**
 * Tests for the stateless remote-couch helpers.
 *
 * Replaces PouchDB replication with IDocStore + ICouchClient abstractions.
 * Tests use in-memory stubs for both sides.
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
    IDocStore,
    ICouchClient,
    AllDocsResult,
    AllDocsRow,
    BulkDocsResult,
} from "../src/db/interfaces.ts";
import { makeFileId, makeChunkId } from "../src/types/doc-id.ts";

// ── In-memory IDocStore stub ────────────────────────────

function createLocalStub(): IDocStore<CouchSyncDoc> & { _docs: Map<string, any> } {
    const _docs = new Map<string, any>();
    let _rev = 0;
    const stub: any = {
        _docs,
        get: async (id: string) => _docs.get(id) ?? null,
        runWriteTx: async (tx: any) => {
            if (!tx) return;
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
        },
        runWriteBuilder: async (builder: any, opts?: any) => {
            const tx = await builder({
                get: async (id: string) => _docs.get(id) ?? null,
                getMeta: async () => null,
                getMetaByPrefix: async () => [],
            });
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
            return true;
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
                value: { rev: doc._rev || "1-stub" },
                ...(opts?.include_docs ? { doc } : {}),
            }));
            return { rows } as AllDocsResult<CouchSyncDoc>;
        },
        changes: async () => ({ results: [], last_seq: 0 }),
        info: async () => ({ updateSeq: 0 }),
        close: async () => {},
        destroy: async () => { _docs.clear(); },
    };
    return stub;
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

/** Shorthand: seed a doc into a local stub. */
async function seed(local: IDocStore<CouchSyncDoc>, doc: CouchSyncDoc): Promise<void> {
    await local.runWriteTx({ docs: [{ doc }] });
}

describe("remote-couch (IDocStore + ICouchClient)", () => {
    let local: ReturnType<typeof createLocalStub>;
    let remote: ReturnType<typeof createRemoteStub>;

    beforeEach(() => {
        local = createLocalStub();
        remote = createRemoteStub();
    });

    describe("pushDocs", () => {
        it("pushes specified docs to remote and reports progress", async () => {
            await seed(local, makeFileDoc("a.md", "alpha"));
            await seed(local, makeFileDoc("b.md", "beta"));
            await seed(local, makeFileDoc("c.md", "gamma"));

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
            await seed(local, makeFileDoc("a.md", "1"));
            await seed(local, makeFileDoc("b.md", "2"));

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
