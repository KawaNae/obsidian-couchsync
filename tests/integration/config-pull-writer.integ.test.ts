/**
 * ConfigPullWriter integration tests.
 *
 * Drives the writer against a real ConfigLocalDB + FakeCouchClient and
 * asserts: cursor advancement, idempotent re-pulls, deletion handling,
 * concurrent (vclock-incomparable) classification, and lastSynced
 * meta atomicity.
 *
 * Replaces the snapshot-style pullByPrefix path in the diff-sync plan.
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
import { ConflictResolver } from "../../src/conflict/conflict-resolver.ts";
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
    resolver: ConflictResolver,
): ConfigPullWriter {
    return new ConfigPullWriter({
        db,
        client: remote as any,
        checkpoints: cps,
        lastSynced: last,
        getConflictResolver: () => resolver,
        signal: new AbortController().signal,
    });
}

describe("ConfigPullWriter — incremental pull", () => {
    let db: ConfigLocalDB;
    let remote: FakeCouchClient;
    let cps: ConfigCheckpoints;
    let last: ConfigLastSynced;
    let resolver: ConflictResolver;
    let writer: ConfigPullWriter;

    beforeEach(async () => {
        db = new ConfigLocalDB(uniqueName());
        db.open();
        remote = new FakeCouchClient();
        cps = new ConfigCheckpoints(db);
        last = new ConfigLastSynced(db);
        resolver = new ConflictResolver();
        await cps.load();
        writer = makeWriter(db, remote, cps, last, resolver);
    });

    afterEach(async () => {
        await db.destroy();
    });

    it("from since=0, takes all remote docs and advances cursor", async () => {
        const a = await makeConfigDoc(".obsidian/app.json", `{"v":1}`, { "dev-A": 1 });
        const b = await makeConfigDoc(".obsidian/hotkeys.json", `{"k":1}`, { "dev-A": 1 });
        await seedRemote(remote, [a, b]);

        const result = await writer.run();

        expect(result.stats.accepted).toBe(2);
        expect(result.stats.concurrent).toBe(0);
        expect(await db.get(a.doc._id)).not.toBeNull();
        expect(await db.get(b.doc._id)).not.toBeNull();
        // pullSeq has advanced past last_seq=2.
        expect(Number(cps.getPullSeq())).toBeGreaterThanOrEqual(2);
    });

    it("second run returns empty when remote is unchanged (cursor sticks)", async () => {
        await seedRemote(remote, [
            await makeConfigDoc(".obsidian/a.json", "1", { "dev-A": 1 }),
        ]);
        await writer.run();
        const seq1 = cps.getPullSeq();

        const result2 = await writer.run();
        expect(result2.stats.accepted).toBe(0);
        expect(result2.stats.deleted).toBe(0);
        expect(cps.getPullSeq()).toBe(seq1);
    });

    it("converged-skip: identical local doc is detected via vclock equality", async () => {
        // Pre-seed local DB with exact same doc as remote.
        const f = await makeConfigDoc(".obsidian/a.json", "x", { "dev-A": 5 });
        await db.runWriteTx({
            docs: [{ doc: f.doc as unknown as CouchSyncDoc }],
            chunks: f.chunks as unknown as CouchSyncDoc[],
        });
        await seedRemote(remote, [f]);

        const result = await writer.run();

        expect(result.stats.convergedSkip).toBe(1);
        expect(result.stats.accepted).toBe(0);
    });

    it("concurrent (vclock-incomparable) classifies as concurrent and skips accept", async () => {
        // Local says {dev-A:1}, remote says {dev-B:1} → incomparable.
        const localF = await makeConfigDoc(".obsidian/h.json", "L", { "dev-A": 1 });
        await db.runWriteTx({
            docs: [{ doc: localF.doc as unknown as CouchSyncDoc }],
            chunks: localF.chunks as unknown as CouchSyncDoc[],
        });
        const remoteF = await makeConfigDoc(".obsidian/h.json", "R", { "dev-B": 1 });
        await seedRemote(remote, [remoteF]);

        const result = await writer.run();

        expect(result.stats.concurrent).toBe(1);
        expect(result.stats.accepted).toBe(0);
        // Local doc unchanged (the concurrent one was filtered out of accepted).
        const stillLocal = (await db.get(localF.doc._id)) as ConfigDoc;
        expect(stillLocal.vclock).toEqual({ "dev-A": 1 });
        // Cursor still advanced — concurrent must not block subsequent batches.
        expect(Number(cps.getPullSeq())).toBeGreaterThanOrEqual(1);
    });

    it("PR-C: silent-merge when vclocks divergent but data identical (audit MEDIUM, Config side)", async () => {
        // Pre-PR-C this verdict fell through the if-chain into accepted.push
        // without merging vclocks → local-only causality info was lost.
        // Post-PR-C the writer mergeVCs and increments vclockOnlyDrift.
        const sharedBody = "shared content";
        const localF = await makeConfigDoc(".obsidian/shared.json", sharedBody, { "dev-B": 1 });
        await db.runWriteTx({
            docs: [{ doc: localF.doc as unknown as CouchSyncDoc }],
            chunks: localF.chunks as unknown as CouchSyncDoc[],
        });
        const remoteF = await makeConfigDoc(".obsidian/shared.json", sharedBody, { "dev-A": 5 });
        await seedRemote(remote, [remoteF]);

        const result = await writer.run();

        expect(result.stats.vclockOnlyDrift).toBe(1);
        expect(result.stats.concurrent).toBe(0);
        expect(result.stats.accepted).toBe(1); // mergedDoc landed in accepted

        // Committed doc must carry the merged vclock so future causality
        // checks see both sides as integrated.
        const committed = (await db.get(localF.doc._id)) as ConfigDoc;
        expect(committed.vclock).toEqual({ "dev-A": 5, "dev-B": 1 });
    });

    it("keep-local: local dominates remote → skip without surfacing as concurrent", async () => {
        const localF = await makeConfigDoc(".obsidian/k.json", "v2", { "dev-A": 2 });
        await db.runWriteTx({
            docs: [{ doc: localF.doc as unknown as CouchSyncDoc }],
            chunks: localF.chunks as unknown as CouchSyncDoc[],
        });
        const remoteF = await makeConfigDoc(".obsidian/k.json", "v1", { "dev-A": 1 });
        await seedRemote(remote, [remoteF]);

        const result = await writer.run();

        expect(result.stats.keepLocal).toBe(1);
        expect(result.stats.concurrent).toBe(0);
        expect(result.stats.accepted).toBe(0);
    });

    it("deletion: remote tombstone removes local doc and clears lastSynced", async () => {
        const f = await makeConfigDoc(".obsidian/d.json", "1", { "dev-A": 1 });
        await seedRemote(remote, [f]);
        await writer.run(); // initial accept
        expect(await db.get(f.doc._id)).not.toBeNull();
        const path = configPathFromId(f.doc._id);
        expect(last.get(path)).toBeDefined();

        await deleteRemote(remote, [f.doc._id]);
        const result = await writer.run();

        expect(result.stats.deleted).toBe(1);
        expect(await db.get(f.doc._id)).toBeNull();
        expect(last.get(path)).toBeUndefined();
        const metaRows = await db.getMetaByPrefix(configLastSyncedKey(""));
        expect(metaRows.find((r) => r.key.endsWith(`/${path}`))).toBeUndefined();
    });

    it("commit atomicity: pullSeq + lastSynced + docs land together", async () => {
        const f = await makeConfigDoc(".obsidian/atomic.json", "atomic", { "dev-A": 1 });
        await seedRemote(remote, [f]);

        await writer.run();

        // All three side-effects observable post-commit:
        const stored = await db.get(f.doc._id);
        expect(stored).not.toBeNull();
        const persistedSeq = await db.getMeta<number | string>(META_CONFIG_PULL_SEQ);
        expect(persistedSeq).toBe(cps.getPullSeq());
        const path = configPathFromId(f.doc._id);
        const cached = last.get(path);
        expect(cached).toBeDefined();
        expect(cached!.size).toBe(f.doc.size);
        // chunks fingerprint must equal the fixture's chunk-id list.
        expect(cached!.chunks).toEqual(f.doc.chunks);
    });
});
