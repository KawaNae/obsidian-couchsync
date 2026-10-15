/**
 * ConfigPullWriter integration tests.
 *
 * Drives the writer against a real ConfigLocalDB + FakeCouchClient and
 * asserts: cursor advancement, idempotent re-pulls, the remote doc always
 * replacing the local copy (no classification), chunk fetching, deletion
 * handling, and that lastSynced (the disk's base) is left to the merge.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConfigLocalDB } from "../../src/db/config-local-db.ts";
import {
    ConfigCheckpoints,
    META_CONFIG_PULL_SEQ,
} from "../../src/db/sync/config-checkpoints.ts";
import {
    ConfigLastSynced,
    configLastSyncedKey,
} from "../../src/db/sync/config-last-synced.ts";
import { ConfigPullWriter } from "../../src/db/sync/config-pull-writer.ts";
import { FakeCouchClient } from "../helpers/fake-couch-client.ts";
import { configPathFromId } from "../../src/types/doc-id.ts";
import { makeConfigFixture, type ConfigFixture } from "../helpers/config-fixture.ts";
import type { ConfigDoc, CouchSyncDoc } from "../../src/types.ts";
import { encodeEnvelope, plainEnvelope } from "../../src/db/envelope.ts";

let counter = 0;
function uniqueName(): string {
    return `cfg-pull-${Date.now()}-${counter++}`;
}

/** Build a fully-formed v3 ConfigDoc fixture (with its referenced
 *  chunks) and return both pieces. Tests reach for `.doc` when they
 *  only need a ConfigDoc and the helper handles the chunks separately. */
async function makeConfigDoc(
    path: string,
    body: string,
    vclock: Record<string, number>,
): Promise<ConfigFixture> {
    return makeConfigFixture(path, body, { vclock });
}

/** Seed remote with the ConfigDocs + their referenced chunks. Chunks
 *  ride as attachment "c" so the pull-side ensureChunks fetch sees the
 *  same envelope shape production code produces. */
async function seedRemote(
    remote: FakeCouchClient,
    fixtures: ConfigFixture[],
): Promise<void> {
    if (fixtures.length === 0) return;
    const docs = fixtures.map((f) => f.doc);
    await remote.bulkDocs(docs as unknown as CouchSyncDoc[]);
    const chunkItems = [];
    const seen = new Set<string>();
    for (const f of fixtures) {
        for (const c of f.chunks) {
            if (seen.has(c._id)) continue;
            seen.add(c._id);
            const { content: _c, ...body } = c;
            void _c;
            chunkItems.push({
                doc: body as unknown as Record<string, unknown>,
                attachments: {
                    c: {
                        contentType: "application/octet-stream",
                        data: encodeEnvelope(plainEnvelope(c.content)),
                    },
                },
            });
        }
    }
    if (chunkItems.length > 0) {
        await remote.bulkDocsWithAttachments(chunkItems);
    }
}

async function deleteRemote(remote: FakeCouchClient, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    // FakeCouchClient bulkDocs treats `_deleted: true` as a tombstone.
    await remote.bulkDocs(ids.map((id) => ({ _id: id, _deleted: true })));
}

function makeWriter(
    db: ConfigLocalDB,
    remote: FakeCouchClient,
    cps: ConfigCheckpoints,
    last: ConfigLastSynced,
): ConfigPullWriter {
    return new ConfigPullWriter({
        db,
        client: remote as any,
        checkpoints: cps,
        lastSynced: last,
        signal: new AbortController().signal,
    });
}

async function putLocal(db: ConfigLocalDB, f: ConfigFixture): Promise<void> {
    await db.runWriteTx({
        docs: [{ doc: f.doc as unknown as CouchSyncDoc }],
        chunks: f.chunks as unknown as CouchSyncDoc[],
    });
}

describe("ConfigPullWriter — copy the server's docs", () => {
    let db: ConfigLocalDB;
    let remote: FakeCouchClient;
    let cps: ConfigCheckpoints;
    let last: ConfigLastSynced;
    let writer: ConfigPullWriter;

    beforeEach(async () => {
        db = new ConfigLocalDB(uniqueName());
        db.open();
        remote = new FakeCouchClient();
        cps = new ConfigCheckpoints(db);
        last = new ConfigLastSynced(db);
        await cps.load();
        writer = makeWriter(db, remote, cps, last);
    });

    afterEach(async () => {
        await db.destroy();
    });

    it("from since=0, takes all remote docs with their chunks and advances cursor", async () => {
        const a = await makeConfigDoc(".obsidian/app.json", `{"v":1}`, { "dev-A": 1 });
        const b = await makeConfigDoc(".obsidian/hotkeys.json", `{"k":1}`, { "dev-A": 1 });
        await seedRemote(remote, [a, b]);

        const stats = await writer.run();

        expect(stats).toEqual({ received: 2, deleted: 0 });
        expect(await db.get(a.doc._id)).not.toBeNull();
        expect(await db.get(b.doc._id)).not.toBeNull();
        expect((await db.getChunks(a.doc.chunks)).length).toBe(a.doc.chunks.length);
        expect(Number(cps.getPullSeq())).toBeGreaterThanOrEqual(2);
    });

    it("self-heals on seq regression: remote recreated below cursor", async () => {
        // A Config Create on another device destroys + recreates the remote
        // DB, resetting its update-seq below our cursor. Without regression
        // detection the pull fetches nothing forever; the writer must reset
        // its cursor to 0 and re-pull the whole DB.
        const a = await makeConfigDoc(".obsidian/app.json", `{"v":1}`, { "dev-A": 1 });
        await seedRemote(remote, [a]);
        cps.setPullSeq(99999);

        const stats = await writer.run();

        expect(stats.received).toBe(1);
        expect(await db.get(a.doc._id)).not.toBeNull();
        expect(Number(cps.getPullSeq())).toBeLessThan(99999);
    });

    it("second run returns empty when remote is unchanged (cursor sticks)", async () => {
        await seedRemote(remote, [
            await makeConfigDoc(".obsidian/a.json", "1", { "dev-A": 1 }),
        ]);
        await writer.run();
        const seq1 = cps.getPullSeq();

        const stats = await writer.run();
        expect(stats).toEqual({ received: 0, deleted: 0 });
        expect(cps.getPullSeq()).toBe(seq1);
    });

    it.each([
        ["remote newer", { "dev-A": 1 }, { "dev-A": 2 }],
        ["local newer", { "dev-A": 2 }, { "dev-A": 1 }],
        ["concurrent", { "dev-A": 1 }, { "dev-B": 1 }],
        ["same vclock, other content", { "dev-A": 1 }, { "dev-A": 1 }],
    ] as const)("the remote doc replaces the local copy (%s)", async (_label, localVc, remoteVc) => {
        const localF = await makeConfigDoc(".obsidian/h.json", "L", { ...localVc });
        await putLocal(db, localF);
        const remoteF = await makeConfigDoc(".obsidian/h.json", "R", { ...remoteVc });
        await seedRemote(remote, [remoteF]);

        await writer.run();

        const stored = (await db.get(localF.doc._id)) as ConfigDoc;
        expect(stored.vclock).toEqual(remoteVc);
        expect(stored.chunks).toEqual(remoteF.doc.chunks);
    });

    it("leaves lastSynced alone: the disk has not taken the doc in yet", async () => {
        const f = await makeConfigDoc(".obsidian/atomic.json", "atomic", { "dev-A": 1 });
        await seedRemote(remote, [f]);

        await writer.run();

        expect(await db.get(f.doc._id)).not.toBeNull();
        const persistedSeq = await db.getMeta<number | string>(META_CONFIG_PULL_SEQ);
        expect(persistedSeq).toBe(cps.getPullSeq());
        expect(last.get(configPathFromId(f.doc._id))).toBeUndefined();
        expect(await db.getMetaByPrefix(configLastSyncedKey(""))).toEqual([]);
    });

    it("deletion: remote tombstone removes local doc and its lastSynced", async () => {
        const f = await makeConfigDoc(".obsidian/d.json", "1", { "dev-A": 1 });
        await seedRemote(remote, [f]);
        await writer.run();
        const path = configPathFromId(f.doc._id);
        const base = { vclock: f.doc.vclock, size: f.doc.size, chunks: f.doc.chunks };
        await db.runWriteTx({ meta: [{ op: "put", key: configLastSyncedKey(path), value: base }] });
        last.set(path, base);

        await deleteRemote(remote, [f.doc._id]);
        const stats = await writer.run();

        expect(stats.deleted).toBe(1);
        expect(await db.get(f.doc._id)).toBeNull();
        expect(last.get(path)).toBeUndefined();
        const metaRows = await db.getMetaByPrefix(configLastSyncedKey(""));
        expect(metaRows.find((r) => r.key.endsWith(`/${path}`))).toBeUndefined();
    });

    it("ensureChunks fetches the chunks a stored doc still lacks", async () => {
        const f = await makeConfigDoc(".obsidian/late.json", "late", { "dev-A": 1 });
        await seedRemote(remote, [f]);
        await db.runWriteTx({ docs: [{ doc: f.doc as unknown as CouchSyncDoc }] });
        expect(await db.getChunks(f.doc.chunks)).toEqual([]);

        await writer.ensureChunks(f.doc);

        expect((await db.getChunks(f.doc.chunks)).length).toBe(f.doc.chunks.length);
    });
});
