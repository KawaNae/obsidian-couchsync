/**
 * Tests for the stateless remote-couch helpers.
 *
 * These functions used to live as methods on Replicator. They were extracted
 * so ConfigSync can talk to a different remote DB than the vault Replicator
 * (config DB separation in v0.11.0). The tests use PouchDB memory adapters
 * for both "local" and "remote" so we can exercise the full replicate code
 * path without a real network.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import PouchDB from "pouchdb";
import memoryAdapter from "pouchdb-adapter-memory";
import {
    pushDocs,
    pullByPrefix,
    listRemoteByPrefix,
    destroyRemote,
    pushAll,
    pullAll,
} from "../src/db/remote-couch.ts";
import type { CouchSyncDoc, FileDoc } from "../src/types.ts";
import { makeFileId, makeChunkId } from "../src/types/doc-id.ts";

PouchDB.plugin(memoryAdapter);

function uniqueName(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function mkLocal() {
    return new PouchDB<CouchSyncDoc>(uniqueName("rc-local"), { adapter: "memory" });
}

function mkRemote() {
    // remote-couch operates on PouchDB instances directly via a "remote URL".
    // Inside tests we substitute a memory-adapter PouchDB for the URL by
    // passing the instance reference. The helper accepts either string or
    // an existing PouchDB instance to make this easy to test.
    return new PouchDB<CouchSyncDoc>(uniqueName("rc-remote"), { adapter: "memory" });
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

describe("remote-couch", () => {
    let local: PouchDB.Database<CouchSyncDoc>;
    let remote: PouchDB.Database<CouchSyncDoc>;

    beforeEach(() => {
        local = mkLocal();
        remote = mkRemote();
    });

    afterEach(async () => {
        await local.destroy().catch(() => {});
        await remote.destroy().catch(() => {});
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

            // c.md was NOT in the doc_ids list — should not appear
            const remoteAll = await remote.allDocs();
            const ids = remoteAll.rows.map((r) => r.id);
            expect(ids).toContain(makeFileId("a.md"));
            expect(ids).toContain(makeFileId("b.md"));
            expect(ids).not.toContain(makeFileId("c.md"));
        });

        it("returns 0 immediately for an empty id list", async () => {
            const written = await pushDocs(local, remote, [], () => {});
            expect(written).toBe(0);
        });
    });

    describe("pullByPrefix", () => {
        it("pulls only docs matching the prefix", async () => {
            await remote.put(makeFileDoc("a.md", "x"));
            await remote.put(makeFileDoc("b.md", "y"));
            // Add a non-matching doc to ensure it's filtered out
            await remote.put({
                _id: makeChunkId("orphan"),
                type: "chunk",
                data: "ZGF0YQ==",
            } as CouchSyncDoc);

            const written = await pullByPrefix(local, remote, "file:");
            expect(written).toBe(2);

            const localAll = await local.allDocs();
            const ids = localAll.rows.map((r) => r.id);
            expect(ids).toContain(makeFileId("a.md"));
            expect(ids).toContain(makeFileId("b.md"));
            expect(ids).not.toContain(makeChunkId("orphan"));
        });

        it("returns 0 when prefix matches nothing", async () => {
            const written = await pullByPrefix(local, remote, "config:");
            expect(written).toBe(0);
        });
    });

    describe("listRemoteByPrefix", () => {
        it("returns ids matching the prefix", async () => {
            await remote.put(makeFileDoc("notes/x.md", "1"));
            await remote.put(makeFileDoc("notes/y.md", "2"));
            await remote.put({
                _id: makeChunkId("nope"),
                type: "chunk",
                data: "",
            } as CouchSyncDoc);

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
        it("destroys the given remote db", async () => {
            await remote.put(makeFileDoc("doomed.md", "x"));
            await destroyRemote(remote);
            // After destroy, the original PouchDB instance should reject
            // operations or auto-recreate as empty.
            const fresh = new PouchDB<CouchSyncDoc>(remote.name, { adapter: "memory" });
            const info = await fresh.info();
            expect(info.doc_count).toBe(0);
            await fresh.destroy();
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
            await remote.put(makeFileDoc("a.md", "1"));
            await remote.put(makeFileDoc("b.md", "2"));

            const seen: string[] = [];
            const result = await pullAll(local, remote, (id) => seen.push(id));
            expect(result.written).toBe(2);
            expect(result.docs.length).toBe(2);
            expect(seen.length).toBe(2);
        });
    });
});
