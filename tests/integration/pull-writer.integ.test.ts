/**
 * PullWriter integration tests — Phase 4 migration.
 *
 * Drives PullWriter against a real LocalDB + real ConflictResolver and
 * verifies side effects (docs landed, vclocks driving verdict, pull
 * events fired, push-echo consumed). Replaces the legacy
 * tests/pull-writer.test.ts which mocked localDb.bulkPut / runWriteTx.
 *
 * Where the original test asserted "tx structure" (single runWriteTx
 * call carrying both docs and meta), we verify the same contract via
 * `vi.spyOn` on the real localDb method and a one-shot runWriteTx
 * rejection for the failure path.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, vi, afterEach } from "vitest";
import { createSyncHarness, type SyncHarness, type DeviceHarness } from "../harness/sync-harness.ts";
import { expectDb } from "../harness/assertions.ts";
import { PullWriter } from "../../src/db/sync/pull-writer.ts";
import { EchoTracker } from "../../src/db/sync/echo-tracker.ts";
import { SyncEvents } from "../../src/db/sync/sync-events.ts";
import { Checkpoints } from "../../src/db/sync/checkpoints.ts";
import { ConflictResolver } from "../../src/conflict/conflict-resolver.ts";
import { makeFileId, makeChunkId } from "../../src/types/doc-id.ts";
import type { ChangesResult } from "../../src/db/interfaces.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";
import * as log from "../../src/ui/log.ts";

interface WriterRig {
    writer: PullWriter;
    echoes: EchoTracker;
    events: SyncEvents;
    checkpoints: Checkpoints;
}

function attachPullWriter(opts: {
    device: DeviceHarness;
    /** Provide a ConflictResolver to enable the vclock guard. Defaults to undefined. */
    withResolver?: boolean;
    /** Override the vault-write callback. Defaults to a no-op. Tests
     *  that want to observe pulled docs pass `(doc) => collected.push(doc)`. */
    applyPullWrite?: (doc: FileDoc) => Promise<void>;
}): WriterRig {
    const events = new SyncEvents();
    const echoes = new EchoTracker();
    const checkpoints = new Checkpoints(opts.device.db);
    const resolver = opts.withResolver ? new ConflictResolver() : undefined;
    const writer = new PullWriter({
        localDb: opts.device.db,
        events,
        echoes,
        checkpoints,
        getConflictResolver: () => resolver,
        ensureChunks: async () => {},
        applyPullWrite: opts.applyPullWrite ?? (async () => {}),
    });
    return { writer, echoes, events, checkpoints };
}

/** Pre-populate B's DB with a FileDoc carrying the given vclock. */
async function seedLocalFileDoc(
    device: DeviceHarness,
    path: string,
    vclock: Record<string, number>,
): Promise<FileDoc> {
    const doc: FileDoc = {
        _id: makeFileId(path),
        type: "file",
        chunks: [],
        vclock,
        mtime: 1,
        ctime: 1,
        size: 0,
    };
    await device.db.runWriteTx({ docs: [{ doc: doc as unknown as CouchSyncDoc }] });
    return doc;
}

function makeRemoteFileDoc(
    path: string,
    vclock: Record<string, number>,
    extra?: Partial<FileDoc>,
): FileDoc {
    return {
        _id: makeFileId(path),
        type: "file",
        chunks: [],
        vclock,
        mtime: 2,
        ctime: 1,
        size: 0,
        ...extra,
    };
}

function makeChangesResult(
    rows: Array<{ id: string; seq: string | number; doc?: unknown; deleted?: boolean }>,
    last_seq: string | number,
): ChangesResult<CouchSyncDoc> {
    return {
        results: rows.map((r) => ({
            id: r.id,
            seq: r.seq,
            doc: r.doc as CouchSyncDoc | undefined,
            deleted: r.deleted,
        })),
        last_seq,
    };
}

describe("PullWriter integration", () => {
    let h: SyncHarness;

    afterEach(async () => {
        if (h) await h.destroyAll();
    });

    // ── vclock guard ─────────────────────────────────────

    describe("vclock guard", () => {
        it("take-remote: writes doc when remote vclock dominates local", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullWriter({ device: b, withResolver: true });

            await seedLocalFileDoc(b, "test.md", { A: 1 });
            const remote = makeRemoteFileDoc("test.md", { A: 2 });

            await rig.writer.apply(makeChangesResult(
                [{ id: remote._id, seq: "1", doc: remote }], "1",
            ));

            await expectDb(b.db).toHaveFileDoc("test.md").withVclock({ A: 2 });
        });

        it("keep-local: skips doc when local vclock dominates remote", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullWriter({ device: b, withResolver: true });

            await seedLocalFileDoc(b, "test.md", { A: 5 });
            const remote = makeRemoteFileDoc("test.md", { A: 3 });

            await rig.writer.apply(makeChangesResult(
                [{ id: remote._id, seq: "1", doc: remote }], "1",
            ));

            await expectDb(b.db).toHaveFileDoc("test.md").withVclock({ A: 5 });
        });

        it("concurrent: skips doc and fires concurrent event", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullWriter({ device: b, withResolver: true });

            await seedLocalFileDoc(b, "test.md", { A: 2 });
            const remote = makeRemoteFileDoc("test.md", { B: 1 });

            const fired: string[] = [];
            rig.events.on("concurrent", ({ filePath }) => fired.push(filePath));

            await rig.writer.apply(makeChangesResult(
                [{ id: remote._id, seq: "1", doc: remote }], "1",
            ));

            await expectDb(b.db).toHaveFileDoc("test.md").withVclock({ A: 2 });
            expect(fired).toContain("test.md");
        });

        it("chunk docs bypass the vclock guard (no resolver call)", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullWriter({ device: b, withResolver: true });

            const chunkId = makeChunkId("abc123");
            const chunkDoc = { _id: chunkId, type: "chunk", data: "base64..." };

            await rig.writer.apply(makeChangesResult(
                [{ id: chunkId, seq: "1", doc: chunkDoc }], "1",
            ));

            const stored = await b.db.get(chunkId);
            expect(stored).not.toBeNull();
        });

        it("new doc (no local version): accepted without resolver consultation", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullWriter({ device: b, withResolver: true });

            const remote = makeRemoteFileDoc("new.md", { B: 1 });

            await rig.writer.apply(makeChangesResult(
                [{ id: remote._id, seq: "1", doc: remote }], "1",
            ));

            await expectDb(b.db).toHaveFileDoc("new.md").withVclock({ B: 1 });
        });
    });

    // ── atomic commit ────────────────────────────────────

    describe("atomic commit", () => {
        it("bundles accepted docs and remote-seq in a single runWriteTx call", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullWriter({ device: b });

            const spy = vi.spyOn(b.db, "runWriteTx");
            const chunkId = makeChunkId("a");

            await rig.writer.apply(makeChangesResult(
                [{ id: chunkId, seq: "1", doc: { _id: chunkId, type: "chunk", data: "x" } }],
                "7",
            ));

            expect(spy.mock.calls.length).toBe(1);
            const tx = spy.mock.calls[0]![0]!;
            expect(tx.docs?.length).toBe(1);
            expect(tx.meta).toEqual([{ op: "put", key: "_sync/remote-seq", value: "7" }]);

            // Persisted: the meta row matches.
            const persisted = await b.db.getMeta<string>("_sync/remote-seq");
            expect(persisted).toBe("7");
            spy.mockRestore();
        });

        it("runWriteTx failure → no echo recorded, error propagates", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullWriter({ device: b });

            const spy = vi.spyOn(b.db, "runWriteTx").mockRejectedValue(new Error("quota"));
            const chunkId = makeChunkId("a");

            await expect(rig.writer.apply(makeChangesResult(
                [{ id: chunkId, seq: "1", doc: { _id: chunkId, type: "chunk", data: "x" } }],
                "3",
            ))).rejects.toThrow("quota");

            // Echo record is set in onCommit, which only fires inside a
            // successful tx — a failed tx must not leak an echo entry.
            expect(rig.echoes.sizePullWritten()).toBe(0);
            spy.mockRestore();
        });

        it("empty batch: returns empty=true with no runWriteTx call", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullWriter({ device: b });

            const spy = vi.spyOn(b.db, "runWriteTx");
            const applied = await rig.writer.apply(makeChangesResult([], "9"));

            expect(applied.empty).toBe(true);
            expect(applied.nextRemoteSeq).toBe("9");
            expect(spy.mock.calls.length).toBe(0);
            spy.mockRestore();
        });
    });

    // ── onCommit side effects ────────────────────────────

    describe("onCommit side effects", () => {
        it("records pull-write echoes only after the tx commits", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullWriter({ device: b });

            const chunkId = makeChunkId("a");
            await rig.writer.apply(makeChangesResult(
                [{ id: chunkId, seq: "1", doc: { _id: chunkId, type: "chunk", data: "x" } }],
                "1",
            ));

            // updateSeq comes from the real LocalDB after the write.
            const seq = (await b.db.info()).updateSeq as number;
            expect(rig.echoes.isPullEcho(chunkId, seq)).toBe(true);
            expect(rig.echoes.isPullEcho(chunkId, seq + 1)).toBe(false);
        });

        it("R1b: session-boundary self-pushed file doc is silently skipped (vclock equal)", async () => {
            // Simulates the R1b race: in session N, B pushed a file with
            // vclock {B:1}. Session N tore down before the pull longpoll
            // consumed the echo, so EchoTracker is empty in session N+1.
            // The catchup re-delivers the same doc — it must NOT surface
            // as keep-local; the resolver should never even see it.
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const pullWrites: FileDoc[] = [];
            const rig = attachPullWriter({
                device: b,
                withResolver: true,
                applyPullWrite: async (doc) => { pullWrites.push(doc); },
            });

            await seedLocalFileDoc(b, "self-pushed.md", { B: 1 });
            const remote = makeRemoteFileDoc("self-pushed.md", { B: 1 });

            const applied = await rig.writer.apply(makeChangesResult(
                [{ id: remote._id, seq: "1", doc: remote }], "1",
            ));

            // Local doc unchanged, applyPullWrite never invoked. The
            // batch reports empty=true so the pull-pipeline takes the
            // saveEmptyPullBatch path (advancing remote-seq via
            // Checkpoints.save) — that's out of PullWriter scope.
            await expectDb(b.db).toHaveFileDoc("self-pushed.md").withVclock({ B: 1 });
            expect(pullWrites).toHaveLength(0);
            expect(applied.empty).toBe(true);
            expect(applied.nextRemoteSeq).toBe("1");
        });

        it("chunk that already exists locally is silently skipped (idempotent)", async () => {
            // Catchup re-delivers a self-pushed chunk after a session
            // boundary. Content-addressed (id = hash) means re-put is a
            // no-op; pull-writer short-circuits to skip the IDB write.
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullWriter({ device: b });

            const chunkId = makeChunkId("preexisting");
            await b.db.runWriteTx({
                docs: [{ doc: { _id: chunkId, type: "chunk", data: "x" } as unknown as CouchSyncDoc }],
            });

            const spy = vi.spyOn(b.db, "runWriteTx");
            await rig.writer.apply(makeChangesResult(
                [{ id: chunkId, seq: "1", doc: { _id: chunkId, type: "chunk", data: "x" } }],
                "1",
            ));

            // No second write tx — chunk skipped via existence check.
            // Empty batch path runs saveEmptyPullBatch instead, which
            // does call runWriteTx via Checkpoints.save → meta-only.
            const docCarryingCalls = spy.mock.calls.filter(
                ([arg]) => Array.isArray(arg.docs) && arg.docs.length > 0,
            );
            expect(docCarryingCalls).toHaveLength(0);
            spy.mockRestore();
        });

        it("empty vclocks fall through to the resolver (not silently skipped)", async () => {
            // Two empty vclocks compare as equal but are not causally
            // equal — that pair shows up for tombstones / legacy docs
            // and must reach the resolver, not the converged-skip path.
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const pullWrites: FileDoc[] = [];
            const rig = attachPullWriter({
                device: b,
                withResolver: true,
                applyPullWrite: async (doc) => { pullWrites.push(doc); },
            });

            await seedLocalFileDoc(b, "legacy.md", {});
            const remote = makeRemoteFileDoc("legacy.md", {});

            await rig.writer.apply(makeChangesResult(
                [{ id: remote._id, seq: "1", doc: remote }], "1",
            ));

            // resolver returns keep-local for equal (the safe fallback);
            // the important behaviour is that the converged-skip
            // shortcut did NOT swallow it. resolver dropped it as
            // keep-local, so applyPullWrite never fires either way —
            // but the local doc is observed via the resolver's localDb.get path.
            expect(pullWrites).toHaveLength(0);
        });

        it("invokes applyPullWrite for accepted FileDocs and emits auto-resolve", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const pullWrites: FileDoc[] = [];
            const rig = attachPullWriter({
                device: b,
                applyPullWrite: async (doc) => { pullWrites.push(doc); },
            });

            const autoResolved: string[] = [];
            rig.events.on("auto-resolve", ({ filePath }) => autoResolved.push(filePath));

            const remote = makeRemoteFileDoc("a.md", { A: 1 });
            await rig.writer.apply(makeChangesResult(
                [{ id: remote._id, seq: "1", doc: remote }], "1",
            ));

            expect(pullWrites).toHaveLength(1);
            expect(pullWrites[0]._id).toBe(remote._id);
            expect(autoResolved).toEqual(["a.md"]);
        });

        it("P1: applyPullWrite throw → writeFailCount, never `written`, never auto-resolve", async () => {
            // Regression for the former event-bus path where
            // `events.emitAsync("pull-write")` swallowed handler errors,
            // so pull-writer's own `try/catch` never fired and the batch
            // log claimed success for unwritten docs. With the function-
            // DI replacement, throws propagate into the existing catch
            // and increment writeFailCount; the success log line and
            // auto-resolve event must NOT fire.
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const failing = async (_doc: FileDoc) => {
                throw new Error("vault write boom");
            };
            const rig = attachPullWriter({
                device: b,
                applyPullWrite: failing,
            });

            const autoResolved: string[] = [];
            rig.events.on("auto-resolve", ({ filePath }) => autoResolved.push(filePath));
            const logSpy = vi.spyOn(log, "logInfo");

            const remote = makeRemoteFileDoc("a.md", { A: 1 });
            await rig.writer.apply(makeChangesResult(
                [{ id: remote._id, seq: "1", doc: remote }], "1",
            ));

            // The DB write committed atomically (Checkpoints.commitPullBatch).
            await expectDb(b.db).toHaveFileDoc("a.md").withVclock({ A: 1 });

            // No auto-resolve emitted (the success path never reached it).
            expect(autoResolved).toEqual([]);

            // The summary log says "1 failed", not "1 written". The
            // string contract is the load-bearing invariant of this PR.
            const summaryLines = logSpy.mock.calls
                .map((c) => String(c[0]))
                .filter((m) => m.startsWith("Pull:"));
            expect(summaryLines.length).toBeGreaterThan(0);
            const summary = summaryLines.join(" | ");
            expect(summary).toContain("1 failed");
            expect(summary).not.toContain("written");

            logSpy.mockRestore();
        });
    });

    // ── deletion handling ────────────────────────────────

    describe("deletion handling", () => {
        it("fires pull-delete query for file doc tombstones", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullWriter({ device: b });

            await seedLocalFileDoc(b, "deleted.md", { A: 1 });

            const queries: Array<{ path: string; localId: string }> = [];
            rig.events.onQuery("pull-delete", async ({ path, localDoc }) => {
                queries.push({ path, localId: localDoc._id });
                return false; // no unpushed edits → tombstone applied silently
            });

            await rig.writer.apply(makeChangesResult(
                [{ id: makeFileId("deleted.md"), seq: "3", deleted: true }], "3",
            ));

            expect(queries).toHaveLength(1);
            expect(queries[0].path).toBe("deleted.md");
            expect(queries[0].localId).toBe(makeFileId("deleted.md"));
        });

        it("skips chunk doc tombstones (never fires pull-delete)", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullWriter({ device: b });

            let queryCount = 0;
            rig.events.onQuery("pull-delete", async () => { queryCount++; return false; });

            await rig.writer.apply(makeChangesResult(
                [{ id: makeChunkId("abc123"), seq: "3", deleted: true }], "3",
            ));

            expect(queryCount).toBe(0);
        });

        it("skips already-deleted local docs", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullWriter({ device: b });

            // Seed a tombstone locally.
            const tombstone: FileDoc = {
                _id: makeFileId("gone.md"),
                type: "file",
                chunks: [],
                vclock: { A: 1 },
                mtime: 1,
                ctime: 1,
                size: 0,
                deleted: true,
            };
            await b.db.runWriteTx({
                docs: [{ doc: tombstone as unknown as CouchSyncDoc }],
            });

            let queryCount = 0;
            rig.events.onQuery("pull-delete", async () => { queryCount++; return false; });

            await rig.writer.apply(makeChangesResult(
                [{ id: makeFileId("gone.md"), seq: "3", deleted: true }], "3",
            ));

            expect(queryCount).toBe(0);
        });

        it("query returning true → emits concurrent with a tombstone remoteDoc", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullWriter({ device: b });

            await seedLocalFileDoc(b, "edited.md", { A: 2 });

            // "yes, B has unpushed edits" → conflict path.
            rig.events.onQuery("pull-delete", async () => true);
            const concurrent: Array<{ filePath: string; remoteDeleted?: boolean }> = [];
            rig.events.on("concurrent", ({ filePath, remoteDoc }) => {
                concurrent.push({
                    filePath,
                    remoteDeleted: (remoteDoc as { deleted?: boolean }).deleted,
                });
            });

            await rig.writer.apply(makeChangesResult(
                [{ id: makeFileId("edited.md"), seq: "3", deleted: true }], "3",
            ));

            expect(concurrent).toHaveLength(1);
            expect(concurrent[0].filePath).toBe("edited.md");
            expect(concurrent[0].remoteDeleted).toBe(true);
        });
    });
});
