/**
 * PushPipeline.warmup — session-open one-pass sweep of the unpushed-set.
 *
 * Drops ids whose vclock has converged with remote since the last
 * session (peer pushed our rev, pull integrated remote → equal). Keeps
 * concurrent / dominated entries for the live loop to surface.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { createSyncHarness, type SyncHarness } from "../harness/sync-harness.ts";
import { PushPipeline } from "../../src/db/sync/push-pipeline.ts";
import { EchoTracker } from "../../src/db/sync/echo-tracker.ts";
import { SyncEvents } from "../../src/db/sync/sync-events.ts";
import { Checkpoints } from "../../src/db/sync/checkpoints.ts";
import { ALWAYS_VISIBLE } from "../../src/db/visibility-gate.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import { UNPUSHED_KEY_PREFIX, loadAllUnpushed } from "../../src/db/sync/unpushed-ids.ts";
import type { CouchSyncDoc, FileDoc } from "../../src/types.ts";

function makePipeline(device: ReturnType<SyncHarness["addDevice"]>, couch: SyncHarness["couch"]) {
    const events = new SyncEvents();
    const echoes = new EchoTracker();
    const checkpoints = new Checkpoints(device.db);
    const controller = new AbortController();
    const pipeline = new PushPipeline({
        localDb: device.db,
        client: couch,
        echoes,
        events,
        checkpoints,
        sessionEpoch: 1,
        visibility: ALWAYS_VISIBLE,
        isCancelled: () => false,
        signal: controller.signal,
        handleLocalDbError: () => {},
        delay: async () => {},
    });
    return { pipeline, checkpoints, controller };
}

async function seedUnpushed(db: any, id: string, attempts = 1, reason = "race-stale" as const) {
    await db.runWriteTx({
        meta: [{
            op: "put",
            key: UNPUSHED_KEY_PREFIX + id,
            value: { addedAt: 1, reason, attempts },
        }],
    });
}

describe("PushPipeline.warmup", () => {
    let h: SyncHarness;

    afterEach(async () => {
        if (h) await h.destroyAll();
    });

    it("no-op when set is empty", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        const { pipeline } = makePipeline(a, h.couch);

        const allDocsSpy = vi.spyOn(h.couch, "allDocs");
        await pipeline.warmup();

        // No remote round-trip when nothing to classify.
        expect(allDocsSpy).not.toHaveBeenCalled();
        allDocsSpy.mockRestore();
    });

    it("drops zombies (id in set but no local doc)", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        const { pipeline } = makePipeline(a, h.couch);
        const ghost = makeFileId("ghost.md");
        await seedUnpushed(a.db, ghost);

        await pipeline.warmup();

        const rows = await loadAllUnpushed(a.db);
        expect(rows.find((r) => r.id === ghost)).toBeUndefined();
    });

    it("drops entries whose vclock matches remote (converged)", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        const { pipeline } = makePipeline(a, h.couch);
        const id = makeFileId("converged.md");

        // Both local and remote have vclock {dev-A: 1} → equal.
        a.vault.addFile("converged.md", "v1");
        await a.vs.fileToDb("converged.md");
        const localDoc = await a.db.get<FileDoc>(id);
        const remoteDoc = { ...localDoc, _id: id, vclock: localDoc!.vclock } as FileDoc;
        await h.couch.bulkDocs([remoteDoc as unknown as CouchSyncDoc]);

        await seedUnpushed(a.db, id);

        await pipeline.warmup();

        const rows = await loadAllUnpushed(a.db);
        expect(rows.find((r) => r.id === id)).toBeUndefined();
    });

    it("keeps entries that are still divergent (vclock concurrent)", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        const { pipeline } = makePipeline(a, h.couch);
        const id = makeFileId("still-conc.md");

        // Local vclock {dev-A:1}, remote vclock {dev-X:1} → concurrent.
        a.vault.addFile("still-conc.md", "v1");
        await a.vs.fileToDb("still-conc.md");
        const remoteDoc: FileDoc = {
            _id: id, type: "file", chunks: [], vclock: { "dev-X": 1 },
            mtime: 0, ctime: 0, size: 0,
        };
        await h.couch.bulkDocs([remoteDoc as unknown as CouchSyncDoc]);

        await seedUnpushed(a.db, id, 2, "race-stale");

        await pipeline.warmup();

        const rows = await loadAllUnpushed(a.db);
        const entry = rows.find((r) => r.id === id);
        expect(entry).toBeDefined();
        // Warmup didn't tear down or rewrite the entry.
        expect(entry!.entry.attempts).toBe(2);
        expect(entry!.entry.reason).toBe("race-stale");
    });

    it("leaves set untouched when classify (allDocs) fails — but still drops zombies", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        const { pipeline } = makePipeline(a, h.couch);

        // One real id and one zombie.
        const realId = makeFileId("real.md");
        a.vault.addFile("real.md", "v1");
        await a.vs.fileToDb("real.md");
        await seedUnpushed(a.db, realId);

        const ghost = makeFileId("ghost.md");
        await seedUnpushed(a.db, ghost);

        const allDocsSpy = vi.spyOn(h.couch, "allDocs").mockRejectedValue(new Error("network down"));

        await pipeline.warmup();

        const rows = await loadAllUnpushed(a.db);
        // Zombie dropped (local-only judgment).
        expect(rows.find((r) => r.id === ghost)).toBeUndefined();
        // Real entry untouched (remote unknown).
        expect(rows.find((r) => r.id === realId)).toBeDefined();

        allDocsSpy.mockRestore();
    });

    it("AbortError → silent return, no commit", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        const { pipeline } = makePipeline(a, h.couch);

        const id = makeFileId("aborted.md");
        a.vault.addFile("aborted.md", "v1");
        await a.vs.fileToDb("aborted.md");
        await seedUnpushed(a.db, id);

        const allDocsSpy = vi.spyOn(h.couch, "allDocs").mockImplementation(async () => {
            const e: any = new Error("aborted");
            e.name = "AbortError";
            throw e;
        });

        await pipeline.warmup();

        const rows = await loadAllUnpushed(a.db);
        // Entry preserved — abort = "we don't know", not "we converged".
        expect(rows.find((r) => r.id === id)).toBeDefined();
        allDocsSpy.mockRestore();
    });
});
