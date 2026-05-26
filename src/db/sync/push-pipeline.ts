/**
 * PushPipeline — the live push half of the sync loop.
 *
 * Owns the periodic local-changes poll, the pull-echo filter (delegated
 * to EchoTracker), and the `bulkDocs` round-trip to the remote. Runs
 * for the lifetime of one session; the caller is responsible for
 * aborting via the `isCancelled` callback on teardown.
 *
 * ## Conflict-aware redesign (2026-05)
 *
 * Pre-2026-05 the loop committed `lastPushedSeq` unconditionally after
 * `bulkDocs`, which silently dropped any id whose result was `conflict`
 * (audit-2026-05-08, HIGH). The new flow keeps the cursor monotonic but
 * routes uncomitted ids into a persistent `_sync/unpushed/<id>` set
 * (see unpushed-ids.ts) so they are retried on the next cycle. Cursor
 * advance and set mutation commit together via
 * `Checkpoints.commitPushCycle`.
 *
 * Two extra moves layer on top:
 *
 *   1. `classifyFiles()` runs an `allDocs include_docs:true` for file
 *      ids before bulkDocs and uses `compareVC` to spot divergence
 *      (concurrent / dominated). Divergent files are routed to the
 *      ConflictOrchestrator via `events.emit("concurrent", …, source:"push")`
 *      — same channel pull-writer uses — instead of being pushed and
 *      letting the inevitable conflict surface as silent loss.
 *
 *   2. `attempts` on each unpushed entry counts cycles where the id
 *      stayed in race-stale state. After 3 attempts we re-flag it as
 *      `divergent` so the next cycle's pre-classify treats it like a
 *      true conflict and emits to the orchestrator. Without this
 *      escalation a persistent rev-stale hot-spot (race that keeps
 *      losing) would loop forever without surfacing.
 *
 * Chunks (`chunk:*`) are content-addressed — a `conflict` result there
 * means the same content already lives on remote, so we ignore it and
 * never enter the unpushed-set. The orphan-chunk side effect (file
 * conflict → chunk lands ahead) is harmless: the file's next push
 * cycle re-batches the chunk via the file's `chunks[]` reference.
 */

import type { CouchSyncDoc, FileDoc } from "../../types.ts";
import { isFileDoc } from "../../types.ts";
import {
    isReplicatedDocId, isFileDocId, isChunkDocId, filePathFromId,
} from "../../types/doc-id.ts";
import { stripRev } from "../../utils/doc.ts";
import { compareVC, type VectorClock } from "../../sync/vector-clock.ts";
import type { LocalDB } from "../local-db.ts";
import type { ICouchClient } from "../interfaces.ts";
import { DbError } from "../write-transaction.ts";
import { EncryptionError } from "../encrypting-couch-client.ts";
import { classifyError } from "./errors.ts";
import { logDebug, logInfo, logWarn } from "../../ui/log.ts";
import type { EchoTracker } from "./echo-tracker.ts";
import type { SyncEvents } from "./sync-events.ts";
import type { Checkpoints } from "./checkpoints.ts";
import type { VisibilityGate } from "../visibility-gate.ts";
import {
    loadAllUnpushed,
    type UnpushedReason,
} from "./unpushed-ids.ts";

type PushStage = "changes" | "pushDocs" | "checkpoint-save" | "idle";

const PUSH_POLL_INTERVAL_MS = 2000;

/** After this many consecutive race-stale cycles we re-classify the
 *  entry as divergent so the orchestrator gets a shot at it. The
 *  retry-budget exists to bound the silent-retry window — without it a
 *  doc whose conflict never resolves on its own would loop forever. */
const RACE_STALE_ESCALATION_THRESHOLD = 3;

export interface PushDocsResult {
    /** Doc ids that bulkDocs accepted (`ok: true`). */
    pushed: string[];
    /** Doc ids that bulkDocs returned `conflict` for. The caller decides
     *  what to do with them — `run()` adds them to the unpushed-set;
     *  external callers (tests / one-shot pushes) typically ignore. */
    conflicts: string[];
    /** Number of denied (`forbidden`) results in the batch. */
    denied: number;
}

interface ClassifiedFile {
    /** Local doc to push (rev stripped, ready for `_rev` attach). */
    doc: FileDoc;
    /** Remote rev, or undefined if absent on remote. */
    remoteRev?: string;
    /** Previous attempts count (carried from unpushed-set), 0 if new. */
    prevAttempts: number;
}

interface DivergentFile {
    filePath: string;
    localDoc: FileDoc;
    remoteDoc: FileDoc;
    relation: "concurrent" | "dominated";
    prevAttempts: number;
}

interface FileClassifyResult {
    proceed: ClassifiedFile[];
    divergent: DivergentFile[];
    /** Ids whose local already matches remote (vclock equal) — drop from
     *  unpushed-set if they were previously flagged. */
    skippedEqual: string[];
}

export interface PushPipelineDeps {
    localDb: LocalDB;
    client: ICouchClient;
    echoes: EchoTracker;
    events: SyncEvents;
    checkpoints: Checkpoints;
    /** Session epoch; prefixed onto diagnostic logs. */
    sessionEpoch: number;
    /** Pauses the loop while the page is hidden. iOS Safari aborts
     *  in-flight IndexedDB transactions on visibilitychange→hidden;
     *  starting a new tx during that window guarantees a dead handle. */
    visibility: VisibilityGate;

    /** Session cancellation flag — pipeline exits its loop when true. */
    isCancelled: () => boolean;
    /** Aborted on session dispose. Threaded through every HTTP call so
     *  an in-flight bulkDocs / allDocs terminates immediately on
     *  teardown rather than consuming its 30s request timeout. */
    signal: AbortSignal;
    handleLocalDbError: (e: unknown, context: string) => void;
    onTransientError: (err: unknown) => void;
    delay: (ms: number) => Promise<void>;
}

function isAbortError(e: unknown): boolean {
    return !!e && typeof e === "object" && (e as any).name === "AbortError";
}

export class PushPipeline {
    /** Latch so we emit at most one warning per `denied` storm. */
    private deniedWarningEmitted = false;
    /** Latch so we capture full stack for the first unexpected push error
     *  in a session. Repeated occurrences log only the message. */
    private stackCaptured = false;

    constructor(private deps: PushPipelineDeps) {}

    /**
     * One-pass classify of the unpushed-set on session open. Drops ids
     * that have converged with remote since the last session (e.g., a
     * peer landed our local rev, or pull integrated remote so vclocks
     * are now equal). Divergent entries stay — the live loop will route
     * them to ConflictOrchestrator on its next cycle.
     *
     * Best-effort: any error (remote unreachable, AbortError on dispose)
     * leaves the set untouched. The live loop will revisit the entries
     * naturally, so a dropped warmup just means the bookkeeping happens
     * a few seconds later.
     */
    async warmup(): Promise<void> {
        if (this.deps.isCancelled()) return;
        const rows = await loadAllUnpushed(this.deps.localDb);
        if (rows.length === 0) return;

        const fileDocs: FileDoc[] = [];
        const prevAttempts = new Map<string, number>();
        const zombieRemove: string[] = [];

        for (const row of rows) {
            prevAttempts.set(row.id, row.entry.attempts);
            if (!isFileDocId(row.id)) {
                // Only file: ids should ever land in the set; anything
                // else is leakage from an older format or a bug.
                zombieRemove.push(row.id);
                continue;
            }
            const doc = await this.deps.localDb.get(row.id);
            if (!doc || !isFileDoc(doc)) {
                zombieRemove.push(row.id);
                continue;
            }
            fileDocs.push(doc as FileDoc);
        }

        let classified: FileClassifyResult;
        try {
            classified = await this.classifyFiles(
                fileDocs, prevAttempts, this.deps.signal,
            );
        } catch (e: any) {
            if (isAbortError(e)) return;
            // Remote unreachable / classify failure: leave set untouched
            // and let the live loop retry naturally.
            logWarn(`pushPipeline.warmup classify failed: ${e?.message ?? e}`);
            // Still drop zombies — those are local-only judgments and
            // do not depend on remote state.
            if (zombieRemove.length === 0) return;
            await this.deps.checkpoints.commitPushCycle({
                nextPushSeq: this.deps.checkpoints.getLastPushedSeq(),
                unpushedAdd: [],
                unpushedRemove: zombieRemove,
            });
            return;
        }

        const unpushedRemove = [...zombieRemove, ...classified.skippedEqual];
        // Divergent (concurrent / dominated) entries STAY: the live loop
        // will route them to the orchestrator on the next cycle. We
        // could emit("concurrent") here to surface them at startup, but
        // doing so would mean session-open becomes a modal-popping moment
        // which is poor UX during catchup churn; let the live loop do it
        // when the user is past startup.
        if (unpushedRemove.length === 0) return;

        await this.deps.checkpoints.commitPushCycle({
            nextPushSeq: this.deps.checkpoints.getLastPushedSeq(),
            unpushedAdd: [],
            unpushedRemove,
        });
        logInfo(`Push warmup: dropped ${unpushedRemove.length} converged unpushed ids`);
    }

    async run(): Promise<void> {
        const sess = this.deps.sessionEpoch;
        let exitReason: "cancelled" | "halted" = "cancelled";
        try {
            while (!this.deps.isCancelled()) {
                if (this.deps.visibility.isHidden()) {
                    await this.deps.visibility.waitVisible(this.deps.signal);
                    if (this.deps.isCancelled()) return;
                }
                let stage: PushStage = "idle";
                // Per-cycle abort scope: aborts on session dispose OR
                // visibility:hidden. Threaded into pushDocs() so the
                // remote-rev allDocs + bulkDocs round-trips are cancelled
                // together when the page goes background.
                const cycle = this.deps.visibility.linkedAbortOnHidden(this.deps.signal);
                try {
                    stage = "changes";
                    await this.runOnce(cycle.signal, () => { stage = "pushDocs"; });
                } catch (e: any) {
                    // halt-class DbError (degraded / quota) must surface
                    // even when dispose() raced ahead of us — otherwise
                    // SyncEngine.handleDegraded never latches and the
                    // next session's openSession→ensureHealthy regenerates
                    // the same error into an infinite retry-backoff loop
                    // (iOS WebKit IDB poisoning case).
                    if (e instanceof DbError && e.recovery === "halt") {
                        this.deps.handleLocalDbError(e, `push loop [stage:${stage}]`);
                        exitReason = "halted";
                        return;
                    }
                    if (this.deps.isCancelled()) return;
                    // Visibility-induced abort: AbortError from cycle.signal
                    // (proactive cancel on hidden) OR a "Load failed" that
                    // landed while visibility is now hidden (iOS late-fired
                    // the visibilitychange after rip-killing fetch).
                    // Either way: not a real error. Skip log + backoff and
                    // loop back to top — waitVisible will block until resume.
                    if (isAbortError(e) || this.deps.visibility.isHidden()) continue;
                    if (e instanceof EncryptionError) {
                        this.deps.onTransientError(e);
                        continue;
                    }
                    {
                        const detail = classifyError(e);
                        if (detail.kind === "not-found") {
                            this.deps.onTransientError(e);
                            continue;
                        }
                    }
                    if (e instanceof DbError) {
                        this.deps.handleLocalDbError(e, `push loop [stage:${stage}]`);
                    } else {
                        // Push errors are logged but don't escalate — the next
                        // cycle will retry. First error in session also logs
                        // the stack so the call site is visible post-hoc.
                        logDebug(`[sess#${sess}] push error [stage:${stage}]: ${e?.message ?? e}`);
                        if (!this.stackCaptured && e instanceof Error && e.stack) {
                            this.stackCaptured = true;
                            logWarn(
                                `[sess#${sess}] push error first-in-session [stage:${stage}] name=${e.name} stack=${e.stack.split("\n").slice(0, 5).join(" | ")}`,
                            );
                        }
                    }
                } finally {
                    cycle.release();
                }

                await this.deps.delay(PUSH_POLL_INTERVAL_MS);
            }
        } finally {
            logDebug(`[sess#${sess}] pushLoop exit: reason=${exitReason}`);
        }
    }

    /**
     * One full push cycle. Extracted so `run()` reads as a thin loop
     * around try/catch error routing while the meaty logic — union
     * enumeration, classify, push, atomic commit — lives here in linear
     * order.
     *
     * `markStage` lets the caller's stage tracker advance from "changes"
     * to "pushDocs" right before the bulk round-trip, so an error log
     * pinpoints which phase blew up.
     */
    private async runOnce(
        signal: AbortSignal,
        markStage: () => void,
    ): Promise<void> {
        // [1] Local changes since the cursor.
        const localChanges = await this.deps.localDb.changes(
            this.deps.checkpoints.getLastPushedSeq(),
            { include_docs: true },
        );
        if (this.deps.isCancelled()) return;

        // [2] Filter changes feed to replicated docs, excluding pull echoes.
        const fromChanges: { id: string; doc: CouchSyncDoc }[] = [];
        for (const r of localChanges.results) {
            if (!r.doc || !isReplicatedDocId(r.id) || r.deleted) continue;
            const rSeq = typeof r.seq === "number"
                ? r.seq
                : parseInt(String(r.seq), 10);
            if (this.deps.echoes.isPullEcho(r.id, rSeq)) continue;
            fromChanges.push({ id: r.id, doc: r.doc });
        }
        this.deps.echoes.sweepPullWritten(
            localChanges.results.map((r) => r.id),
        );

        // [3] Union with the unpushed-set: any id we couldn't push in
        //     prior cycles must be re-classified even if it didn't
        //     re-appear in the changes feed.
        const unpushedRows = await loadAllUnpushed(this.deps.localDb);
        const seenIds = new Set<string>(fromChanges.map((c) => c.id));
        const prevAttempts = new Map<string, number>();
        const candidates: { id: string; doc: CouchSyncDoc }[] = [...fromChanges];
        const zombieRemove: string[] = [];
        const stickyDivergent: { id: string; reason: UnpushedReason }[] = [];

        for (const row of unpushedRows) {
            prevAttempts.set(row.id, row.entry.attempts);
            // Once an id has been escalated to "divergent" we keep it in
            // the set even when it disappears from the changes feed — pull
            // resolution is what removes it, not push retry.
            stickyDivergent.push({ id: row.id, reason: row.entry.reason });
            if (seenIds.has(row.id)) continue;
            const doc = await this.deps.localDb.get(row.id);
            if (!doc) {
                // Zombie: doc deleted locally. Remove from set.
                zombieRemove.push(row.id);
                continue;
            }
            if (!isReplicatedDocId(row.id)) {
                zombieRemove.push(row.id);
                continue;
            }
            seenIds.add(row.id);
            candidates.push({ id: row.id, doc });
        }

        // [4] Split by kind. Chunks bypass vclock pre-classify (content-
        //     addressed); files go through it.
        const fileCandidates: FileDoc[] = [];
        const chunkCandidates: CouchSyncDoc[] = [];
        for (const c of candidates) {
            if (isFileDocId(c.id) && isFileDoc(c.doc)) {
                fileCandidates.push(c.doc as FileDoc);
            } else if (isChunkDocId(c.id)) {
                chunkCandidates.push(c.doc);
            }
            // Other replicated kinds (config:* in vault scope = none) drop
            // here. ConfigSync owns its own pipeline.
        }

        // [5] vclock pre-classify file docs against remote.
        const classified = await this.classifyFiles(
            fileCandidates,
            prevAttempts,
            signal,
        );
        if (this.deps.isCancelled()) return;

        // [6] Race-stale escalation: any pre-existing race-stale entry
        //     that's been retrying past the threshold gets re-routed
        //     into divergent for the orchestrator.
        const escalated: DivergentFile[] = [];
        for (let i = classified.proceed.length - 1; i >= 0; i--) {
            const p = classified.proceed[i];
            const sticky = stickyDivergent.find((s) => s.id === p.doc._id);
            if (
                sticky?.reason === "race-stale"
                && p.prevAttempts >= RACE_STALE_ESCALATION_THRESHOLD
            ) {
                // Demote to divergent; we don't have remoteDoc here (the
                // pre-classify said dominates/absent), so we can't emit
                // concurrent — just keep in set as divergent so the next
                // cycle's pre-classify catches the actual remote state.
                classified.proceed.splice(i, 1);
                classified.divergent.push({
                    filePath: filePathFromId(p.doc._id),
                    localDoc: p.doc,
                    // remoteDoc absent — we'll surface on next cycle when
                    // remote state is freshly fetched.
                    remoteDoc: p.doc,
                    relation: "concurrent",
                    prevAttempts: p.prevAttempts,
                });
                void escalated; // (placeholder; stats only)
            }
        }

        // [7] Emit divergent + accumulate set updates.
        const unpushedAdd: Array<{ id: string; reason: UnpushedReason; attempts: number }> = [];
        const unpushedRemove: string[] = [...zombieRemove, ...classified.skippedEqual];
        for (const div of classified.divergent) {
            unpushedAdd.push({
                id: div.localDoc._id,
                reason: "divergent",
                attempts: div.prevAttempts + 1,
            });
            this.deps.events.emit("concurrent", {
                filePath: div.filePath,
                localDoc: div.localDoc,
                remoteDoc: div.remoteDoc,
                source: "push",
            });
        }

        // [8] Bulk push: chunks first, then classified-proceed files.
        //     Chunks must precede files in the bulkDocs array so they
        //     receive lower update_seq values on the remote. This ensures
        //     a pull-side _changes reader always sees chunks committed
        //     before the file doc that references them.
        const toBulk: Array<CouchSyncDoc & { _rev?: string }> = [];
        for (const c of chunkCandidates) {
            toBulk.push(stripRev(c) as CouchSyncDoc & { _rev?: string });
        }
        for (const p of classified.proceed) {
            const stripped = stripRev(p.doc) as CouchSyncDoc & { _rev?: string };
            if (p.remoteRev) stripped._rev = p.remoteRev;
            toBulk.push(stripped);
        }

        let pushResult: PushDocsResult = { pushed: [], conflicts: [], denied: 0 };
        if (toBulk.length > 0) {
            markStage();
            pushResult = await this.pushDocs(toBulk, signal);
            this.deps.events.emit("paused");
        }

        // [9] Translate push results → unpushed-set updates.
        for (const id of pushResult.pushed) {
            unpushedRemove.push(id);
        }
        for (const id of pushResult.conflicts) {
            if (!isFileDocId(id)) continue; // chunk conflicts are benign
            const next = (prevAttempts.get(id) ?? 0) + 1;
            unpushedAdd.push({ id, reason: "race-stale", attempts: next });
        }

        // [10] Atomic commit: cursor + set in one tx. Cursor is monotonic;
        //      missed ids live on in the set.
        await this.deps.checkpoints.commitPushCycle({
            nextPushSeq: localChanges.last_seq,
            unpushedAdd,
            unpushedRemove,
        });
    }

    /**
     * Phase between change enumeration and bulkDocs: pull current remote
     * state for the file ids we want to push and bucket them by vclock
     * relation. Mirrors ConfigPushPipeline.run() phase 3.
     */
    private async classifyFiles(
        docs: FileDoc[],
        prevAttempts: Map<string, number>,
        signal: AbortSignal,
    ): Promise<FileClassifyResult> {
        if (docs.length === 0) {
            return { proceed: [], divergent: [], skippedEqual: [] };
        }
        const ids = docs.map((d) => d._id);
        // include_docs:true is required because vclock lives in the doc
        // body. The fetch is bounded by the file delta (typically few
        // dozen docs) so this is O(delta), not O(all-files).
        const remote = await this.deps.client.allDocs<FileDoc>(
            { keys: ids, include_docs: true },
            signal,
        );
        const remoteRev = new Map<string, string>();
        const remoteVc = new Map<string, VectorClock>();
        const remoteDocMap = new Map<string, FileDoc>();
        for (const row of remote.rows) {
            if (row.value?.rev && !row.value?.deleted) {
                remoteRev.set(row.id, row.value.rev);
            }
            if (row.doc) {
                remoteDocMap.set(row.id, row.doc as FileDoc);
                const vc = (row.doc as FileDoc).vclock;
                if (vc) remoteVc.set(row.id, vc);
            }
        }

        const proceed: ClassifiedFile[] = [];
        const divergent: DivergentFile[] = [];
        const skippedEqual: string[] = [];

        for (const doc of docs) {
            const prev = prevAttempts.get(doc._id) ?? 0;
            const rVc = remoteVc.get(doc._id);
            if (!rVc) {
                proceed.push({ doc, remoteRev: undefined, prevAttempts: prev });
                continue;
            }
            const rel = compareVC(doc.vclock ?? {}, rVc);
            if (rel === "dominates") {
                proceed.push({
                    doc,
                    remoteRev: remoteRev.get(doc._id),
                    prevAttempts: prev,
                });
                continue;
            }
            if (rel === "equal") {
                skippedEqual.push(doc._id);
                continue;
            }
            // concurrent or dominated → divergent.
            const rDoc = remoteDocMap.get(doc._id) ?? doc;
            divergent.push({
                filePath: filePathFromId(doc._id),
                localDoc: doc,
                remoteDoc: rDoc,
                relation: rel === "concurrent" ? "concurrent" : "dominated",
                prevAttempts: prev,
            });
        }

        return { proceed, divergent, skippedEqual };
    }

    /**
     * Push docs to remote. Fetches current remote revs for any docs that
     * arrive without one (chunks, or external callers that didn't pre-
     * thread) and submits via bulkDocs. Returns a per-id result summary
     * so the caller can route conflicts / pushed ids appropriately.
     *
     * Pre-threaded `_rev`s on the input are preserved — `run()` uses this
     * to avoid re-fetching file revs that `classifyFiles()` already pulled.
     *
     * `signal` is the per-cycle abort scope (covers both the allDocs
     * remote-rev fetch and the bulkDocs upload). Defaults to the session
     * signal so existing test/one-shot callers without a cycle still work.
     */
    async pushDocs(
        docs: Array<CouchSyncDoc | (CouchSyncDoc & { _rev?: string })>,
        signal: AbortSignal = this.deps.signal,
    ): Promise<PushDocsResult> {
        if (docs.length === 0) {
            return { pushed: [], conflicts: [], denied: 0 };
        }

        const prepared: Array<CouchSyncDoc & { _rev?: string }> = docs.map(
            (d) => {
                const stripped = stripRev(d) as CouchSyncDoc & { _rev?: string };
                if ((d as { _rev?: string })._rev) {
                    stripped._rev = (d as { _rev?: string })._rev;
                }
                return stripped;
            },
        );

        // Fill in _rev for any doc that didn't arrive pre-threaded.
        const needRev = prepared.filter((d) => !d._rev).map((d) => d._id);
        if (needRev.length > 0) {
            const remoteResult = await this.deps.client.allDocs<CouchSyncDoc>(
                { keys: needRev },
                signal,
            );
            const remoteRevMap = new Map<string, string>();
            for (const row of remoteResult.rows) {
                if (row.value?.rev && !row.value?.deleted) {
                    remoteRevMap.set(row.id, row.value.rev);
                }
            }
            for (const doc of prepared) {
                if (doc._rev) continue;
                const rev = remoteRevMap.get(doc._id);
                if (rev) doc._rev = rev;
            }
        }

        const results = await this.deps.client.bulkDocs(prepared, signal);

        let fileCount = 0;
        let chunkCount = 0;
        let deniedCount = 0;
        let conflictCount = 0;
        const pushed: string[] = [];
        const conflicts: string[] = [];

        for (let i = 0; i < results.length; i++) {
            const res = results[i];
            const doc = prepared[i];
            const isFile = doc._id?.startsWith("file:");
            const isChunk = doc._id?.startsWith("chunk:");

            if (res.error === "forbidden") {
                const path = isFile ? filePathFromId(doc._id) : doc._id;
                logDebug(`  → ${path} (denied: ${res.reason})`);
                deniedCount++;
                if (!this.deniedWarningEmitted) {
                    this.deniedWarningEmitted = true;
                    this.deps.events.emit("error", {
                        message:
                            "Some documents were denied — check CouchDB _security permissions.",
                    });
                }
            } else if (res.error === "conflict") {
                const path = isFile ? filePathFromId(doc._id) : doc._id;
                logDebug(`  → ${path} (conflict, will retry next push)`);
                conflictCount++;
                conflicts.push(doc._id);
            } else if (res.error) {
                logDebug(`  → ${doc._id} (${res.error}: ${res.reason ?? ""})`);
            } else {
                if (isFile) {
                    logDebug(`  → ${filePathFromId(doc._id)}`);
                    fileCount++;
                } else if (isChunk) {
                    chunkCount++;
                }
                pushed.push(doc._id);
            }
        }

        if (fileCount > 0 || deniedCount > 0 || conflictCount > 0) {
            const parts: string[] = [];
            if (fileCount > 0) parts.push(`${fileCount} files`);
            if (chunkCount > 0) parts.push(`${chunkCount} chunks`);
            if (deniedCount > 0) parts.push(`${deniedCount} denied`);
            if (conflictCount > 0) parts.push(`${conflictCount} conflicts`);
            logInfo(`Push: ${parts.join(", ")}`);
        }

        return { pushed, conflicts, denied: deniedCount };
    }
}
