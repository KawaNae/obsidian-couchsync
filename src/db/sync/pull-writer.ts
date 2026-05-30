/**
 * PullWriter — classifies + dispatches a batch of pulled docs.
 *
 * Three phases, sharp responsibilities:
 *
 *   1. `classify()` — read-only walk of the changes result. Runs the
 *      ConflictResolver vclock guard, produces the accepted / concurrent /
 *      deletion sets. No writes.
 *
 *   2. `commit()` — delegates to `Checkpoints.commitPullBatch`, which
 *      owns the atomic `runWriteTx` that lands accepted docs and the
 *      new remoteSeq together. The onCommit closure passed in here
 *      runs post-durable-write: pull-echo recording, vault writes via
 *      the injected `applyPullWrite` callback, auto-resolve events.
 *
 *   3. `dispatch()` — emit concurrent events + format the log summary.
 *      Pure post-commit bookkeeping.
 *
 * Atomicity is the load-bearing guarantee here: if the pull loop crashes
 * mid-batch, the next session must either see every doc in `accepted`
 * applied with the new seq, or none with the old seq. Never half.
 */

import type { CouchSyncDoc, FileDoc } from "../../types.ts";
import { isFileDoc, isConfigDoc, FILE_SCHEMA_VERSION, CONFIG_SCHEMA_VERSION } from "../../types.ts";
import { assertSchemaVersion } from "./schema-gate.ts";
import {
    filePathFromId, configPathFromId, isFileDocId,
} from "../../types/doc-id.ts";
import { stripRev } from "../../utils/doc.ts";
import { compareVC, mergeVC } from "../../sync/vector-clock.ts";
import type { LocalDB } from "../local-db.ts";
import type { ChangesResult } from "../interfaces.ts";
import type { ConflictResolver } from "../../conflict/conflict-resolver.ts";
import type { WriteResult } from "../../sync/vault-writer.ts";
import { logDebug, logError, logInfo } from "../../ui/log.ts";
import type { EchoTracker } from "./echo-tracker.ts";
import type { SyncEvents } from "./sync-events.ts";
import type { Checkpoints } from "./checkpoints.ts";
import { loadAllPendingApply, type PendingApplyReason } from "./pending-apply.ts";
import { loadAllPendingConflict, clearPendingConflict } from "./pending-conflict.ts";

export interface PullApplyResult {
    nextRemoteSeq: number | string;
    /** True when the batch had no accepted docs (caller may still want
     *  to advance its checkpoint outside the tx). */
    empty: boolean;
    /** File-doc ids whose remote-deletion-vs-local-edit conflict must be
     *  persisted in the same tx as the cursor advance. Only consumed by the
     *  caller on the `empty` path (saveEmptyPullBatch); when the batch had
     *  accepted docs, `commit` already persisted them in commitPullBatch. */
    pendingConflictAdd: string[];
}

export interface PullWriterDeps {
    localDb: LocalDB;
    events: SyncEvents;
    echoes: EchoTracker;
    checkpoints: Checkpoints;
    getConflictResolver: () => ConflictResolver | undefined;
    ensureChunks: (doc: FileDoc) => Promise<void>;
    /** Apply a pulled FileDoc to the vault. Called inside the post-
     *  commit closure. Returns `WriteResult`: `applied:true` means the
     *  vault now matches the doc; `applied:false` means the writer
     *  declined (e.g., IME composition divergence) and the LocalDB doc
     *  is now ahead of the vault — a divergent state that the pull-
     *  skipped → reconcile schedule path retries on the next cycle.
     *
     *  Throws are caught into `writeFailCount` so the
     *  `Pull: ... applied/skipped/failed` log reflects reality. Replaces
     *  the former `events.emitAsync("pull-write", ...)` indirection,
     *  whose try/catch swallowed errors and let `writtenCount` lie. */
    applyPullWrite: (doc: FileDoc) => Promise<WriteResult>;
}

interface BatchStats {
    writtenCount: number;
    writeFailCount: number;
    /** VaultWriter declined (`applied:false`) and the LocalDB doc was
     *  committed but vault content is stale. The pull-skipped event
     *  fires when `skipCount > 0` and triggers a reconcile so the next
     *  cycle re-attempts dbToFile. */
    skipCount: number;
    keepLocalCount: number;
    chunkCount: number;
    deletedCount: number;
    /** Docs already converged with local (vclock equal for file/config,
     *  or chunk already on disk). Counts the doc-level idempotency
     *  short-circuits that replaced the old session-scoped push-echo
     *  Map — see echo-tracker.ts for history. */
    convergedSkipCount: number;
    /** `silent-merge` verdicts — same content but vclocks drifted. The
     *  remote doc is committed with `mergeVC(local, remote)` and no
     *  concurrent event is emitted. Counts toward audit-2026-05-08
     *  MEDIUM (false-positive concurrent) reduction. */
    vclockOnlyDriftCount: number;
}

interface ConcurrentEntry {
    filePath: string;
    localDoc: CouchSyncDoc;
    remoteDoc: CouchSyncDoc;
}

/**
 * Build the synthetic tombstone that carries a remote-deletion-vs-local-edit
 * conflict to the modal.
 *
 * **Invariant 6 (vclock 派生の出所制限).** This tombstone is a flag carrier —
 * a placeholder so the orchestrator can decide between "apply deletion" and
 * "keep edit". `vclock: {}` is intentional: CouchDB `_changes` does NOT include
 * deleted-doc bodies, so we cannot reconstruct the deleting device's true
 * vclock. **Downstream code must not use this tombstone's `vclock` as an
 * `incrementVC` seed** — see `ConflictOrchestrator.applyConflictChoice` for the
 * localDoc-derived seed used on take-remote.
 */
function buildDeletionTombstone(docId: string, localDoc: FileDoc): FileDoc {
    return {
        _id: docId, type: "file", schemaVersion: FILE_SCHEMA_VERSION,
        chunks: [], mtime: localDoc.mtime, ctime: localDoc.ctime,
        size: 0, deleted: true, vclock: {},
    };
}

export class PullWriter {
    constructor(private deps: PullWriterDeps) {}

    /** In-memory count of the pending-apply set (Invariant B). -1 = not
     *  yet loaded this session; a non-negative value lets `drainPendingApply`
     *  short-circuit the common empty case without a meta scan. */
    private pendingApplyCount = -1;

    /** File-doc ids whose deletion conflict has already been surfaced (emitted
     *  to the orchestrator) during THIS session — either live in
     *  `handlePulledDeletion` or by a `drainPendingConflict` re-emit. Prevents
     *  the per-cycle drain from re-emitting a conflict whose modal is already
     *  open/queued, while still re-emitting entries persisted by a PRIOR
     *  session (the set starts empty each session). */
    private emittedConflicts = new Set<string>();

    async apply(result: ChangesResult<CouchSyncDoc>): Promise<PullApplyResult> {
        const { accepted, concurrent, stats, pendingConflictAdd } = await this.classify(result);

        if (accepted.length > 0) {
            await this.commit(accepted, result.last_seq, stats, pendingConflictAdd);
        }

        this.logSummary(stats, concurrent.length);
        this.emitConcurrent(concurrent);

        // Notify the supervisor that this batch left N files in a divergent
        // state (LocalDB ahead of vault). The supervisor schedules a
        // reconciler pass so dbToFile retries on the next cycle, instead
        // of waiting for visibility/reconnect to bring the catchup pass.
        if (stats.skipCount > 0) {
            this.deps.events.emit("pull-skipped", { count: stats.skipCount });
        }

        return {
            nextRemoteSeq: result.last_seq,
            empty: accepted.length === 0,
            pendingConflictAdd,
        };
    }

    // ── Phase 1: classify ───────────────────────────────

    private async classify(
        result: ChangesResult<CouchSyncDoc>,
    ): Promise<{
        accepted: CouchSyncDoc[];
        concurrent: ConcurrentEntry[];
        stats: BatchStats;
        pendingConflictAdd: string[];
    }> {
        const accepted: CouchSyncDoc[] = [];
        const concurrent: ConcurrentEntry[] = [];
        const pendingConflictAdd: string[] = [];
        const stats: BatchStats = {
            writtenCount: 0,
            writeFailCount: 0,
            skipCount: 0,
            keepLocalCount: 0,
            chunkCount: 0,
            deletedCount: 0,
            convergedSkipCount: 0,
            vclockOnlyDriftCount: 0,
        };
        const resolver = this.deps.getConflictResolver();

        for (const row of result.results) {
            if (row.deleted) {
                if (isFileDocId(row.id)) {
                    await this.handlePulledDeletion(row.id, concurrent, pendingConflictAdd);
                    stats.deletedCount++;
                }
                continue;
            }
            if (!row.doc) continue;
            const remoteDoc = stripRev(row.doc) as CouchSyncDoc;

            // v2 (data-layer-v2 Phase 5): chunks no longer flow through
            // `_changes`. Their bodies are tiny attachment metadata and
            // the canonical binary lives in `_attachments.c`, fetched
            // lazily via `ensureChunks` when the referencing file lands.
            // Drop the row from this batch and let `ensureChunks` pull
            // the attachment on demand. The classify counter stays for
            // observability so a session log still reports how many
            // chunk rows the feed produced.
            if (!isFileDoc(remoteDoc) && !isConfigDoc(remoteDoc)) {
                stats.chunkCount++;
                continue;
            }

            // Schema-version gate, symmetric with the config pull path
            // (schema-gate.ts). A doc whose shape this build can't read
            // would corrupt the vault on write, so abort loudly and route
            // the host to re-init rather than best-effort decoding. Throws
            // SchemaVersionMismatchError (nonRetriable) → classifyError
            // maps it to a terminal state instead of a retry storm.
            if (isFileDoc(remoteDoc)) {
                assertSchemaVersion(remoteDoc, FILE_SCHEMA_VERSION, "file");
            } else {
                assertSchemaVersion(remoteDoc, CONFIG_SCHEMA_VERSION, "config");
            }

            // vclock guard: compare with local.
            if (resolver) {
                const localDoc = await this.deps.localDb.get(remoteDoc._id);
                if (localDoc && (isFileDoc(localDoc) || isConfigDoc(localDoc))) {
                    // Data-level idempotency: identical vclocks mean the
                    // local already reflects this revision (self-push
                    // echo OR a foreign write that was previously pulled
                    // in). Skip silently before reaching the resolver so
                    // session-boundary echo loss doesn't surface as
                    // keep-local noise. Empty-vs-empty vclocks are not
                    // causally equal (tombstones, legacy docs) and must
                    // fall through to the resolver.
                    const localVC = localDoc.vclock ?? {};
                    const remoteVC = remoteDoc.vclock ?? {};
                    if (Object.keys(localVC).length > 0 &&
                        compareVC(localVC, remoteVC) === "equal") {
                        stats.convergedSkipCount++;
                        continue;
                    }
                    const verdict = await resolver.resolveOnPull(localDoc, remoteDoc);
                    const docPath = isFileDoc(remoteDoc)
                        ? filePathFromId(remoteDoc._id)
                        : configPathFromId(remoteDoc._id);
                    // **Invariant 5 (PullVerdict 完全網羅).** Every
                    // verdict must be handled explicitly. The trailing
                    // `_exhaustive: never` makes future verdict additions
                    // a compile error rather than a silent regression
                    // (this was the audit-2026-05-08 MEDIUM bug shape on
                    // the ConfigSync side, fixed in PR-C).
                    switch (verdict) {
                        case "keep-local":
                            logDebug(`  × ${docPath} (keep-local)`);
                            stats.keepLocalCount++;
                            continue;
                        case "concurrent":
                            // Ensure remote chunks are available locally so
                            // the conflict modal can display remote content.
                            if (isFileDoc(remoteDoc)) {
                                await this.deps.ensureChunks(remoteDoc);
                            }
                            // Durability for the deletion-conflict class (#3).
                            // File deletions are soft (a `deleted:true` doc, not
                            // a CouchDB tombstone), so a remote-delete-vs-local-
                            // edit conflict arrives here — NOT via the hard-delete
                            // `handlePulledDeletion` path. Persist it in the same
                            // tx as the cursor advance so a missed modal / restart
                            // cannot silently un-delete the file. Edit-vs-edit
                            // concurrency is deliberately NOT persisted: both
                            // versions survive, so there is no silent loss.
                            if (isFileDoc(remoteDoc) && remoteDoc.deleted === true) {
                                pendingConflictAdd.push(remoteDoc._id);
                                this.emittedConflicts.add(remoteDoc._id);
                            }
                            logDebug(`  ⚡ ${docPath} (concurrent)`);
                            concurrent.push({
                                filePath: docPath, localDoc, remoteDoc,
                            });
                            continue;
                        case "silent-merge": {
                            // Same content, drifted vclocks. Commit remote
                            // with mergeVC so causal info from both sides
                            // is preserved. No concurrent event.
                            const merged = mergeVC(
                                localDoc.vclock ?? {},
                                remoteDoc.vclock ?? {},
                            );
                            const mergedDoc = {
                                ...remoteDoc,
                                vclock: merged,
                            } as CouchSyncDoc;
                            logDebug(`  ⊔ ${docPath} (silent-merge)`);
                            stats.vclockOnlyDriftCount++;
                            accepted.push(mergedDoc);
                            continue;
                        }
                        case "take-remote":
                            // Fall through to the accepted.push below.
                            break;
                        default: {
                            const _exhaustive: never = verdict;
                            void _exhaustive;
                            break;
                        }
                    }
                }
            }

            accepted.push(remoteDoc);
        }

        return { accepted, concurrent, stats, pendingConflictAdd };
    }

    private async handlePulledDeletion(
        docId: string,
        concurrent: ConcurrentEntry[],
        pendingConflictAdd: string[],
    ): Promise<void> {
        const path = filePathFromId(docId);
        const localDoc = await this.deps.localDb.get<FileDoc>(docId);

        if (!localDoc || !isFileDoc(localDoc) || localDoc.deleted) return;

        const hasUnpushed = await this.deps.events.emitAsyncAny("pull-delete", {
            path, localDoc,
        });
        if (hasUnpushed) {
            // Durably remember the deletion-vs-edit conflict (Invariant B): the
            // caller persists `pendingConflictAdd` in the SAME tx as the cursor
            // advance, so a missed modal / restart cannot lose the deletion.
            pendingConflictAdd.push(docId);
            // Surfaced live this session — the per-cycle drain must not re-emit
            // a modal that is already open for this doc.
            this.emittedConflicts.add(docId);
            const tombstone = buildDeletionTombstone(docId, localDoc);
            concurrent.push({ filePath: path, localDoc, remoteDoc: tombstone });
            logDebug(`  ⚡ ${path} (concurrent: remote-deleted vs local-edit)`);
        }
    }

    /**
     * Re-present persisted deletion conflicts not yet surfaced this session
     * (Invariant B recovery for the deletion-conflict class). The common case
     * is a restart: the in-memory modal queue is gone but the `pending-conflict`
     * entry survived, so the deletion intent is re-shown instead of being
     * silently un-deleted by the surviving local edit. Called every pull cycle
     * like `drainPendingApply`; `emittedConflicts` makes it a no-op for
     * conflicts already shown this session.
     */
    async drainPendingConflict(): Promise<void> {
        const rows = await loadAllPendingConflict(this.deps.localDb);
        if (rows.length === 0) return;
        for (const { id } of rows) {
            if (this.emittedConflicts.has(id)) continue;
            const localDoc = await this.deps.localDb.get<FileDoc>(id);
            if (!localDoc || !isFileDoc(localDoc) || localDoc.deleted) {
                // The local edit is gone (the deletion was applied locally, or a
                // newer rev superseded it) — the conflict is moot. Drop it.
                await clearPendingConflict(this.deps.localDb, id);
                continue;
            }
            this.emittedConflicts.add(id);
            const path = filePathFromId(id);
            const tombstone = buildDeletionTombstone(id, localDoc);
            logDebug(`  ⚡ ${path} (pending-conflict re-presented: remote-deleted vs local-edit)`);
            this.deps.events.emit("concurrent", { filePath: path, localDoc, remoteDoc: tombstone });
        }
    }

    // ── Phase 2: commit ─────────────────────────────────

    /**
     * Hand the batch to Checkpoints, which owns the atomic tx. The
     * onCommit closure here records pull echoes, applies vault writes
     * via the injected `applyPullWrite`, and emits auto-resolve — all
     * after the durable write and after `remoteSeq` has advanced in
     * memory. Vault-write throws are caught into `writeFailCount` so
     * the batch log reflects reality rather than counting unwritten
     * docs as `written`.
     */
    private async commit(
        accepted: CouchSyncDoc[],
        nextRemoteSeq: number | string,
        stats: BatchStats,
        pendingConflictAdd: string[],
    ): Promise<void> {
        // Invariant B pre-record: file docs whose chunks aren't local yet
        // might fail to apply in `onCommit` (which runs AFTER this tx
        // durably commits, so its outcome can't ride the tx). Record those
        // ids in the SAME tx as the remoteSeq advance, then drop the ones
        // that apply cleanly. What remains is exactly the genuine misses,
        // retried by `drainPendingApply`.
        const pendingApplyAdd = await this.computePendingApplyAdd(accepted);
        const pendingSet = new Set(pendingApplyAdd);
        const resolved: string[] = [];

        await this.deps.checkpoints.commitPullBatch({
            docs: accepted,
            nextRemoteSeq,
            pendingApplyAdd,
            pendingConflictAdd,
            onCommit: async () => {
                const { updateSeq } = await this.deps.localDb.info();
                const seq = typeof updateSeq === "number"
                    ? updateSeq
                    : parseInt(String(updateSeq), 10);
                this.deps.echoes.recordPullWrites(
                    accepted.map((d) => d._id), seq,
                );

                for (const doc of accepted) {
                    if (!isFileDoc(doc)) continue;
                    const path = filePathFromId(doc._id);
                    try {
                        await this.deps.ensureChunks(doc);
                        const result = await this.deps.applyPullWrite(doc);
                        if (result.applied === true) {
                            logDebug(`  ← ${path} (take-remote)`);
                            stats.writtenCount++;
                            this.deps.events.emit("auto-resolve", { filePath: path });
                        } else {
                            logDebug(`  ← ${path} (pull-skipped: ${result.reason})`);
                            stats.skipCount++;
                        }
                        // Applied or skipped (IME divergence, owned by the
                        // pull-skipped → reconcile path) — either way this
                        // is no longer a missing-chunk failure.
                        if (pendingSet.has(doc._id)) resolved.push(doc._id);
                    } catch (e: any) {
                        // Missing-chunk (or other) apply failure. The id was
                        // pre-recorded above and stays in the set for the
                        // drain to retry — no silent checkpoint-past loss.
                        logError(`pull vault write failed: ${path}: ${e?.message ?? e}`);
                        stats.writeFailCount++;
                    }
                }
            },
        });

        if (resolved.length > 0) {
            await this.deps.checkpoints.commitPendingApply({ remove: resolved });
        }
        if (this.pendingApplyCount >= 0) {
            this.pendingApplyCount += pendingApplyAdd.length - resolved.length;
        }
    }

    /** Probe which accepted file docs reference chunks not yet on disk.
     *  In live pull, chunks never arrive via `_changes` (they're fetched
     *  in `onCommit`), so this typically flags every file-with-chunks —
     *  intended: those are exactly the docs whose apply can fail. Files
     *  whose chunks are already local (vclock-only updates, re-delivery)
     *  are skipped, avoiding needless set churn. */
    private async computePendingApplyAdd(accepted: CouchSyncDoc[]): Promise<string[]> {
        const out: string[] = [];
        for (const doc of accepted) {
            if (!isFileDoc(doc) || doc.deleted) continue;
            if (!doc.chunks || doc.chunks.length === 0) continue;
            const have = await this.deps.localDb.getChunks(doc.chunks);
            if (have.length < doc.chunks.length) out.push(doc._id);
        }
        return out;
    }

    /**
     * Drain the pending-apply set (Invariant B recovery). For each id whose
     * file still exists, re-fetch its chunks and re-apply to the vault; on
     * success (or a deliberate skip) the id leaves the set, otherwise its
     * attempt count is bumped and it stays for the next cycle. Called every
     * pull cycle — including the empty-longpoll branch, since a freshly-
     * durable chunk does not flow through `_changes` to wake the loop.
     */
    async drainPendingApply(): Promise<void> {
        if (this.pendingApplyCount === 0) return;
        const rows = await loadAllPendingApply(this.deps.localDb);
        if (rows.length === 0) { this.pendingApplyCount = 0; return; }

        const remove: string[] = [];
        const reAdd: Array<{ id: string; reason: PendingApplyReason; attempts: number }> = [];
        for (const { id, entry } of rows) {
            const doc = await this.deps.localDb.get<FileDoc>(id);
            if (!doc || !isFileDoc(doc) || doc.deleted) {
                // File no longer present locally (deleted / superseded) —
                // nothing left to apply.
                remove.push(id);
                continue;
            }
            const path = filePathFromId(id);
            try {
                await this.deps.ensureChunks(doc);
                const result = await this.deps.applyPullWrite(doc);
                remove.push(id);
                if (result.applied === true) {
                    logDebug(`  ← ${path} (pending-apply recovered)`);
                    this.deps.events.emit("auto-resolve", { filePath: path });
                } else {
                    logDebug(`  ← ${path} (pending-apply skipped: ${result.reason})`);
                }
            } catch (e: any) {
                logDebug(
                    `pending-apply: ${path} still missing chunks (attempt ${entry.attempts + 1})`,
                );
                reAdd.push({ id, reason: "missing-chunks", attempts: entry.attempts + 1 });
            }
        }
        await this.deps.checkpoints.commitPendingApply({ add: reAdd, remove });
        this.pendingApplyCount = reAdd.length;
    }

    // ── Phase 3: dispatch ───────────────────────────────

    private logSummary(stats: BatchStats, concurrentCount: number): void {
        const active = stats.writtenCount > 0
            || stats.keepLocalCount > 0
            || concurrentCount > 0
            || stats.writeFailCount > 0
            || stats.skipCount > 0
            || stats.deletedCount > 0
            || stats.convergedSkipCount > 0
            || stats.vclockOnlyDriftCount > 0;
        if (!active) return;

        const parts: string[] = [];
        if (stats.writtenCount > 0) parts.push(`${stats.writtenCount} written`);
        if (stats.skipCount > 0) parts.push(`${stats.skipCount} skipped (will retry)`);
        if (stats.deletedCount > 0) parts.push(`${stats.deletedCount} deleted`);
        if (stats.keepLocalCount > 0) parts.push(`${stats.keepLocalCount} keep-local`);
        if (stats.convergedSkipCount > 0) parts.push(`${stats.convergedSkipCount} converged`);
        if (stats.vclockOnlyDriftCount > 0) parts.push(`${stats.vclockOnlyDriftCount} silent-merge`);
        if (concurrentCount > 0) parts.push(`${concurrentCount} concurrent`);
        if (stats.writeFailCount > 0) parts.push(`${stats.writeFailCount} failed`);
        if (stats.chunkCount > 0) parts.push(`${stats.chunkCount} chunks`);
        logInfo(`Pull: ${parts.join(", ")}`);
    }

    private emitConcurrent(concurrent: ConcurrentEntry[]): void {
        for (const c of concurrent) {
            this.deps.events.emit("concurrent", c);
        }
    }
}
