/**
 * ConfigPushPipeline integration tests.
 *
 * Drives the pipeline against a real ConfigLocalDB + FakeCouchClient and
 * asserts: push of fresh docs, no-op when nothing changed, divergence
 * detection (concurrent / dominated), all-or-nothing cursor semantics
 * on bulkDocs conflict, and forcePushAdvanceVclocks.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConfigLocalDB } from "../../src/db/config-local-db.ts";
import { ConfigCheckpoints } from "../../src/db/sync/config-checkpoints.ts";
import { ConfigPushPipeline } from "../../src/db/sync/config-push-pipeline.ts";
import { FakeCouchClient } from "../helpers/fake-couch-client.ts";
import { compareVC } from "../../src/sync/vector-clock.ts";
import { makeConfigFixture } from "../helpers/config-fixture.ts";
import type { ConfigDoc, CouchSyncDoc } from "../../src/types.ts";

let counter = 0;
function uniqueName(): string {
    return `cfg-push-${Date.now()}-${counter++}`;
}

/** Build a v3 ConfigDoc fixture and seed both the doc and its chunks
 *  into the local DB in one tx. Returns the doc so callers can refer
 *  back to ids / vclock. */
async function seedLocalConfig(
    db: ConfigLocalDB,
    path: string,
    body: string,
    vclock: Record<string, number>,
): Promise<ConfigDoc> {
    const { doc, chunks } = await makeConfigFixture(path, body, { vclock });
    await db.runWriteTx({
        docs: [{ doc: doc as unknown as CouchSyncDoc }],
        chunks: chunks as unknown as CouchSyncDoc[],
    });
    return doc;
}

/** Build a ConfigDoc fixture for direct seeding into the remote (no
 *  chunks needed on the remote-side because pull-side tests use the
 *  fixture's chunk shape and these push tests only care about the
 *  ConfigDoc's vclock on remote). */
async function makeRemoteConfigDoc(
    path: string,
    body: string,
    vclock: Record<string, number>,
): Promise<ConfigDoc> {
    return (await makeConfigFixture(path, body, { vclock })).doc;
}

function makePipeline(
    db: ConfigLocalDB,
    remote: FakeCouchClient,
    cps: ConfigCheckpoints,
    deviceId = "dev-A",
): ConfigPushPipeline {
    return new ConfigPushPipeline({
        db,
        client: remote as any,
        checkpoints: cps,
        getDeviceId: () => deviceId,
        signal: new AbortController().signal,
    });
}

describe("ConfigPushPipeline — incremental push", () => {
    let db: ConfigLocalDB;
    let remote: FakeCouchClient;
    let cps: ConfigCheckpoints;
    let pipeline: ConfigPushPipeline;

    beforeEach(async () => {
        db = new ConfigLocalDB(uniqueName());
        db.open();
        remote = new FakeCouchClient();
        cps = new ConfigCheckpoints(db);
        await cps.load();
        pipeline = makePipeline(db, remote, cps);
    });

    afterEach(async () => {
        await db.destroy();
    });

    it("pushes new docs to empty remote and advances cursor", async () => {
        const a = await seedLocalConfig(db, ".obsidian/a.json", "1", { "dev-A": 1 });

        const result = await pipeline.run();

        expect(result.stats.pushed).toBe(1);
        expect(result.stats.divergent).toBe(0);
        expect(result.cursorAdvanced).toBe(true);
        const stored = await remote.getDoc<ConfigDoc>(a._id);
        expect(stored).not.toBeNull();
        // Chunks rode along on the same push round-trip.
        expect(result.stats.chunksPushed).toBe(1);
    });

    it("no-op when local and remote are converged (vclock equal)", async () => {
        const a = await seedLocalConfig(db, ".obsidian/a.json", "1", { "dev-A": 1 });
        await remote.bulkDocs([a] as unknown as CouchSyncDoc[]);

        const result = await pipeline.run();

        expect(result.stats.pushed).toBe(0);
        expect(result.stats.skipped).toBe(1);
        expect(result.stats.divergent).toBe(0);
    });

    it("equal vclock but DIFFERENT content (Init stale-collision) → divergent, NOT silent skip", async () => {
        // Source-side half of the 2026-06-14 bug: local has new content at the
        // same {dev-A:1} as a stale remote. The old equal-skip trusted the
        // vclock proxy and silently dropped the local content. It must now
        // surface as divergent so nothing is lost.
        const local = await seedLocalConfig(db, ".obsidian/a.json", "new-build", { "dev-A": 1 });
        const remoteDoc = await makeRemoteConfigDoc(".obsidian/a.json", "stale-old", { "dev-A": 1 });
        await remote.bulkDocs([remoteDoc] as unknown as CouchSyncDoc[]);

        const result = await pipeline.run();

        expect(result.stats.skipped).toBe(0);
        expect(result.divergent).toHaveLength(1);
        expect(result.divergent[0].relation).toBe("concurrent");
        expect(result.cursorAdvanced).toBe(false);
        // Remote unchanged (push held for arbitration, not silently dropped).
        const stillRemote = await remote.getDoc<ConfigDoc>(local._id);
        expect(stillRemote!.vclock).toEqual({ "dev-A": 1 });
    });

    it("second run is empty when nothing changed since lastPushSeq", async () => {
        await seedLocalConfig(db, ".obsidian/a.json", "1", { "dev-A": 1 });
        await pipeline.run();
        const seq1 = cps.getPushSeq();

        const result2 = await pipeline.run();

        expect(result2.stats.pushed).toBe(0);
        expect(result2.cursorAdvanced).toBe(false);
        expect(cps.getPushSeq()).toBe(seq1);
    });

    it("divergence: concurrent vclocks are surfaced and push is held", async () => {
        // Local says {dev-A:1}, remote says {dev-B:1} → incomparable.
        const local = await seedLocalConfig(db, ".obsidian/h.json", "L", { "dev-A": 1 });
        const remoteDoc = await makeRemoteConfigDoc(".obsidian/h.json", "R", { "dev-B": 1 });
        await remote.bulkDocs([remoteDoc] as unknown as CouchSyncDoc[]);

        const result = await pipeline.run();

        expect(result.stats.pushed).toBe(0);
        expect(result.divergent).toHaveLength(1);
        expect(result.divergent[0].relation).toBe("concurrent");
        expect(result.cursorAdvanced).toBe(false);
        // Remote unchanged.
        const stillRemote = await remote.getDoc<ConfigDoc>(local._id);
        expect(stillRemote!.vclock).toEqual({ "dev-B": 1 });
    });

    it("divergence: remote dominates → push held (would clobber)", async () => {
        await seedLocalConfig(db, ".obsidian/d.json", "L", { "dev-A": 1 });
        const remoteDoc = await makeRemoteConfigDoc(".obsidian/d.json", "R", { "dev-A": 2 });
        await remote.bulkDocs([remoteDoc] as unknown as CouchSyncDoc[]);

        const result = await pipeline.run();

        expect(result.divergent).toHaveLength(1);
        expect(result.divergent[0].relation).toBe("dominated");
        expect(result.stats.pushed).toBe(0);
    });

    it("forcePushAdvanceVclocks bumps local vclock above remote so retry succeeds", async () => {
        const local = await seedLocalConfig(db, ".obsidian/h.json", "L", { "dev-A": 1 });
        const remoteDoc = await makeRemoteConfigDoc(".obsidian/h.json", "R", { "dev-B": 1 });
        await remote.bulkDocs([remoteDoc] as unknown as CouchSyncDoc[]);

        const first = await pipeline.run();
        expect(first.divergent).toHaveLength(1);

        await pipeline.forcePushAdvanceVclocks(first.divergent);

        const stored = (await db.get(local._id)) as ConfigDoc;
        // mergeVC({dev-A:1},{dev-B:1}) + bump(dev-A) → {dev-A:2, dev-B:1}
        expect(stored.vclock).toEqual({ "dev-A": 2, "dev-B": 1 });
        // dominates remote, so retry pushes cleanly.
        const cmp = compareVC(stored.vclock, { "dev-B": 1 });
        expect(cmp).toBe("dominates");

        const second = await pipeline.run();
        expect(second.stats.pushed).toBe(1);
        expect(second.divergent).toHaveLength(0);
        expect(second.cursorAdvanced).toBe(true);
    });

    it("all-or-nothing: bulkDocs conflict blocks cursor advance", async () => {
        await seedLocalConfig(db, ".obsidian/a.json", "1", { "dev-A": 1 });

        // Inject a conflict on the next bulkDocs call.
        const origBulk = remote.bulkDocs.bind(remote);
        remote.bulkDocs = async (docs: any[]) => {
            // First call: synthetic conflict on every row.
            return docs.map((d) => ({
                id: d._id,
                error: "conflict" as const,
                reason: "synthetic",
            }));
        };

        const result = await pipeline.run();

        expect(result.stats.conflicts).toBe(1);
        expect(result.stats.pushed).toBe(0);
        expect(result.cursorAdvanced).toBe(false);
        expect(cps.getPushSeq()).toBe(0); // unchanged

        // Restore real bulkDocs and retry — same delta should re-enumerate.
        remote.bulkDocs = origBulk;
        const retry = await pipeline.run();
        expect(retry.stats.pushed).toBe(1);
        expect(retry.cursorAdvanced).toBe(true);
    });
});
