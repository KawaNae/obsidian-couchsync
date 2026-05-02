/**
 * PushPipeline integration tests — Phase 4 migration.
 *
 * Drives PushPipeline against a real LocalDB + FakeCouchClient and
 * verifies observable side effects (docs landed in couch, echoes
 * recorded, errors emitted). Replaces the legacy
 * tests/push-pipeline.test.ts which mocked localDb / client method calls.
 *
 * Fault paths (halt DbError, 403 storm dedup, conflict-no-echo) keep
 * their original semantics via `vi.spyOn` on the harness components —
 * they're effect-checks ("only one error event was emitted") layered
 * on top of one-shot mock responses, not how-tests on internal call
 * counts.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { createSyncHarness, type SyncHarness, type DeviceHarness } from "../harness/sync-harness.ts";
import { expectCouch } from "../harness/assertions.ts";
import { PushPipeline } from "../../src/db/sync/push-pipeline.ts";
import { EchoTracker } from "../../src/db/sync/echo-tracker.ts";
import { SyncEvents } from "../../src/db/sync/sync-events.ts";
import { Checkpoints } from "../../src/db/sync/checkpoints.ts";
import { DbError } from "../../src/db/write-transaction.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";
import { ALWAYS_VISIBLE, type VisibilityGate } from "../../src/db/visibility-gate.ts";

/** Controllable gate for tests that need to flip visibility on demand. */
class FakeVisibilityGate implements VisibilityGate {
    private hidden = false;
    private waiters = new Set<() => void>();
    private hiddenAbortListeners = new Set<() => void>();
    isHidden(): boolean { return this.hidden; }
    waitVisible(signal: AbortSignal): Promise<void> {
        if (!this.hidden) return Promise.resolve();
        if (signal.aborted) return Promise.resolve();
        return new Promise<void>((resolve) => {
            const done = () => {
                this.waiters.delete(done);
                signal.removeEventListener("abort", done);
                resolve();
            };
            this.waiters.add(done);
            signal.addEventListener("abort", done, { once: true });
        });
    }
    linkedAbortOnHidden(externalSignal: AbortSignal) {
        const c = new AbortController();
        if (externalSignal.aborted || this.hidden) {
            c.abort();
            return { signal: c.signal, release: () => {} };
        }
        let released = false;
        const trigger = () => {
            if (released) return;
            released = true;
            externalSignal.removeEventListener("abort", trigger);
            this.hiddenAbortListeners.delete(trigger);
            c.abort();
        };
        externalSignal.addEventListener("abort", trigger, { once: true });
        this.hiddenAbortListeners.add(trigger);
        return {
            signal: c.signal,
            release: () => {
                if (released) return;
                released = true;
                externalSignal.removeEventListener("abort", trigger);
                this.hiddenAbortListeners.delete(trigger);
            },
        };
    }
    setHidden(hidden: boolean): void {
        const wasHidden = this.hidden;
        this.hidden = hidden;
        if (!hidden) {
            for (const fn of [...this.waiters]) fn();
            this.waiters.clear();
        }
        if (hidden && !wasHidden) {
            const snap = [...this.hiddenAbortListeners];
            this.hiddenAbortListeners.clear();
            for (const fn of snap) fn();
        }
    }
}

interface PipelineRig {
    pipeline: PushPipeline;
    echoes: EchoTracker;
    events: SyncEvents;
    checkpoints: Checkpoints;
    pausedCount: { value: number };
    cancel: () => void;
    abort: () => void;
    signal: AbortSignal;
    dbErrorCalls: Array<{ err: unknown; ctx: string }>;
}

/**
 * Wire a PushPipeline onto a device. The `runOnce` flag flips the
 * cancellation latch as soon as `delay()` is awaited, so a single
 * iteration of the loop runs and then `pipeline.run()` returns.
 */
function attachPushPipeline(opts: {
    device: DeviceHarness;
    couch: SyncHarness["couch"];
    runOnce?: boolean;
    visibility?: VisibilityGate;
}): PipelineRig {
    const events = new SyncEvents();
    const echoes = new EchoTracker();
    const checkpoints = new Checkpoints(opts.device.db);
    const pausedCount = { value: 0 };
    events.on("paused", () => { pausedCount.value++; });

    let cancelled = false;
    const controller = new AbortController();
    const dbErrorCalls: Array<{ err: unknown; ctx: string }> = [];

    const pipeline = new PushPipeline({
        localDb: opts.device.db,
        client: opts.couch,
        echoes,
        events,
        checkpoints,
        sessionEpoch: 1,
        visibility: opts.visibility ?? ALWAYS_VISIBLE,
        isCancelled: () => cancelled,
        signal: controller.signal,
        handleLocalDbError: (err, ctx) => { dbErrorCalls.push({ err, ctx }); },
        delay: async () => {
            if (opts.runOnce) cancelled = true;
        },
    });

    return {
        pipeline,
        echoes,
        events,
        checkpoints,
        pausedCount,
        cancel: () => { cancelled = true; },
        abort: () => controller.abort(),
        signal: controller.signal,
        dbErrorCalls,
    };
}

describe("PushPipeline integration", () => {
    let h: SyncHarness;

    afterEach(async () => {
        if (h) await h.destroyAll();
    });

    // ── run loop ─────────────────────────────────────────

    describe("run loop", () => {
        it("polls localDb.changes and pushes replicated docs to couch", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            const rig = attachPushPipeline({ device: a, couch: h.couch, runOnce: true });

            a.vault.addFile("notes/x.md", "hello");
            await a.vs.fileToDb("notes/x.md");

            await rig.pipeline.run();

            await expectCouch(h.couch).toHaveDoc(makeFileId("notes/x.md"));
            // SyncEngine wires lastHealthyAt off paused — pipeline must emit it.
            expect(rig.pausedCount.value).toBeGreaterThanOrEqual(1);
        });

        it("skips non-replicated doc IDs (_local/*)", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            const rig = attachPushPipeline({ device: a, couch: h.couch, runOnce: true });

            // _local/* docs go through runWriteTx but are filtered out by
            // PushPipeline.isReplicatedDocId before bulkDocs.
            await a.db.runWriteTx({
                docs: [{
                    doc: {
                        _id: "_local/something",
                        type: "file",
                        chunks: [],
                        vclock: {},
                        mtime: 1,
                        ctime: 1,
                        size: 0,
                    } as unknown as CouchSyncDoc,
                }],
            });

            await rig.pipeline.run();

            await expectCouch(h.couch).toNotHaveDoc("_local/something");
        });

        it("filters out pull echoes based on seq comparison", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            const rig = attachPushPipeline({ device: a, couch: h.couch, runOnce: true });

            // Create a real local change for an arbitrary file.
            a.vault.addFile("echo.md", "echoed");
            await a.vs.fileToDb("echo.md");
            const echoId = makeFileId("echo.md");
            const change = (await a.db.changes(0)).results.find((r) => r.id === echoId)!;
            const seqNum = typeof change.seq === "number" ? change.seq : parseInt(String(change.seq), 10);

            // Mark it as a pull-echo at exactly its seq → push must skip.
            rig.echoes.recordPullWrites([echoId], seqNum);

            await rig.pipeline.run();

            await expectCouch(h.couch).toNotHaveDoc(echoId);
        });

        it("lets post-pull edits through (local seq > recorded pull seq)", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            const rig = attachPushPipeline({ device: a, couch: h.couch, runOnce: true });

            a.vault.addFile("fresh.md", "new");
            await a.vs.fileToDb("fresh.md");
            const id = makeFileId("fresh.md");
            const change = (await a.db.changes(0)).results.find((r) => r.id === id)!;
            const seqNum = typeof change.seq === "number" ? change.seq : parseInt(String(change.seq), 10);

            // Pull recorded at (seq - 1) → local change at `seq` is post-pull.
            rig.echoes.recordPullWrites([id], Math.max(0, seqNum - 1));

            await rig.pipeline.run();

            await expectCouch(h.couch).toHaveDoc(id);
        });

        it("pauses the loop while visibility gate reports hidden, resumes on visible", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            const gate = new FakeVisibilityGate();
            gate.setHidden(true);
            const rig = attachPushPipeline({ device: a, couch: h.couch, runOnce: true, visibility: gate });

            a.vault.addFile("x.md", "hello");
            await a.vs.fileToDb("x.md");

            const changesSpy = vi.spyOn(a.db, "changes");

            const runP = rig.pipeline.run();
            // Give the loop time to enter waitVisible.
            await new Promise((r) => setTimeout(r, 30));
            expect(changesSpy).not.toHaveBeenCalled();

            // Reveal the page → loop runs one iteration → runOnce cancels it.
            gate.setHidden(false);
            await runP;

            expect(changesSpy).toHaveBeenCalled();
            await expectCouch(h.couch).toHaveDoc(makeFileId("x.md"));
            changesSpy.mockRestore();
        });

        it("visibility:hidden mid-fetch aborts the cycle signal (proactive cancel of in-flight push)", async () => {
            // End-to-end of the v0.21.x cycle-abort design: pipeline asks
            // gate for a linked signal, fetch sees hidden→abort, catch
            // silent-continues, top of loop blocks in waitVisible.
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            const gate = new FakeVisibilityGate();
            const rig = attachPushPipeline({ device: a, couch: h.couch, visibility: gate });

            a.vault.addFile("x.md", "hello");
            await a.vs.fileToDb("x.md");

            const errors: string[] = [];
            rig.events.on("error", ({ message }) => errors.push(message));

            // Capture the FIRST iteration's signal so the second iter
            // (after re-show) can't overwrite our reference. Only the
            // first cycle's signal should be aborted by the hidden flip.
            let firstSignal: AbortSignal | undefined;
            let calls = 0;
            const allDocsSpy = vi.spyOn(h.couch, "allDocs").mockImplementation(
                async (_opts: any, signal?: any) => {
                    calls++;
                    if (calls === 1) {
                        firstSignal = signal;
                        // Flip hidden mid-fetch → cycle signal aborts
                        // synchronously via the gate's hidden listeners.
                        gate.setHidden(true);
                        const e: any = new Error("aborted");
                        e.name = "AbortError";
                        throw e;
                    }
                    // Subsequent iters (after we re-show) satisfy push end-to-end.
                    rig.cancel(); // bound the loop after the recovery path
                    return { rows: [] } as any;
                },
            );

            const runP = rig.pipeline.run();
            // Give the loop time to enter waitVisible after the abort.
            await new Promise((r) => setTimeout(r, 30));
            // Reveal — pipeline iterates again, then cancels.
            gate.setHidden(false);
            await runP;

            // First cycle's signal was aborted by the hidden transition.
            expect(firstSignal?.aborted).toBe(true);
            // No surfaced error: visibility-induced abort is silent.
            expect(errors).toHaveLength(0);
            allDocsSpy.mockRestore();
        });

        it("dispose() during waitVisible exits the loop without running an iteration", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            const gate = new FakeVisibilityGate();
            gate.setHidden(true);
            const rig = attachPushPipeline({ device: a, couch: h.couch, visibility: gate });

            const changesSpy = vi.spyOn(a.db, "changes");

            const runP = rig.pipeline.run();
            await new Promise((r) => setTimeout(r, 30));

            // Cancel + abort while still parked in waitVisible.
            rig.cancel();
            rig.abort();
            await runP;

            expect(changesSpy).not.toHaveBeenCalled();
            changesSpy.mockRestore();
        });

        it("halt DbError from localDb.changes exits the loop", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            const rig = attachPushPipeline({ device: a, couch: h.couch });

            const err = new DbError("quota", "full", { recovery: "halt" });
            const spy = vi.spyOn(a.db, "changes").mockRejectedValue(err);

            await rig.pipeline.run();

            expect(rig.dbErrorCalls).toHaveLength(1);
            // Context now carries a stage marker for diagnostic logs.
            expect(rig.dbErrorCalls[0].ctx).toBe("push loop [stage:changes]");
            expect(rig.dbErrorCalls[0].err).toBe(err);
            spy.mockRestore();
        });
    });

    // ── pushDocs ─────────────────────────────────────────

    describe("pushDocs", () => {
        it("threads remote revs onto docs before bulkDocs", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            const rig = attachPushPipeline({ device: a, couch: h.couch });

            // Pre-seed couch so allDocs returns a rev for our id.
            const id = makeFileId("threaded.md");
            await h.couch.bulkDocs([
                { _id: id, type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0 } as unknown as CouchSyncDoc,
            ]);

            // Capture what was actually sent to bulkDocs.
            const spy = vi.spyOn(h.couch, "bulkDocs");

            await rig.pipeline.pushDocs([
                { _id: id, type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0 } as unknown as CouchSyncDoc,
            ]);

            // The pushed doc should carry the rev fetched from allDocs.
            const pushed = spy.mock.calls.at(-1)![0] as Array<CouchSyncDoc & { _rev?: string }>;
            expect(pushed[0]._rev).toBeTruthy();
            spy.mockRestore();
        });

        it("records push-echo for successful pushes", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            const rig = attachPushPipeline({ device: a, couch: h.couch });

            const id = makeFileId("pushed.md");
            await rig.pipeline.pushDocs([
                { _id: id, type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0 } as unknown as CouchSyncDoc,
            ]);

            // consumePushEcho returns true once for a recorded id.
            expect(rig.echoes.consumePushEcho(id)).toBe(true);
        });

        it("emits error event once per session on a 403 storm", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            const rig = attachPushPipeline({ device: a, couch: h.couch });

            const errors: string[] = [];
            rig.events.on("error", ({ message }) => errors.push(message));

            const idA = makeFileId("a.md");
            const idB = makeFileId("b.md");

            // First storm → 1 error event.
            const spy = vi.spyOn(h.couch, "bulkDocs").mockResolvedValueOnce([
                { ok: false, error: "forbidden", reason: "no perm", id: idA },
                { ok: false, error: "forbidden", reason: "no perm", id: idB },
            ] as any);

            await rig.pipeline.pushDocs([
                { _id: idA, type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0 } as unknown as CouchSyncDoc,
                { _id: idB, type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0 } as unknown as CouchSyncDoc,
            ]);

            expect(errors).toHaveLength(1);
            expect(errors[0]).toContain("denied");

            // Second storm → latch suppresses the repeat.
            spy.mockResolvedValueOnce([
                { ok: false, error: "forbidden", reason: "no perm", id: makeFileId("c.md") },
            ] as any);
            await rig.pipeline.pushDocs([
                { _id: makeFileId("c.md"), type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0 } as unknown as CouchSyncDoc,
            ]);
            expect(errors).toHaveLength(1);
            spy.mockRestore();
        });

        it("does not record push-echo for conflicted or denied docs", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            const rig = attachPushPipeline({ device: a, couch: h.couch });

            const idA = makeFileId("a.md");
            const idB = makeFileId("b.md");

            const spy = vi.spyOn(h.couch, "bulkDocs").mockResolvedValueOnce([
                { ok: false, error: "conflict", id: idA },
                { ok: false, error: "forbidden", reason: "no perm", id: idB },
            ] as any);

            await rig.pipeline.pushDocs([
                { _id: idA, type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0 } as unknown as CouchSyncDoc,
                { _id: idB, type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0 } as unknown as CouchSyncDoc,
            ]);

            expect(rig.echoes.consumePushEcho(idA)).toBe(false);
            expect(rig.echoes.consumePushEcho(idB)).toBe(false);
            spy.mockRestore();
        });

        // ── AbortSignal propagation (v0.20.3) ───────────────

        it("passes deps.signal to client.bulkDocs during pushDocs", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            const rig = attachPushPipeline({ device: a, couch: h.couch });

            a.vault.addFile("x.md", "hello");
            await a.vs.fileToDb("x.md");

            let capturedBulk: AbortSignal | undefined;
            let capturedAll: AbortSignal | undefined;
            const bulkSpy = vi.spyOn(h.couch, "bulkDocs").mockImplementation(
                async (_docs: any, signal?: any) => {
                    capturedBulk = signal;
                    return [];
                },
            );
            const allSpy = vi.spyOn(h.couch, "allDocs").mockImplementation(
                async (_opts: any, signal?: any) => {
                    capturedAll = signal;
                    return { rows: [] };
                },
            );

            const id = makeFileId("x.md");
            await rig.pipeline.pushDocs([
                { _id: id, type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0 } as unknown as CouchSyncDoc,
            ]);

            expect(capturedAll).toBe(rig.signal);
            expect(capturedBulk).toBe(rig.signal);
            bulkSpy.mockRestore();
            allSpy.mockRestore();
        });

        it("exits cleanly on session dispose (cancel + abort together)", async () => {
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            const rig = attachPushPipeline({ device: a, couch: h.couch });

            a.vault.addFile("x.md", "hello");
            await a.vs.fileToDb("x.md");

            let calls = 0;
            const spy = vi.spyOn(h.couch, "bulkDocs").mockImplementation(async () => {
                calls++;
                rig.cancel();    // simulate dispose: cancel + abort together
                rig.abort();
                const e: any = new Error("aborted");
                e.name = "AbortError";
                throw e;
            });

            await rig.pipeline.run();
            // Dispose path: isCancelled check returns before AbortError.
            expect(calls).toBe(1);
            spy.mockRestore();
        });

        it("AbortError without cancel = visibility-induced → silent continue", async () => {
            // Cycle signal aborted without session cancellation = the
            // page went hidden mid-fetch. Loop back to top, waitVisible
            // gates further iterations. Verified here by counting calls
            // and ensuring no error event is emitted.
            h = createSyncHarness();
            const a = h.addDevice("dev-A");
            const rig = attachPushPipeline({ device: a, couch: h.couch });

            a.vault.addFile("x.md", "hello");
            await a.vs.fileToDb("x.md");

            const errors: string[] = [];
            rig.events.on("error", ({ message }) => errors.push(message));

            let calls = 0;
            const spy = vi.spyOn(h.couch, "bulkDocs").mockImplementation(async () => {
                calls++;
                if (calls >= 3) rig.cancel(); // bound the loop
                const e: any = new Error("aborted");
                e.name = "AbortError";
                throw e;
            });

            await rig.pipeline.run();
            expect(calls).toBe(3);
            expect(errors).toHaveLength(0); // silent continue, no surfaced error
            spy.mockRestore();
        });
    });
});
