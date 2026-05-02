/**
 * PushPipeline — the live push half of the sync loop.
 *
 * Owns the periodic local-changes poll, the pull-echo filter (delegated
 * to EchoTracker), and the `bulkDocs` round-trip to the remote. Runs
 * for the lifetime of one session; the caller is responsible for
 * aborting via the `isCancelled` callback on teardown.
 *
 * Factored out of SyncEngine in v0.18.0. The one externally-visible
 * state this class owns is `deniedWarningEmitted` — a per-session latch
 * that throttles the "denied by _security" notice to at most one per
 * session, so a misconfigured peer doesn't spam the user.
 */

import type { CouchSyncDoc } from "../../types.ts";
import { isReplicatedDocId, filePathFromId } from "../../types/doc-id.ts";
import { stripRev } from "../../utils/doc.ts";
import type { LocalDB } from "../local-db.ts";
import type { ICouchClient } from "../interfaces.ts";
import { DbError } from "../write-transaction.ts";
import { logDebug, logInfo, logWarn } from "../../ui/log.ts";
import type { EchoTracker } from "./echo-tracker.ts";
import type { SyncEvents } from "./sync-events.ts";
import type { Checkpoints } from "./checkpoints.ts";
import type { VisibilityGate } from "../visibility-gate.ts";

type PushStage = "changes" | "pushDocs" | "checkpoint-save" | "idle";

const PUSH_POLL_INTERVAL_MS = 2000;

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
                    const localChanges = await this.deps.localDb.changes(
                        this.deps.checkpoints.getLastPushedSeq(),
                        { include_docs: true },
                    );

                    if (this.deps.isCancelled()) return;

                    // Filter to replicated docs, excluding pull echoes.
                    const toPush = localChanges.results.filter((r) => {
                        if (!r.doc || !isReplicatedDocId(r.id) || r.deleted) return false;
                        const rSeq = typeof r.seq === "number"
                            ? r.seq
                            : parseInt(String(r.seq), 10);
                        return !this.deps.echoes.isPullEcho(r.id, rSeq);
                    });

                    this.deps.echoes.sweepPullWritten(
                        localChanges.results.map((r) => r.id),
                    );

                    if (toPush.length > 0) {
                        const docs = toPush.map((r) => r.doc!);
                        stage = "pushDocs";
                        await this.pushDocs(docs, cycle.signal);
                        // SyncEngine subscribes to "paused" to update lastHealthyAt.
                        this.deps.events.emit("paused");
                    }

                    stage = "checkpoint-save";
                    this.deps.checkpoints.setLastPushedSeq(localChanges.last_seq);
                    await this.deps.checkpoints.save();
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
     * Push docs to remote. Fetches current remote revs and threads them
     * onto the docs before bulkDocs, same approach as remote-couch.ts.
     * Exposed for tests and potential one-shot callers.
     *
     * `signal` is the per-cycle abort scope (covers both the allDocs
     * remote-rev fetch and the bulkDocs upload). Defaults to the session
     * signal so existing test/one-shot callers without a cycle still work.
     */
    async pushDocs(docs: CouchSyncDoc[], signal: AbortSignal = this.deps.signal): Promise<void> {
        if (docs.length === 0) return;

        const prepared: Array<CouchSyncDoc & { _rev?: string }> = docs.map(
            (d) => stripRev(d) as CouchSyncDoc,
        );

        const remoteResult = await this.deps.client.allDocs<CouchSyncDoc>({
            keys: prepared.map((d) => d._id),
        }, signal);
        const remoteRevMap = new Map<string, string>();
        for (const row of remoteResult.rows) {
            if (row.value?.rev && !row.value?.deleted) {
                remoteRevMap.set(row.id, row.value.rev);
            }
        }
        for (const doc of prepared) {
            const remoteRev = remoteRevMap.get(doc._id);
            if (remoteRev) doc._rev = remoteRev;
        }

        const results = await this.deps.client.bulkDocs(prepared, signal);

        let fileCount = 0;
        let chunkCount = 0;
        let deniedCount = 0;
        let conflictCount = 0;

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
                logDebug(`  → ${path} (conflict, will resolve on next pull)`);
                conflictCount++;
            } else {
                this.deps.echoes.recordPushEcho(doc._id);
                if (isFile) {
                    logDebug(`  → ${filePathFromId(doc._id)}`);
                    fileCount++;
                } else if (isChunk) {
                    chunkCount++;
                }
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
    }
}
