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
    computeConfigDataHash,
} from "../../src/db/sync/config-last-synced.ts";
import { ConfigPullWriter } from "../../src/db/sync/config-pull-writer.ts";
import { ConflictResolver } from "../../src/conflict/conflict-resolver.ts";
import { FakeCouchClient } from "../helpers/fake-couch-client.ts";
import { arrayBufferToBase64 } from "../../src/db/chunker.ts";
import { makeConfigId, configPathFromId } from "../../src/types/doc-id.ts";
import type { ConfigDoc } from "../../src/types.ts";

let counter = 0;
function uniqueName(): string {
    return `cfg-pull-${Date.now()}-${counter++}`;
}

function makeConfigDoc(path: string, body: string, vclock: Record<string, number>): ConfigDoc {
    const data = arrayBufferToBase64(new TextEncoder().encode(body).buffer);
    return {
        _id: makeConfigId(path),
        type: "config",
        data,
        mtime: 1_000_000,
        size: body.length,
        vclock,
    };
}

async function seedRemote(remote: FakeCouchClient, docs: ConfigDoc[]): Promise<void> {
    if (docs.length === 0) return;
    await remote.bulkDocs(docs);
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
        const a = makeConfigDoc(".obsidian/app.json", `{"v":1}`, { "dev-A": 1 });
        const b = makeConfigDoc(".obsidian/hotkeys.json", `{"k":1}`, { "dev-A": 1 });
        await seedRemote(remote, [a, b]);

        const result = await writer.run();

        expect(result.stats.accepted).toBe(2);
        expect(result.stats.concurrent).toBe(0);
        expect(await db.get(a._id)).not.toBeNull();
        expect(await db.get(b._id)).not.toBeNull();
        // pullSeq has advanced past last_seq=2.
        expect(Number(cps.getPullSeq())).toBeGreaterThanOrEqual(2);
    });

    it("second run returns empty when remote is unchanged (cursor sticks)", async () => {
        await seedRemote(remote, [
            makeConfigDoc(".obsidian/a.json", "1", { "dev-A": 1 }),
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
        const doc = makeConfigDoc(".obsidian/a.json", "x", { "dev-A": 5 });
        await db.runWriteTx({ docs: [{ doc }] });
        await seedRemote(remote, [doc]);

        const result = await writer.run();

        expect(result.stats.convergedSkip).toBe(1);
        expect(result.stats.accepted).toBe(0);
    });

    it("concurrent (vclock-incomparable) classifies as concurrent and skips accept", async () => {
        // Local says {dev-A:1}, remote says {dev-B:1} → incomparable.
        const localDoc = makeConfigDoc(".obsidian/h.json", "L", { "dev-A": 1 });
        await db.runWriteTx({ docs: [{ doc: localDoc }] });
        const remoteDoc = makeConfigDoc(".obsidian/h.json", "R", { "dev-B": 1 });
        await seedRemote(remote, [remoteDoc]);

        const result = await writer.run();

        expect(result.stats.concurrent).toBe(1);
        expect(result.stats.accepted).toBe(0);
        // Local doc unchanged (the concurrent one was filtered out of accepted).
        const stillLocal = (await db.get(localDoc._id)) as ConfigDoc;
        expect(stillLocal.vclock).toEqual({ "dev-A": 1 });
        // Cursor still advanced — concurrent must not block subsequent batches.
        expect(Number(cps.getPullSeq())).toBeGreaterThanOrEqual(1);
    });

    it("PR-C: silent-merge when vclocks divergent but data identical (audit MEDIUM, Config side)", async () => {
        // Pre-PR-C this verdict fell through the if-chain into accepted.push
        // without merging vclocks → local-only causality info was lost.
        // Post-PR-C the writer mergeVCs and increments vclockOnlyDrift.
        const sharedBody = "shared content";
        const localDoc = makeConfigDoc(".obsidian/shared.json", sharedBody, { "dev-B": 1 });
        await db.runWriteTx({ docs: [{ doc: localDoc }] });
        const remoteDoc = makeConfigDoc(".obsidian/shared.json", sharedBody, { "dev-A": 5 });
        await seedRemote(remote, [remoteDoc]);

        const result = await writer.run();

        expect(result.stats.vclockOnlyDrift).toBe(1);
        expect(result.stats.concurrent).toBe(0);
        expect(result.stats.accepted).toBe(1); // mergedDoc landed in accepted

        // Committed doc must carry the merged vclock so future causality
        // checks see both sides as integrated.
        const committed = (await db.get(localDoc._id)) as ConfigDoc;
        expect(committed.vclock).toEqual({ "dev-A": 5, "dev-B": 1 });
    });

    it("keep-local: local dominates remote → skip without surfacing as concurrent", async () => {
        const localDoc = makeConfigDoc(".obsidian/k.json", "v2", { "dev-A": 2 });
        await db.runWriteTx({ docs: [{ doc: localDoc }] });
        const remoteDoc = makeConfigDoc(".obsidian/k.json", "v1", { "dev-A": 1 });
        await seedRemote(remote, [remoteDoc]);

        const result = await writer.run();

        expect(result.stats.keepLocal).toBe(1);
        expect(result.stats.concurrent).toBe(0);
        expect(result.stats.accepted).toBe(0);
    });

    it("deletion: remote tombstone removes local doc and clears lastSynced", async () => {
        const doc = makeConfigDoc(".obsidian/d.json", "1", { "dev-A": 1 });
        await seedRemote(remote, [doc]);
        await writer.run(); // initial accept
        expect(await db.get(doc._id)).not.toBeNull();
        const path = configPathFromId(doc._id);
        expect(last.get(path)).toBeDefined();

        await deleteRemote(remote, [doc._id]);
        const result = await writer.run();

        expect(result.stats.deleted).toBe(1);
        expect(await db.get(doc._id)).toBeNull();
        expect(last.get(path)).toBeUndefined();
        const metaRows = await db.getMetaByPrefix(configLastSyncedKey(""));
        expect(metaRows.find((r) => r.key.endsWith(`/${path}`))).toBeUndefined();
    });

    it("commit atomicity: pullSeq + lastSynced + docs land together", async () => {
        const doc = makeConfigDoc(".obsidian/atomic.json", "atomic", { "dev-A": 1 });
        await seedRemote(remote, [doc]);

        await writer.run();

        // All three side-effects observable post-commit:
        const stored = await db.get(doc._id);
        expect(stored).not.toBeNull();
        const persistedSeq = await db.getMeta<number | string>(META_CONFIG_PULL_SEQ);
        expect(persistedSeq).toBe(cps.getPullSeq());
        const path = configPathFromId(doc._id);
        const cached = last.get(path);
        expect(cached).toBeDefined();
        expect(cached!.size).toBe(doc.size);
        // dataHash should match what compute produces for the same payload.
        const expectedHash = await computeConfigDataHash(
            new TextEncoder().encode("atomic").buffer,
        );
        expect(cached!.dataHash).toBe(expectedHash);
    });
});
