/**
 * PushPipeline conflict-aware tests — exercises the redesigned cycle
 * that introduces:
 *   - vclock pre-classify (concurrent / dominated → divergent + emit)
 *   - cursor monotonic advance via `commitPushCycle`
 *   - persistent unpushed-set for retry across cycles
 *   - race-stale → divergent escalation after 3 attempts
 *   - silent benign chunk conflicts
 *
 * The conflict path is induced by spying on `couch.bulkDocs` and replacing
 * a single result row with `error: "conflict"`. The doc is still mutated
 * in the fake's store (the spy fires after the underlying write returns),
 * so the rev mismatch logic is what we're modelling: "remote moved, our
 * view is stale".
 */
import "fake-indexeddb/auto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { createSyncHarness, type SyncHarness, type DeviceHarness } from "../harness/sync-harness.ts";
import { PushPipeline } from "../../src/db/sync/push-pipeline.ts";
import { EchoTracker } from "../../src/db/sync/echo-tracker.ts";
import { SyncEvents } from "../../src/db/sync/sync-events.ts";
import { Checkpoints } from "../../src/db/sync/checkpoints.ts";
import { ALWAYS_VISIBLE } from "../../src/db/visibility-gate.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import { UNPUSHED_KEY_PREFIX, loadAllUnpushed } from "../../src/db/sync/unpushed-ids.ts";
import type { CouchSyncDoc, FileDoc } from "../../src/types.ts";

interface Rig {
    pipeline: PushPipeline;
    events: SyncEvents;
    checkpoints: Checkpoints;
    cancel: () => void;
    cyclesRun: { value: number };
}

function attach(opts: {
    device: DeviceHarness;
    couch: SyncHarness["couch"];
    /** If set, exit the loop once this many delay()s have fired. */
    maxCycles?: number;
}): Rig {
    const events = new SyncEvents();
    const echoes = new EchoTracker();
    const checkpoints = new Checkpoints(opts.device.db);
    const cyclesRun = { value: 0 };
    let cancelled = false;
    const controller = new AbortController();

    const pipeline = new PushPipeline({
        localDb: opts.device.db,
        client: opts.couch,
        echoes,
        events,
        checkpoints,
        sessionEpoch: 1,
        visibility: ALWAYS_VISIBLE,
        isCancelled: () => cancelled,
        signal: controller.signal,
        handleLocalDbError: () => {},
        delay: async () => {
            cyclesRun.value++;
            if (opts.maxCycles && cyclesRun.value >= opts.maxCycles) cancelled = true;
        },
    });

    return { pipeline, events, checkpoints, cancel: () => { cancelled = true; }, cyclesRun };
}

describe("PushPipeline conflict handling", () => {
    let h: SyncHarness;

    afterEach(async () => {
        if (h) await h.destroyAll();
    });

    it("conflict on file → cursor advances, id persisted to unpushed-set", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        const rig = attach({ device: a, couch: h.couch, maxCycles: 1 });

        a.vault.addFile("conflict.md", "v1");
        await a.vs.fileToDb("conflict.md");
        const id = makeFileId("conflict.md");

        const seqBefore = rig.checkpoints.getLastPushedSeq();

        // Force conflict on the file: row.
        const bulkSpy = vi.spyOn(h.couch, "bulkDocs").mockImplementation(
            async (docs: any[]) => {
                return docs.map((d: any) => {
                    if (d._id === id) {
                        return { id: d._id, error: "conflict", reason: "Document update conflict." };
                    }
                    return { ok: true, id: d._id, rev: "1-fake" };
                });
            },
        );

        await rig.pipeline.run();

        // Cursor advanced — the new path is monotonic.
        const seqAfter = rig.checkpoints.getLastPushedSeq();
        expect(Number(seqAfter)).toBeGreaterThan(Number(seqBefore));

        // unpushed-set has the file id, race-stale, attempts=1.
        const rows = await loadAllUnpushed(a.db);
        expect(rows.length).toBe(1);
        expect(rows[0].id).toBe(id);
        expect(rows[0].entry.reason).toBe("race-stale");
        expect(rows[0].entry.attempts).toBe(1);

        bulkSpy.mockRestore();
    });

    it("retry on next cycle clears unpushed-set when remote rev resolves", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        const rig = attach({ device: a, couch: h.couch, maxCycles: 2 });

        a.vault.addFile("retry.md", "v1");
        await a.vs.fileToDb("retry.md");
        const id = makeFileId("retry.md");

        // Cycle 1: conflict. Cycle 2 (and beyond): success.
        let cycle = 0;
        const bulkSpy = vi.spyOn(h.couch, "bulkDocs").mockImplementation(
            async (docs: any[]) => {
                cycle++;
                return docs.map((d: any) => {
                    if (cycle === 1 && d._id === id) {
                        return { id: d._id, error: "conflict", reason: "stale rev" };
                    }
                    return { ok: true, id: d._id, rev: `${cycle}-fake` };
                });
            },
        );

        await rig.pipeline.run();

        // After 2 cycles the set is empty: cycle 1 added the id, cycle 2
        // (whose pre-classify saw it again via the unpushed-set, and the
        // conflict was resolved) removed it.
        const rows = await loadAllUnpushed(a.db);
        expect(rows.length).toBe(0);

        bulkSpy.mockRestore();
    });

    it("divergent (vclock concurrent) routes to ConflictOrchestrator without bulkDocs attempt", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        const rig = attach({ device: a, couch: h.couch, maxCycles: 1 });

        // Pre-seed remote with a concurrent-vclock version.
        const id = makeFileId("conc.md");
        const remoteDoc: FileDoc = {
            _id: id, type: "file", chunks: [], vclock: { "dev-X": 1 },
            mtime: 0, ctime: 0, size: 0,
        };
        await h.couch.bulkDocs([remoteDoc as unknown as CouchSyncDoc]);

        // Local: different device key in vclock → concurrent.
        a.vault.addFile("conc.md", "local-v");
        await a.vs.fileToDb("conc.md");

        const concEvents: any[] = [];
        rig.events.on("concurrent", (p) => concEvents.push(p));

        const bulkSpy = vi.spyOn(h.couch, "bulkDocs");
        await rig.pipeline.run();

        // The file id was NOT included in any bulkDocs payload.
        const allBulkArgs = bulkSpy.mock.calls.flatMap((c) => (c[0] as any[]).map((d) => d._id));
        expect(allBulkArgs).not.toContain(id);

        // concurrent event fired with source: "push".
        expect(concEvents.length).toBe(1);
        expect(concEvents[0].source).toBe("push");
        expect(concEvents[0].filePath).toBe("conc.md");

        // unpushed-set has divergent entry for the file id.
        const rows = await loadAllUnpushed(a.db);
        const e = rows.find((r) => r.id === id);
        expect(e?.entry.reason).toBe("divergent");

        bulkSpy.mockRestore();
    });

    it("chunk conflict is silently absorbed (content-addressed → benign)", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        const rig = attach({ device: a, couch: h.couch, maxCycles: 1 });

        a.vault.addFile("with-chunks.md", "some content for chunks");
        await a.vs.fileToDb("with-chunks.md");

        const bulkSpy = vi.spyOn(h.couch, "bulkDocs").mockImplementation(
            async (docs: any[]) => {
                return docs.map((d: any) => {
                    if (d._id.startsWith("chunk:")) {
                        return { id: d._id, error: "conflict", reason: "rev mismatch" };
                    }
                    return { ok: true, id: d._id, rev: "1-fake" };
                });
            },
        );

        await rig.pipeline.run();

        const rows = await loadAllUnpushed(a.db);
        const chunkUnpushed = rows.filter((r) => r.id.startsWith("chunk:"));
        expect(chunkUnpushed.length).toBe(0);

        bulkSpy.mockRestore();
    });

    it("race-stale escalation: 3 consecutive conflicts re-flag the entry as divergent", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        // Need 4 cycles: 3 to accumulate attempts, one more so the 4th
        // pre-classify sees prevAttempts >= threshold and demotes.
        const rig = attach({ device: a, couch: h.couch, maxCycles: 4 });

        a.vault.addFile("escalate.md", "v1");
        await a.vs.fileToDb("escalate.md");
        const id = makeFileId("escalate.md");

        const bulkSpy = vi.spyOn(h.couch, "bulkDocs").mockImplementation(
            async (docs: any[]) => {
                return docs.map((d: any) => {
                    if (d._id === id) {
                        return { id: d._id, error: "conflict", reason: "rev mismatch" };
                    }
                    return { ok: true, id: d._id, rev: "1-fake" };
                });
            },
        );

        await rig.pipeline.run();

        const rows = await loadAllUnpushed(a.db);
        const e = rows.find((r) => r.id === id);
        expect(e).toBeDefined();
        expect(e!.entry.reason).toBe("divergent");
        expect(e!.entry.attempts).toBeGreaterThanOrEqual(3);

        bulkSpy.mockRestore();
    });

    it("zombie cleanup: id in unpushed-set with no local doc is dropped", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        const rig = attach({ device: a, couch: h.couch, maxCycles: 1 });

        // Pre-seed unpushed-set with a stale id whose local doc never existed.
        const ghostId = makeFileId("ghost.md");
        await a.db.runWriteTx({
            meta: [{
                op: "put",
                key: UNPUSHED_KEY_PREFIX + ghostId,
                value: { addedAt: 1, reason: "race-stale", attempts: 1 },
            }],
        });

        await rig.pipeline.run();

        const rows = await loadAllUnpushed(a.db);
        expect(rows.find((r) => r.id === ghostId)).toBeUndefined();
    });
});
