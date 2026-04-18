/**
 * PullPipeline integration tests — Phase 4 migration.
 *
 * Drives PullPipeline against a real LocalDB + FakeCouchClient + real
 * PullWriter, and verifies observable side effects (docs in DB,
 * checkpoint advancement, emitted events). Replaces the legacy
 * tests/pull-pipeline.test.ts which mocked localDb / client method calls.
 *
 * For the few scenarios that exercise error / backoff / dedup paths
 * (where a deterministic effect is hard to set up against in-memory
 * fakes), we use `vi.spyOn` on the harness components for one-shot
 * fault injection — preserving the original semantics without
 * recreating the mock-heavy Mock client.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { createSyncHarness, type SyncHarness, type DeviceHarness } from "../harness/sync-harness.ts";
import { expectDb } from "../harness/assertions.ts";
import { PullPipeline } from "../../src/db/sync/pull-pipeline.ts";
import { PullWriter } from "../../src/db/sync/pull-writer.ts";
import { EchoTracker } from "../../src/db/sync/echo-tracker.ts";
import { SyncEvents } from "../../src/db/sync/sync-events.ts";
import { Checkpoints } from "../../src/db/sync/checkpoints.ts";
import { ErrorRecovery } from "../../src/db/error-recovery.ts";
import { AuthGate } from "../../src/db/sync/auth-gate.ts";
import { DbError } from "../../src/db/write-transaction.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";

interface PipelineRig {
    pipeline: PullPipeline;
    events: SyncEvents;
    checkpoints: Checkpoints;
    pausedCount: { value: number };
    cancel: () => void;
    /** Calls captured by the handleLocalDbError stub. */
    dbErrorCalls: Array<{ err: unknown; ctx: string }>;
}

function attachPullPipeline(opts: {
    device: DeviceHarness;
    couch: SyncHarness["couch"];
}): PipelineRig {
    const events = new SyncEvents();
    const echoes = new EchoTracker();
    const checkpoints = new Checkpoints(opts.device.db);
    const pausedCount = { value: 0 };
    events.on("paused", () => { pausedCount.value++; });

    const pullWriter = new PullWriter({
        localDb: opts.device.db,
        events,
        echoes,
        checkpoints,
        getConflictResolver: () => opts.device.resolver,
        ensureChunks: async () => {},
    });

    let cancelled = false;
    const errorRecovery = new ErrorRecovery(
        {
            getState: () => "connected",
            setState: () => {},
            emitError: () => {},
            teardown: () => {},
            requestReconnect: async () => {},
        },
        new AuthGate(),
    );

    const dbErrorCalls: Array<{ err: unknown; ctx: string }> = [];

    const pipeline = new PullPipeline({
        client: opts.couch,
        pullWriter,
        checkpoints,
        errorRecovery,
        events,
        isCancelled: () => cancelled,
        handleLocalDbError: (err, ctx) => { dbErrorCalls.push({ err, ctx }); },
        delay: async () => {},
    });

    return {
        pipeline,
        events,
        checkpoints,
        pausedCount,
        cancel: () => { cancelled = true; },
        dbErrorCalls,
    };
}

/** Push a file from device A through the shared couch (full bulkDocs of
 *  FileDoc + ChunkDocs) so the remote has something to be pulled. */
async function seedRemote(
    h: SyncHarness,
    a: DeviceHarness,
    path: string,
    content: string,
): Promise<FileDoc> {
    a.vault.addFile(path, content);
    await a.vs.fileToDb(path);
    const doc = (await a.db.get(makeFileId(path))) as FileDoc;
    const chunks = await a.db.getChunks(doc.chunks);
    await h.couch.bulkDocs([
        doc as unknown as CouchSyncDoc,
        ...(chunks as unknown as CouchSyncDoc[]),
    ]);
    return doc;
}

describe("PullPipeline integration", () => {
    let h: SyncHarness;

    afterEach(async () => {
        if (h) await h.destroyAll();
    });

    // ── runCatchup ───────────────────────────────────────

    describe("runCatchup", () => {
        it("drains a docs-in-couch state into B's local DB", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            const b = h.addDevice("dev-B");
            const rig = attachPullPipeline({ device: b, couch: h.couch });

            const d1 = await seedRemote(h, a, "notes/one.md", "one");
            const d2 = await seedRemote(h, a, "notes/two.md", "two");

            await rig.pipeline.runCatchup();

            await expectDb(b.db).toHaveFileDoc("notes/one.md").withChunks(d1.chunks.length);
            await expectDb(b.db).toHaveFileDoc("notes/two.md").withChunks(d2.chunks.length);
            // Checkpoint advanced past the seeded docs.
            expect(Number(rig.checkpoints.getRemoteSeq())).toBeGreaterThan(0);
        });

        it("exits cleanly on empty remote (no docs, no errors)", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullPipeline({ device: b, couch: h.couch });

            await rig.pipeline.runCatchup();

            const any = await b.db.allDocs({ limit: 10 });
            expect(any.rows.length).toBe(0);
        });

        it("exits early if cancelled before first fetch", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            const b = h.addDevice("dev-B");
            await seedRemote(h, a, "notes/x.md", "x");
            const rig = attachPullPipeline({ device: b, couch: h.couch });

            rig.cancel();
            await rig.pipeline.runCatchup();

            // No docs landed on B because the loop returned before fetching.
            const any = await b.db.allDocs({ limit: 10 });
            expect(any.rows.length).toBe(0);
        });

        it("advances remoteSeq even when the empty batch is the first batch", async () => {
            // Empty remote: PullPipeline calls Checkpoints.saveEmptyPullBatch
            // which both updates in-memory remoteSeq and persists it.
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullPipeline({ device: b, couch: h.couch });

            await rig.pipeline.runCatchup();

            // Couch has seq=0 → remoteSeq is set to 0 (still falsy but
            // no exception thrown). The persisted META row reflects this.
            const persisted = await b.db.getStore().getMeta<number | string>("_sync/remote-seq");
            expect(persisted).toBe(0);
        });
    });

    // ── runLongpoll ──────────────────────────────────────

    describe("runLongpoll", () => {
        it("applies received changes and emits paused after batch", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            const b = h.addDevice("dev-B");
            const rig = attachPullPipeline({ device: b, couch: h.couch });

            await seedRemote(h, a, "live.md", "from-A");

            // Cancel after the first batch is applied so the loop returns.
            rig.events.on("paused", () => rig.cancel());

            await rig.pipeline.runLongpoll();

            await expectDb(b.db).toHaveFileDoc("live.md");
            expect(rig.pausedCount.value).toBeGreaterThanOrEqual(1);
        });

        it("empty longpoll result emits no paused (no batch applied)", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullPipeline({ device: b, couch: h.couch });

            // Cancel after the first iteration to avoid spinning forever.
            const spy = vi.spyOn(h.couch, "changesLongpoll");
            spy.mockImplementationOnce(async () => {
                rig.cancel();
                return { results: [], last_seq: "0" };
            });

            await rig.pipeline.runLongpoll();

            expect(rig.pausedCount.value).toBe(0);
            spy.mockRestore();
        });

        it("DbError with recovery=halt exits the loop immediately", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            const b = h.addDevice("dev-B");
            await seedRemote(h, a, "doomed.md", "x");
            const rig = attachPullPipeline({ device: b, couch: h.couch });

            // Force runWriteTx (used by Checkpoints.commitPullBatch) to
            // throw a halt-class DbError so the pipeline reports it via
            // handleLocalDbError and exits.
            const err = new DbError("quota", "quota exceeded", { recovery: "halt" });
            const spy = vi.spyOn(b.db, "runWriteTx").mockRejectedValue(err);

            await rig.pipeline.runLongpoll();

            expect(rig.dbErrorCalls).toHaveLength(1);
            expect(rig.dbErrorCalls[0].ctx).toBe("pull write");
            expect(rig.dbErrorCalls[0].err).toBe(err);
            spy.mockRestore();
        });

        it("exponential backoff doubles retryMs on consecutive transient errors (capped at 30s)", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullPipeline({ device: b, couch: h.couch });

            let calls = 0;
            const spy = vi.spyOn(h.couch, "changesLongpoll").mockImplementation(async () => {
                calls++;
                if (calls > 5) rig.cancel();
                throw new Error("network offline");
            });

            await rig.pipeline.runLongpoll();

            expect(rig.pipeline.getRetryMs()).toBeLessThanOrEqual(30_000);
            expect(rig.pipeline.getRetryMs()).toBeGreaterThanOrEqual(4_000);
            spy.mockRestore();
        });

        it("records the last transient error message for dedup", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullPipeline({ device: b, couch: h.couch });

            let calls = 0;
            const spy = vi.spyOn(h.couch, "changesLongpoll").mockImplementation(async () => {
                calls++;
                if (calls > 2) rig.cancel();
                throw new Error("network offline");
            });

            await rig.pipeline.runLongpoll();

            expect(rig.pipeline.getLastErrorMsg()).toContain("offline");
            spy.mockRestore();
        });
    });
});
