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
import {
    loadAllPendingConflict,
    clearPendingConflict,
} from "../../src/db/sync/pending-conflict.ts";
import { loadAllPendingApply } from "../../src/db/sync/pending-apply.ts";
import { ConflictResolver } from "../../src/conflict/conflict-resolver.ts";
import type { WriteResult } from "../../src/sync/vault-writer.ts";
import { makeFileId, makeChunkId } from "../../src/types/doc-id.ts";
import type { ChangesResult } from "../../src/db/interfaces.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";
import { FILE_SCHEMA_VERSION } from "../../src/types.ts";
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
    /** Override the vault-write callback. Defaults to applied:true (= success).
     *  Tests that want to observe pulled docs pass `(doc) => collected.push(doc)`.
     *  Pass an async returning `{applied:false, reason}` to simulate vault writer
     *  decline (IME divergence etc.). */
    applyPullWrite?: (doc: FileDoc) => Promise<WriteResult> | Promise<void>;
    /** Re-fetch a remote FileDoc for the local-delete-vs-remote-edit
     *  re-presentation (#7). Defaults to "absent". */
    getRemoteDoc?: (id: string) => Promise<FileDoc | null>;
    /** Probe for an unpushed local edit (hard-delete path, #del-1). Defaults
     *  to "no unpushed" so a tombstone applies durably. */
    probeUnpushed?: (path: string) => Promise<boolean>;
    /** Override the chunk-fetch callback (defaults to no-op). Tests that
     *  assert WHICH docs get their chunks ensured pass a recorder. */
    ensureChunks?: (doc: FileDoc) => Promise<void>;
}): WriterRig {
    const events = new SyncEvents();
    const echoes = new EchoTracker();
    const checkpoints = new Checkpoints(opts.device.db);
    const resolver = opts.withResolver ? new ConflictResolver() : undefined;
    const callback = opts.applyPullWrite;
    const writer = new PullWriter({
        localDb: opts.device.db,
        events,
        echoes,
        checkpoints,
        getConflictResolver: () => resolver,
        ensureChunks: opts.ensureChunks ?? (async () => {}),
        getRemoteDoc: opts.getRemoteDoc ?? (async () => null),
        applyPullWrite: async (doc) => {
            if (!callback) return { applied: true };
            const ret = await callback(doc);
            // Backwards-compat: legacy callbacks returning void are treated as success.
            return ret ?? { applied: true };
        },
        probeUnpushed: opts.probeUnpushed ?? (async () => false),
    });
    return { writer, echoes, events, checkpoints };
}

/** Pre-populate B's DB with a FileDoc carrying the given vclock. */
async function seedLocalFileDoc(
    device: DeviceHarness,
    path: string,
    vclock: Record<string, number>,
    chunks: string[] = [],
): Promise<FileDoc> {
    const doc: FileDoc = {
        _id: makeFileId(path),
        type: "file",
        schemaVersion: FILE_SCHEMA_VERSION,
        chunks,
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
        schemaVersion: FILE_SCHEMA_VERSION,
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

        it("schema gate: aborts on a FileDoc whose schemaVersion this build can't read", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullWriter({ device: b, withResolver: true });

            const remote = makeRemoteFileDoc("future.md", { A: 1 }, {
                schemaVersion: 3 as unknown as FileDoc["schemaVersion"],
            });

            await expect(
                rig.writer.apply(makeChangesResult(
                    [{ id: remote._id, seq: "1", doc: remote }], "1",
                )),
            ).rejects.toMatchObject({
                name: "SchemaVersionMismatchError",
                kind: "file",
                nonRetriable: true,
            });
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

        it("concurrent: skips doc and fires concurrent event (chunks differ)", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullWriter({ device: b, withResolver: true });

            // Seed with a non-empty local chunk so the remote (different
            // chunk) is genuinely concurrent. Pre-PR4 this test passed with
            // empty chunks on both sides because the resolver ignored
            // content; post-PR4 the classifier silent-merges chunk-equal
            // pairs, so the chunks must differ to exercise concurrent.
            await seedLocalFileDoc(b, "test.md", { A: 2 }, ["chunk:local"]);
            const remote = makeRemoteFileDoc("test.md", { B: 1 }, {
                chunks: ["chunk:remote"],
            });

            const fired: string[] = [];
            rig.events.on("concurrent", ({ filePath }) => fired.push(filePath));

            await rig.writer.apply(makeChangesResult(
                [{ id: remote._id, seq: "1", doc: remote }], "1",
            ));

            await expectDb(b.db).toHaveFileDoc("test.md").withVclock({ A: 2 });
            expect(fired).toContain("test.md");
        });

        it("PR4: silent-merge when vclocks divergent but chunks identical (audit MEDIUM)", async () => {
            // audit-2026-05-08 MEDIUM: a re-imported device pushed under its
            // own deviceId, then catchup brings remote with same content but
            // a foreign device's vclock. Pre-PR4 fired a `concurrent` event
            // (false positive); post-PR4 silently merges.
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullWriter({ device: b, withResolver: true });

            await seedLocalFileDoc(b, "shared.md", { B: 1 }, ["shared-chunk"]);
            const remote = makeRemoteFileDoc("shared.md", { A: 5 }, {
                chunks: ["shared-chunk"],
            });

            const fired: string[] = [];
            rig.events.on("concurrent", ({ filePath }) => fired.push(filePath));

            await rig.writer.apply(makeChangesResult(
                [{ id: remote._id, seq: "1", doc: remote }], "1",
            ));

            // Doc committed with merged vclock. No concurrent event.
            await expectDb(b.db).toHaveFileDoc("shared.md").withVclock({ A: 5, B: 1 });
            expect(fired).toEqual([]);
        });

        it("chunk rows from _changes are dropped (v2: chunks land via attachment fetch, not feed)", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullWriter({ device: b, withResolver: true });

            const chunkId = makeChunkId("abc1234567890def");
            const chunkDoc = { _id: chunkId, type: "chunk", data: "base64..." };

            await rig.writer.apply(makeChangesResult(
                [{ id: chunkId, seq: "1", doc: chunkDoc }], "1",
            ));

            // v2 semantics: chunks no longer flow through pull-writer.
            // The row is observed (chunkCount stats) but its body is
            // discarded; the canonical content arrives via ensureChunks
            // when the referencing FileDoc lands. The local DB therefore
            // stays empty for this chunk after a chunk-only batch.
            const stored = await b.db.get(chunkId);
            expect(stored).toBeNull();
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
            // v2: pull-writer commits file (and config) docs; chunks bypass
            // this path entirely. Use a FileDoc to exercise the commit tx.
            const fileDoc = makeRemoteFileDoc("bundle.md", { A: 1 });

            await rig.writer.apply(makeChangesResult(
                [{ id: fileDoc._id, seq: "1", doc: fileDoc }],
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
            // v2: drive the commit path with a FileDoc, since chunk rows
            // are now discarded before reaching `commit()`.
            const fileDoc = makeRemoteFileDoc("fail.md", { A: 1 });

            await expect(rig.writer.apply(makeChangesResult(
                [{ id: fileDoc._id, seq: "1", doc: fileDoc }],
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

            // v2: chunks bypass pull-writer entirely (no echo entry needed
            // because they never reach the pull-echo guard). FileDoc echo
            // recording remains the load-bearing case for this test.
            const fileDoc = makeRemoteFileDoc("echo.md", { A: 1 });
            await rig.writer.apply(makeChangesResult(
                [{ id: fileDoc._id, seq: "1", doc: fileDoc }],
                "1",
            ));

            // updateSeq comes from the real LocalDB after the write.
            const seq = (await b.db.info()).updateSeq as number;
            expect(rig.echoes.isPullEcho(fileDoc._id, seq)).toBe(true);
            expect(rig.echoes.isPullEcho(fileDoc._id, seq + 1)).toBe(false);
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
        it("probes unpushed for file tombstones and applies the deletion durably (#del-1)", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const probed: string[] = [];
            const applied: FileDoc[] = [];
            const rig = attachPullWriter({
                device: b,
                probeUnpushed: async (path) => { probed.push(path); return false; },
                applyPullWrite: async (doc) => { applied.push(doc); return { applied: true }; },
            });

            await seedLocalFileDoc(b, "deleted.md", { A: 1 });

            await rig.writer.apply(makeChangesResult(
                [{ id: makeFileId("deleted.md"), seq: "3", deleted: true }], "3",
            ));

            // Probed, then routed through the durable accepted → pending-deletion
            // path (applyPullWrite invoked with a deleted tombstone) — NOT the
            // former tx-external immediate applyRemoteDeletion.
            expect(probed).toEqual(["deleted.md"]);
            expect(applied).toHaveLength(1);
            expect(applied[0]._id).toBe(makeFileId("deleted.md"));
            expect(applied[0].deleted).toBe(true);
            // LocalDB now carries the tombstone (committed atomically with cursor).
            const stored = await b.db.get<FileDoc>(makeFileId("deleted.md"));
            expect(stored?.deleted).toBe(true);
        });

        it("skips chunk doc tombstones (never probes unpushed)", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            let probeCount = 0;
            const rig = attachPullWriter({
                device: b,
                probeUnpushed: async () => { probeCount++; return false; },
            });

            await rig.writer.apply(makeChangesResult(
                [{ id: makeChunkId("abc123"), seq: "3", deleted: true }], "3",
            ));

            expect(probeCount).toBe(0);
        });

        it("skips already-deleted local docs (never probes)", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");

            // Seed a tombstone locally.
            const tombstone: FileDoc = {
                _id: makeFileId("gone.md"),
                type: "file",
                schemaVersion: FILE_SCHEMA_VERSION,
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

            let probeCount = 0;
            const rig = attachPullWriter({
                device: b,
                probeUnpushed: async () => { probeCount++; return false; },
            });

            await rig.writer.apply(makeChangesResult(
                [{ id: makeFileId("gone.md"), seq: "3", deleted: true }], "3",
            ));

            expect(probeCount).toBe(0);
        });

        it("probe returning true → emits concurrent with a tombstone remoteDoc", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullWriter({ device: b, probeUnpushed: async () => true });

            await seedLocalFileDoc(b, "edited.md", { A: 2 });

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

        it("durable deletion survives an apply crash and recovers on drain (#del-1)", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            await seedLocalFileDoc(b, "doomed.md", { A: 1 });

            let failNext = true;
            const rig = attachPullWriter({
                device: b,
                probeUnpushed: async () => false,
                applyPullWrite: async () => {
                    if (failNext) { failNext = false; throw new Error("vault delete crashed mid-op"); }
                    return { applied: true };
                },
            });

            // First apply: the tombstone is committed (LocalDB + cursor +
            // pending-deletion in one tx) but the vault delete throws. Pre-fix
            // (tx-external apply) this would advance the cursor past a lost file.
            await rig.writer.apply(makeChangesResult(
                [{ id: makeFileId("doomed.md"), seq: "3", deleted: true }], "3",
            ));
            // The pending-deletion entry is durable → the drain re-applies it.
            await rig.writer.drainPendingApply();

            const stored = await b.db.get<FileDoc>(makeFileId("doomed.md"));
            expect(stored?.deleted).toBe(true); // no permanent loss
        });

        it("treats a probe I/O error as a conflict, not a silent deletion (#err-10)", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            await seedLocalFileDoc(b, "risky.md", { A: 1 });

            const applied: FileDoc[] = [];
            const concurrent: string[] = [];
            const rig = attachPullWriter({
                device: b,
                probeUnpushed: async () => { throw new Error("disk read failed"); },
                applyPullWrite: async (doc) => { applied.push(doc); return { applied: true }; },
            });
            rig.events.on("concurrent", ({ filePath }) => { concurrent.push(filePath); });

            await rig.writer.apply(makeChangesResult(
                [{ id: makeFileId("risky.md"), seq: "3", deleted: true }], "3",
            ));

            // Safe-side: surfaced as a conflict, NOT applied as a deletion.
            expect(concurrent).toEqual(["risky.md"]);
            expect(applied).toHaveLength(0);
        });
    });

    // ── Invariant B: pending-apply recovery ──────────────
    //
    // A file pulled while its chunk is not yet durable must NOT be
    // checkpointed-past silently: it is recorded in the pending-apply set
    // (in the same tx as the remoteSeq advance) and recovered by
    // drainPendingApply once the chunk becomes available.

    describe("Invariant B — pending-apply recovery", () => {
        const PENDING_PREFIX = "_sync/pending-apply/";

        /** Build a PullWriter whose chunk availability is flag-controlled. */
        function attachRecoverable(device: DeviceHarness, chunkId: string) {
            const events = new SyncEvents();
            const echoes = new EchoTracker();
            const checkpoints = new Checkpoints(device.db);
            const state = { chunkReady: false };
            const writer = new PullWriter({
                localDb: device.db,
                events,
                echoes,
                checkpoints,
                getConflictResolver: () => undefined,
                ensureChunks: async () => {
                    // Models remote fetch: only lands the chunk locally once
                    // it is durable on the remote.
                    if (!state.chunkReady) return;
                    await device.db.runWriteTx({
                        chunks: [{
                            _id: chunkId, type: "chunk", schemaVersion: 1,
                            content: new Uint8Array([1, 2, 3]),
                        } as unknown as CouchSyncDoc],
                    });
                },
                applyPullWrite: async (doc) => {
                    const have = await device.db.getChunks(doc.chunks);
                    if (have.length < doc.chunks.length) {
                        throw new Error(`Missing ${doc.chunks.length - have.length} chunk(s)`);
                    }
                    return { applied: true };
                },
            });
            return { writer, events, checkpoints, state };
        }

        it("records the file when its chunk is missing, advancing remoteSeq", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const chunkId = makeChunkId("deadbeefdeadbeef");
            const rig = attachRecoverable(b, chunkId);

            const fileDoc = makeRemoteFileDoc("ghost.md", { A: 1 }, { chunks: [chunkId] });
            await rig.writer.apply(makeChangesResult(
                [{ id: fileDoc._id, seq: "5", doc: fileDoc }], "5",
            ));

            // Checkpoint advanced (file is committed to LocalDB)...
            expect(await b.db.getMeta<string>("_sync/remote-seq")).toBe("5");
            // ...but the file is recorded for retry, not lost.
            const pending = await b.db.getMetaByPrefix(PENDING_PREFIX);
            expect(pending.map((p) => p.key)).toEqual([PENDING_PREFIX + fileDoc._id]);
        });

        it("drainPendingApply recovers the file once the chunk is durable, then empties the set", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const chunkId = makeChunkId("cafef00dcafef00d");
            const rig = attachRecoverable(b, chunkId);

            const fileDoc = makeRemoteFileDoc("late.md", { A: 1 }, { chunks: [chunkId] });
            await rig.writer.apply(makeChangesResult(
                [{ id: fileDoc._id, seq: "5", doc: fileDoc }], "5",
            ));
            expect((await b.db.getMetaByPrefix(PENDING_PREFIX)).length).toBe(1);

            // Drain while the chunk is still missing → stays pending, bumps attempt.
            await rig.writer.drainPendingApply();
            const stillPending = await b.db.getMetaByPrefix<{ attempts: number }>(PENDING_PREFIX);
            expect(stillPending.length).toBe(1);
            expect(stillPending[0].value.attempts).toBe(1);

            // Chunk becomes durable → next drain applies the file and clears it.
            const recovered: string[] = [];
            rig.events.on("auto-resolve", ({ filePath }) => recovered.push(filePath));
            rig.state.chunkReady = true;
            await rig.writer.drainPendingApply();

            expect(await b.db.getMetaByPrefix(PENDING_PREFIX)).toEqual([]);
            expect(recovered).toContain("late.md");
        });

        it("drops a pending entry whose file no longer exists locally", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const chunkId = makeChunkId("0badf00d0badf00d");
            const rig = attachRecoverable(b, chunkId);

            const fileDoc = makeRemoteFileDoc("vanish.md", { A: 1 }, { chunks: [chunkId] });
            await rig.writer.apply(makeChangesResult(
                [{ id: fileDoc._id, seq: "5", doc: fileDoc }], "5",
            ));
            // Remove the file doc from LocalDB (e.g. superseded by a delete).
            await b.db.runWriteTx({ deletes: [fileDoc._id] });

            await rig.writer.drainPendingApply();
            expect(await b.db.getMetaByPrefix(PENDING_PREFIX)).toEqual([]);
        });
    });

    // ── #3: deletion-conflict durability ─────────────────
    describe("pending-conflict (remote-delete vs local-edit durability)", () => {
        it("persists a soft-delete-vs-edit conflict in the cursor-advance tx and re-presents it after a restart", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullWriter({ device: b, withResolver: true });

            // Local has an unpushed edit (chunks + a device-local vclock).
            const localEdit = await seedLocalFileDoc(
                b, "notes/contended.md", { "dev-B": 1 }, [makeChunkId("aaaa1111aaaa1111")],
            );
            // Remote pushed a SOFT deletion with a concurrent vclock.
            const remoteDelete = makeRemoteFileDoc(
                "notes/contended.md", { "dev-A": 1 }, { deleted: true, chunks: [] },
            );

            const liveEmits: string[] = [];
            rig.events.on("concurrent", ({ filePath }) => liveEmits.push(filePath));

            const applied = await rig.writer.apply(makeChangesResult(
                [{ id: remoteDelete._id, seq: "7", doc: remoteDelete }], "7",
            ));

            // No accepted docs (the deletion is a conflict, not applied), so the
            // pipeline advances the cursor on the empty path — and MUST carry the
            // conflict id so it persists in the same tx.
            expect(applied.empty).toBe(true);
            expect(applied.pendingConflictAdd).toContainEqual({
                id: localEdit._id, kind: "pull-delete-vs-edit",
            });
            await rig.checkpoints.saveEmptyPullBatch(
                applied.nextRemoteSeq, applied.pendingConflictAdd,
            );

            // Durable record present; surfaced once live.
            const persisted = await loadAllPendingConflict(b.db);
            expect(persisted.map((r) => r.id)).toContain(localEdit._id);
            expect(liveEmits).toEqual(["notes/contended.md"]);

            // Restart: a FRESH PullWriter (empty emittedConflicts) re-presents the
            // parked conflict on its first drain — the deletion intent is NOT lost.
            const rig2 = attachPullWriter({ device: b, withResolver: true });
            const reEmits: string[] = [];
            rig2.events.on("concurrent", ({ filePath }) => reEmits.push(filePath));
            await rig2.writer.drainPendingConflict();
            expect(reEmits).toEqual(["notes/contended.md"]);

            // Resolving the conflict clears the record → no further re-presentation.
            await clearPendingConflict(b.db, localEdit._id);
            const rig3 = attachPullWriter({ device: b, withResolver: true });
            const afterResolve: string[] = [];
            rig3.events.on("concurrent", ({ filePath }) => afterResolve.push(filePath));
            await rig3.writer.drainPendingConflict();
            expect(afterResolve).toEqual([]);
            expect(await loadAllPendingConflict(b.db)).toEqual([]);
        });

        it("drains a stale conflict whose local edit no longer exists", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullWriter({ device: b, withResolver: true });

            const localEdit = await seedLocalFileDoc(
                b, "notes/gone.md", { "dev-B": 1 }, [makeChunkId("bbbb2222bbbb2222")],
            );
            const remoteDelete = makeRemoteFileDoc(
                "notes/gone.md", { "dev-A": 1 }, { deleted: true, chunks: [] },
            );
            const applied = await rig.writer.apply(makeChangesResult(
                [{ id: remoteDelete._id, seq: "9", doc: remoteDelete }], "9",
            ));
            await rig.checkpoints.saveEmptyPullBatch(
                applied.nextRemoteSeq, applied.pendingConflictAdd,
            );

            // The local edit vanishes (e.g. the user accepted the deletion).
            await b.db.runWriteTx({ deletes: [localEdit._id] });

            const rig2 = attachPullWriter({ device: b, withResolver: true });
            const reEmits: string[] = [];
            rig2.events.on("concurrent", ({ filePath }) => reEmits.push(filePath));
            await rig2.writer.drainPendingConflict();

            expect(reEmits).toEqual([]); // moot — not re-presented
            expect(await loadAllPendingConflict(b.db)).toEqual([]); // and cleared
        });
    });

    // ── edit-vs-edit durability (defer / × = 保留) ────────
    // Both sides are concurrent ALIVE edits. Pre-defer this was NOT persisted
    // (keep-local kept the remote rev retrievable). With defer the cursor
    // advances past the remote rev without accepting it, so the conflict must
    // be durable and re-fetch the remote doc on drain (2026-06-02 incident).
    describe("pending-conflict edit-vs-edit (defer durability)", () => {
        it("persists an edit-vs-edit conflict and re-presents the remote edit after a restart", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullWriter({ device: b, withResolver: true });

            // Both alive, concurrent vclocks, DIFFERENT chunks.
            const localEdit = await seedLocalFileDoc(
                b, "Periodic/DailyNotes/2026-05-31.md", { "dev-B": 1 },
                [makeChunkId("1111aaaa1111aaaa")],
            );
            const remoteEdit = makeRemoteFileDoc(
                "Periodic/DailyNotes/2026-05-31.md", { "dev-A": 1 },
                { chunks: [makeChunkId("2222bbbb2222bbbb")], size: 9 },
            );

            const liveEmits: string[] = [];
            rig.events.on("concurrent", ({ filePath }) => liveEmits.push(filePath));

            const applied = await rig.writer.apply(makeChangesResult(
                [{ id: remoteEdit._id, seq: "7", doc: remoteEdit }], "7",
            ));

            // Remote NOT accepted; conflict recorded with the edit-vs-edit kind.
            expect(applied.empty).toBe(true);
            expect(applied.pendingConflictAdd).toContainEqual({
                id: localEdit._id, kind: "edit-vs-edit",
            });
            await rig.checkpoints.saveEmptyPullBatch(
                applied.nextRemoteSeq, applied.pendingConflictAdd,
            );
            expect(liveEmits).toEqual(["Periodic/DailyNotes/2026-05-31.md"]);

            // Local doc unchanged — defer applied NOTHING.
            await expectDb(b.db).toHaveFileDoc("Periodic/DailyNotes/2026-05-31.md")
                .withVclock({ "dev-B": 1 });

            // Restart: a fresh writer re-fetches the remote edit and re-presents.
            const rig2 = attachPullWriter({
                device: b, withResolver: true,
                getRemoteDoc: async (id) => (id === remoteEdit._id ? remoteEdit : null),
            });
            const reEmits: Array<{ filePath: string; remoteDeleted: boolean }> = [];
            rig2.events.on("concurrent", ({ filePath, remoteDoc }) =>
                reEmits.push({ filePath, remoteDeleted: remoteDoc.deleted === true }));
            await rig2.writer.drainPendingConflict();
            expect(reEmits).toEqual([
                { filePath: "Periodic/DailyNotes/2026-05-31.md", remoteDeleted: false },
            ]);

            // Resolving clears the record → no further re-presentation.
            await clearPendingConflict(b.db, localEdit._id);
            const rig3 = attachPullWriter({
                device: b, withResolver: true,
                getRemoteDoc: async (id) => (id === remoteEdit._id ? remoteEdit : null),
            });
            const afterResolve: string[] = [];
            rig3.events.on("concurrent", ({ filePath }) => afterResolve.push(filePath));
            await rig3.writer.drainPendingConflict();
            expect(afterResolve).toEqual([]);
        });

        it("drops the record on drain when the divergence has since converged", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            const rig = attachPullWriter({ device: b, withResolver: true });

            const localEdit = await seedLocalFileDoc(
                b, "notes/converged.md", { "dev-B": 1 }, [makeChunkId("3333cccc3333cccc")],
            );
            const remoteEdit = makeRemoteFileDoc(
                "notes/converged.md", { "dev-A": 1 },
                { chunks: [makeChunkId("4444dddd4444dddd")], size: 9 },
            );
            const applied = await rig.writer.apply(makeChangesResult(
                [{ id: remoteEdit._id, seq: "7", doc: remoteEdit }], "7",
            ));
            await rig.checkpoints.saveEmptyPullBatch(
                applied.nextRemoteSeq, applied.pendingConflictAdd,
            );

            // On drain, the re-fetched remote now DOMINATES the local edit
            // (the author kept editing): no longer concurrent → let the normal
            // pull converge it and drop the durable record.
            const dominatingRemote = makeRemoteFileDoc(
                "notes/converged.md", { "dev-B": 1, "dev-A": 2 },
                { chunks: [makeChunkId("4444dddd4444dddd")], size: 9 },
            );
            const rig2 = attachPullWriter({
                device: b, withResolver: true,
                getRemoteDoc: async (id) => (id === remoteEdit._id ? dominatingRemote : null),
            });
            const reEmits: string[] = [];
            rig2.events.on("concurrent", ({ filePath }) => reEmits.push(filePath));
            await rig2.writer.drainPendingConflict();

            expect(reEmits).toEqual([]);
            expect(await loadAllPendingConflict(b.db)).toEqual([]);
        });
    });

    // ── #5: clean-deletion apply durability ──────────────
    // A clean remote soft-deletion (take-remote, no local edit) applies the
    // vault delete post-commit; if it throws / the process dies, the old code
    // never retried (it was excluded from pending-apply). Now it is recorded
    // as `pending-deletion` and re-applied by the drain.
    describe("pending-deletion (clean soft-delete apply durability, #5)", () => {
        it("records a failed take-remote deletion and re-applies it on the next drain", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");

            // Local file exists; a remote soft-deletion dominates it (no conflict).
            await seedLocalFileDoc(b, "notes/del.md", { A: 1 }, [makeChunkId("cccc3333cccc3333")]);
            const remoteDelete = makeRemoteFileDoc(
                "notes/del.md", { A: 2 }, { deleted: true, chunks: [] },
            );

            let throwOnApply = true;
            const appliedDocs: FileDoc[] = [];
            const rig = attachPullWriter({
                device: b, withResolver: true,
                applyPullWrite: async (doc) => {
                    appliedDocs.push(doc);
                    if (throwOnApply) throw new Error("EBUSY io.delete");
                    return { applied: true };
                },
            });

            await rig.writer.apply(makeChangesResult(
                [{ id: remoteDelete._id, seq: "5", doc: remoteDelete }], "5",
            ));

            // Take-remote ran (LocalDB doc is now the tombstone) and the failed
            // vault delete is durably recorded — NOT silently checkpointed-past.
            const pending = await loadAllPendingApply(b.db);
            expect(pending.map((r) => ({ id: r.id, reason: r.entry.reason }))).toContainEqual({
                id: remoteDelete._id, reason: "pending-deletion",
            });

            // Drain with a working writer re-applies the deletion and clears it.
            throwOnApply = false;
            appliedDocs.length = 0;
            await rig.writer.drainPendingApply();
            expect(appliedDocs.some((d) => d._id === remoteDelete._id && d.deleted === true)).toBe(true);
            expect(await loadAllPendingApply(b.db)).toEqual([]);
        });
    });

    // ── #7: reverse deletion-conflict durability ─────────
    // Mirror of #3: the local copy is a tombstone and the pulled remote is a
    // concurrent ALIVE edit. Must persist + re-present (the remote edit), not
    // drop it silently. The dominated case (remote strictly newer) must NOT
    // record a conflict — that is a legitimate resurrection.
    describe("pending-conflict reverse (local-delete vs remote-edit, #7)", () => {
        function seedLocalTombstone(b: DeviceHarness, path: string, vclock: Record<string, number>): FileDoc {
            const doc: FileDoc = {
                _id: makeFileId(path), type: "file", schemaVersion: FILE_SCHEMA_VERSION,
                chunks: [], vclock, mtime: 1, ctime: 1, size: 0, deleted: true,
            };
            return doc;
        }

        it("concurrent: persists the reverse conflict and re-presents the remote edit after restart", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");

            const tomb = seedLocalTombstone(b, "notes/rev.md", { "dev-B": 1 });
            await b.db.runWriteTx({ docs: [{ doc: tomb as unknown as CouchSyncDoc }] });
            // Remote alive edit, concurrent with the local tombstone.
            const remoteAlive = makeRemoteFileDoc(
                "notes/rev.md", { "dev-A": 1 }, { chunks: [makeChunkId("dddd4444dddd4444")], size: 5 },
            );

            const rig = attachPullWriter({ device: b, withResolver: true });
            const applied = await rig.writer.apply(makeChangesResult(
                [{ id: remoteAlive._id, seq: "3", doc: remoteAlive }], "3",
            ));

            // Reverse conflict recorded with the distinct kind; remote NOT accepted.
            expect(applied.empty).toBe(true);
            expect(applied.pendingConflictAdd).toContainEqual({
                id: remoteAlive._id, kind: "local-delete-vs-remote-edit",
            });
            await rig.checkpoints.saveEmptyPullBatch(
                applied.nextRemoteSeq, applied.pendingConflictAdd,
            );

            // Restart: a fresh writer re-presents by re-fetching the remote edit.
            const rig2 = attachPullWriter({
                device: b, withResolver: true,
                getRemoteDoc: async (id) => (id === remoteAlive._id ? remoteAlive : null),
            });
            const reEmits: Array<{ filePath: string; remoteDeleted: boolean }> = [];
            rig2.events.on("concurrent", ({ filePath, remoteDoc }) =>
                reEmits.push({ filePath, remoteDeleted: remoteDoc.deleted === true }));
            await rig2.writer.drainPendingConflict();
            // Re-presented, and the remote side shown is the ALIVE edit (not a tombstone).
            expect(reEmits).toEqual([{ filePath: "notes/rev.md", remoteDeleted: false }]);
        });

        it("dominated: does NOT record a conflict (legitimate resurrection)", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");

            const tomb = seedLocalTombstone(b, "notes/res.md", { "dev-B": 1 });
            await b.db.runWriteTx({ docs: [{ doc: tomb as unknown as CouchSyncDoc }] });
            // Remote alive edit that strictly DOMINATES the tombstone.
            const remoteAlive = makeRemoteFileDoc(
                "notes/res.md", { "dev-B": 1, "dev-A": 1 },
                { chunks: [makeChunkId("eeee5555eeee5555")], size: 4 },
            );

            const rig = attachPullWriter({ device: b, withResolver: true });
            const applied = await rig.writer.apply(makeChangesResult(
                [{ id: remoteAlive._id, seq: "4", doc: remoteAlive }], "4",
            ));

            // Take-remote → resurrected, no conflict persisted.
            expect(applied.pendingConflictAdd).toEqual([]);
            await expectDb(b.db).toHaveFileDoc("notes/res.md").withVclock({ "dev-B": 1, "dev-A": 1 });
        });
    });

    // ── tombstone chunk-fetch skip ────────────────────────
    // Tombstone fingerprints are NOT normalized (markDeleted retains the
    // deleted content's chunks — Invariant 7), but applying a deletion never
    // reads chunk bodies. Fetching them wasted bandwidth on dead content
    // that the next chunk GC dropped again (GC pins via live docs only).
    describe("tombstone chunk-fetch skip", () => {
        it("does not ensure chunks for a pulled soft-delete tombstone; live docs still fetch", async () => {
            h = createSyncHarness();
            const b = h.addDevice("dev-B");
            await seedLocalFileDoc(b, "dead.md", { A: 1 });
            await seedLocalFileDoc(b, "live.md", { A: 1 });
            // markDeleted-shape tombstone: chunks retained from the deleted content.
            const tomb = makeRemoteFileDoc("dead.md", { A: 2 }, {
                deleted: true, chunks: [makeChunkId("aaaa1111aaaa1111")], size: 4,
            });
            const edit = makeRemoteFileDoc("live.md", { A: 2 }, {
                chunks: [makeChunkId("cccc3333cccc3333")], size: 4,
            });

            const ensured: string[] = [];
            const rig = attachPullWriter({
                device: b, withResolver: true,
                ensureChunks: async (doc) => { ensured.push(doc._id); },
            });
            await rig.writer.apply(makeChangesResult([
                { id: tomb._id, seq: "1", doc: tomb },
                { id: edit._id, seq: "2", doc: edit },
            ], "2"));

            // Only the live doc fetched chunks; the tombstone applied without.
            expect(ensured).toEqual([edit._id]);
            await expectDb(b.db).toHaveFileDoc("dead.md").withVclock({ A: 2 });
        });
    });
});
