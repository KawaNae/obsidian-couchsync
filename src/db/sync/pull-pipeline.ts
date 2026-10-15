/**
 * PullPipeline — the live pull half of the sync loop.
 *
 * Two entry points:
 *   - `runCatchup()` — initial drain of `_changes` in bounded batches
 *     until the feed is empty or an idle-timeout fires. Throws on hard
 *     failure so the caller can enter error state.
 *   - `runLongpoll()` — perpetual longpoll loop; survives transient
 *     errors with exponential backoff, routes hard errors through the
 *     shared ErrorRecovery, and exits cleanly on `isCancelled()`.
 *
 * Before applying a batch, the pipeline asks the vault setup to re-check
 * that the remote DB is still the one this device set up against
 * (`recheckRoot`) when the batch carries a sign that it was re-created by
 * another device's Init: a change of `vault:meta` (Init writes a new one
 * right after re-creating the DB, so the longpoll wakes on it), a body that
 * does not decrypt (the new DB's key), or a sequence that went backwards.
 * A re-created DB pauses the session before anything of it is applied.
 *
 * The pipeline is stateless w.r.t. durable data: it delegates all doc
 * writes to `PullWriter` / `Checkpoints` (which together own the atomic
 * runWriteTx boundary) and reads the feed cursor from Checkpoints. The
 * only state it owns is its own backoff and error-dedup registers,
 * both session-scoped and reset on construction.
 */

import type { CouchSyncDoc } from "../../types.ts";
import type { ICouchClient, ChangesResult } from "../interfaces.ts";
import { DbError } from "../write-transaction.ts";
import { logDebug, logInfo } from "../../ui/log.ts";
import type { PullWriter } from "./pull-writer.ts";
import type { PendingApply } from "./pending-apply.ts";
import type { SyncEvents } from "./sync-events.ts";
import type { Checkpoints } from "./checkpoints.ts";
import { classifyError } from "./errors.ts";
// Codec error from its decorator-independent home, so the sync stack does
// not compile-depend on the EncryptingCouchClient decorator.
import { EncryptionError } from "../codec-errors.ts";
import type { VisibilityGate } from "../visibility-gate.ts";
import { VAULT_META_DOC_ID, type VaultMetaDoc } from "../vault-meta.ts";

function seqNumeric(seq: number | string): number {
    if (typeof seq === "number") return seq;
    const n = parseInt(seq, 10);
    return Number.isNaN(n) ? 0 : n;
}

// Lowered from 200 in v0.20.6: 200-row `_changes?include_docs=true`
// payloads can exceed the 30s wall-clock timeout on flaky mobile
// networks (Android iPad observed in production). 100 is the safe
// floor that keeps catchup progressing even on borderline LTE.
const CATCHUP_BATCH_SIZE = 100;
const CATCHUP_IDLE_TIMEOUT_MS = 60_000;
const PULL_RETRY_MIN_MS = 2_000;
const PULL_RETRY_MAX_MS = 30_000;

export interface PullPipelineDeps {
    client: ICouchClient;
    pullWriter: PullWriter;
    /** Retried every cycle: docs committed but not yet in the vault. */
    pendingApply: PendingApply;
    checkpoints: Checkpoints;
    events: SyncEvents;
    /** Session epoch, used as `[sess#N]` prefix on diagnostic logs so
     *  concurrent sessions can be told apart during reconnect races. */
    sessionEpoch: number;
    /** Pauses the longpoll loop while the page is hidden. Catchup
     *  (one-shot, runs on openSession after a resume) does not gate. */
    visibility: VisibilityGate;

    isCancelled: () => boolean;
    /** Aborted on session dispose. Passed to every HTTP call so an
     *  in-flight longpoll / fetch terminates immediately instead of
     *  waiting for LONGPOLL_MAX_WAIT_MS or the OS-level timeout. */
    signal: AbortSignal;
    handleLocalDbError: (e: unknown, context: string) => void;
    /** Called when the longpoll loop hits an error whose class hints at a
     *  transient upstream issue (auth / 5xx). The supervisor (SyncEngine)
     *  decides whether to escalate to hard error or keep the pipeline
     *  alive with backoff. */
    onTransientError: (err: unknown) => void;
    /** Re-check that the remote DB is still the one this device set up
     *  against. `observed`: the pulled `vault:meta` (null: the change
     *  deleted it); omitted: read it from the server. Throws only the
     *  terminal pause (`encryption-paused`). */
    recheckRoot: (observed?: VaultMetaDoc | null) => Promise<void>;
    delay: (ms: number) => Promise<void>;
}

function isAbortError(e: unknown): boolean {
    return !!e && typeof e === "object" && (e as any).name === "AbortError";
}

export class PullPipeline {
    private retryMs = PULL_RETRY_MIN_MS;
    private lastErrorMsg: string | null = null;

    constructor(private deps: PullPipelineDeps) {}

    // ── Catchup ──────────────────────────────────────────

    async runCatchup(): Promise<void> {
        logDebug("catchup: starting HTTP changes pull");
        const startedAt = Date.now();

        while (true) {
            if (this.deps.isCancelled()) return;

            // Progress is the docs the writer has processed, not the batches
            // started: a batch may run for minutes while it lands docs. A
            // fetch has its own transport timeouts and a hard failure throws,
            // so what this catches is a catchup that keeps retrying (a body
            // that does not decrypt) without processing anything.
            const lastProgressAt = Math.max(
                startedAt, this.deps.pullWriter.getLastProgressAt() ?? 0,
            );
            if (Date.now() - lastProgressAt > CATCHUP_IDLE_TIMEOUT_MS) {
                logInfo("Catchup timed out (no progress for 60s)");
                throw new Error("Catchup timed out");
            }

            let result;
            try {
                result = await this.deps.client.changes<CouchSyncDoc>({
                    since: this.deps.checkpoints.getRemoteSeq(),
                    include_docs: true,
                    limit: CATCHUP_BATCH_SIZE,
                }, this.deps.signal);
            } catch (e) {
                if (isAbortError(e) || this.deps.isCancelled()) return;
                if (e instanceof EncryptionError && e.retriable) {
                    // Transient decrypt failure (e.g. another device's key
                    // material not yet pulled). Back off and let the 60s idle
                    // timeout halt catchup if it never clears, instead of
                    // tearing the whole session down. A non-retriable
                    // EncryptionError (downgrade gate) falls through to throw →
                    // classifyError → schema-mismatch → terminal. A body
                    // sealed under another key is also what a DB re-created
                    // by another device's Init looks like.
                    const paused = await this.rootPause();
                    if (paused) throw paused;
                    await this.deps.delay(this.retryMs);
                    this.retryMs = Math.min(this.retryMs * 2, PULL_RETRY_MAX_MS);
                    continue;
                }
                throw e;
            }

            if (this.deps.isCancelled()) return;

            if (result.results.length > 0) {
                const paused = await this.batchRootPause(result);
                if (paused) throw paused;
                const storedSeq = this.deps.checkpoints.getRemoteSeq();
                if (seqNumeric(result.last_seq) < seqNumeric(storedSeq)) {
                    const recreated = await this.rootPause();
                    if (recreated) throw recreated;
                    throw new Error("Remote database was recreated (seq regression)");
                }
                await this.applyBatch(result);
                logDebug(
                    `catchup: batch ${result.results.length} docs, seq=${result.last_seq}`,
                );
            } else {
                const seq = String(result.last_seq);
                logInfo(
                    `Catchup complete (seq=${seq.length > 20 ? seq.slice(0, 20) + "…" : seq})`,
                );
                try {
                    await this.deps.checkpoints.saveEmptyPullBatch(result.last_seq);
                } catch (e) {
                    this.deps.handleLocalDbError(e, "checkpoint save");
                }
                // One drain at catchup end: chunks for files pulled earlier
                // in this catchup may now all be durable.
                await this.deps.pendingApply.drain();
                // And re-present any deletion conflicts parked by a prior
                // session — this is the load-bearing restart recovery: it runs
                // even when catchup found no new changes.
                await this.deps.pullWriter.drainPendingConflict();
                return;
            }
        }
    }

    // ── Live longpoll ───────────────────────────────────

    async runLongpoll(): Promise<void> {
        const sess = this.deps.sessionEpoch;
        let exitReason: "cancelled" | "halted" = "cancelled";
        try {
            while (!this.deps.isCancelled()) {
                if (this.deps.visibility.isHidden()) {
                    await this.deps.visibility.waitVisible(this.deps.signal);
                    if (this.deps.isCancelled()) return;
                }
                // Per-cycle abort scope: aborts on session dispose OR
                // visibility:hidden. Lets us proactively cancel the
                // longpoll fetch the moment iOS backgrounds the app,
                // so the next resume sees no "Load failed" artifact
                // bumping retryMs / polluting the log.
                const cycle = this.deps.visibility.linkedAbortOnHidden(this.deps.signal);
                try {
                    const result = await this.deps.client.changesLongpoll<CouchSyncDoc>({
                        since: this.deps.checkpoints.getRemoteSeq(),
                        include_docs: true,
                    }, cycle.signal);

                    if (this.deps.isCancelled()) return;

                    if (result.results.length > 0) {
                        const paused = await this.batchRootPause(result)
                            ?? (seqNumeric(result.last_seq) < seqNumeric(this.deps.checkpoints.getRemoteSeq())
                                ? await this.rootPause()
                                : null);
                        if (paused) {
                            this.deps.onTransientError(paused);
                            exitReason = "halted";
                            return;
                        }
                        const storedSeq = this.deps.checkpoints.getRemoteSeq();
                        if (seqNumeric(result.last_seq) < seqNumeric(storedSeq)) {
                            this.deps.onTransientError(
                                new Error("Remote database was recreated (seq regression)"),
                            );
                            await this.deps.delay(this.retryMs);
                            this.retryMs = Math.min(this.retryMs * 2, PULL_RETRY_MAX_MS);
                            continue;
                        }
                        this.retryMs = PULL_RETRY_MIN_MS;
                        this.lastErrorMsg = null;
                        await this.applyBatch(result);
                        if (this.deps.isCancelled()) return;
                        // State machine is SyncEngine's concern; pipeline just
                        // signals that a batch was applied. SyncEngine subscribes
                        // to "paused" to update lastHealthyAt.
                        this.deps.events.emit("paused");
                    } else {
                        // Empty result (longpoll max-wait): stay connected.
                        // Drain any pending-apply ghosts — their chunks may
                        // have become durable since the last attempt, and a
                        // chunk landing never wakes this loop on its own
                        // (chunks don't flow through _changes). Cheap no-op
                        // when the set is empty.
                        await this.deps.pendingApply.drain();
                        await this.deps.pullWriter.drainPendingConflict();
                    }
                } catch (e: any) {
                    // halt-class DbError (degraded / quota) must surface
                    // even when dispose() raced ahead — see push-pipeline
                    // for the same rationale (iOS WebKit IDB poisoning).
                    if (e instanceof DbError && e.recovery === "halt") {
                        this.deps.handleLocalDbError(e, "pull write");
                        exitReason = "halted";
                        return;
                    }
                    if (this.deps.isCancelled()) return;
                    // Visibility-induced abort: session is healthy but the
                    // cycle signal fired due to hidden transition. Loop
                    // back to top — waitVisible will block until resume.
                    // No log, no backoff bump.
                    if (isAbortError(e)) continue;
                    // Fallback: iOS occasionally fires visibilitychange
                    // *after* killing our in-flight fetch (so AbortError
                    // doesn't trigger), surfacing a "Load failed" while
                    // we're already hidden. Treat as suspend artifact.
                    if (this.deps.visibility.isHidden()) continue;

                    if (e instanceof DbError) {
                        this.deps.handleLocalDbError(e, "pull write");
                        await this.deps.delay(this.retryMs);
                        continue;
                    }

                    if (e instanceof EncryptionError) {
                        if (!e.retriable) {
                            // Policy/security violation (cipherVersion
                            // downgrade gate / encBody HMAC mismatch).
                            // classifyError maps it to schema-mismatch, which
                            // handleTransientError escalates to a hard error
                            // immediately — no backoff, no 10s grace. Exit the
                            // loop; the session is terminal.
                            this.deps.onTransientError(e);
                            exitReason = "halted";
                            return;
                        }
                        // Retriable decrypt failure (key not yet distributed,
                        // partial write) — transient, keep the loop alive —
                        // unless the remote DB was re-created under a new key.
                        const paused = await this.rootPause();
                        if (paused) {
                            this.deps.onTransientError(paused);
                            exitReason = "halted";
                            return;
                        }
                        this.deps.onTransientError(e);
                        await this.deps.delay(this.retryMs);
                        this.retryMs = Math.min(this.retryMs * 2, PULL_RETRY_MAX_MS);
                        continue;
                    }

                    const detail = classifyError(e);

                    if (detail.kind === "auth" || detail.kind === "server" || detail.kind === "not-found") {
                        this.deps.onTransientError(e);
                    } else {
                        // Deduplicate consecutive identical messages.
                        if (detail.message !== this.lastErrorMsg) {
                            this.lastErrorMsg = detail.message;
                            logDebug(
                                `[sess#${sess}] pullLoop: ${detail.kind} error, retrying — ${detail.message}`,
                            );
                        }
                    }

                    await this.deps.delay(this.retryMs);
                    this.retryMs = Math.min(this.retryMs * 2, PULL_RETRY_MAX_MS);
                } finally {
                    cycle.release();
                }
            }
        } finally {
            logDebug(`[sess#${sess}] pullLoop exit: reason=${exitReason}`);
        }
    }

    // ── Internal ────────────────────────────────────────

    /** The pause when `result` changes `vault:meta` and the DB it now
     *  describes is not the one this device set up against; null otherwise
     *  (a batch that does not touch the meta is not re-checked). */
    private async batchRootPause(result: ChangesResult<CouchSyncDoc>): Promise<unknown | null> {
        const row = result.results.find((r) => r.id === VAULT_META_DOC_ID);
        if (!row) return null;
        if (row.deleted) return this.rootPause(null);
        // Without the doc (never with include_docs), read it from the server.
        return this.rootPause(row.doc as unknown as VaultMetaDoc | undefined);
    }

    /** `recheckRoot`, with its pause returned instead of thrown (null: the
     *  DB is the one this device set up against, or it cannot be told now). */
    private async rootPause(observed?: VaultMetaDoc | null): Promise<unknown | null> {
        try {
            await this.deps.recheckRoot(observed);
            return null;
        } catch (e) {
            if (classifyError(e).kind === "encryption-paused") return e;
            logDebug(`[sess#${this.deps.sessionEpoch}] root re-check failed: ${classifyError(e).message}`);
            return null;
        }
    }

    private async applyBatch(result: ChangesResult<CouchSyncDoc>): Promise<void> {
        const applied = await this.deps.pullWriter.apply(result);
        // When the batch had no accepted docs, PullWriter didn't run a
        // tx — advance the checkpoint explicitly here. Otherwise
        // commitPullBatch already advanced remoteSeq inside its onCommit.
        // A delete-only batch can still carry a deletion-vs-edit conflict;
        // persist it in the SAME tx as the cursor advance.
        if (applied.empty) {
            try {
                await this.deps.checkpoints.saveEmptyPullBatch(
                    applied.nextRemoteSeq, applied.pendingConflictAdd,
                );
            } catch (e) {
                this.deps.handleLocalDbError(e, "checkpoint save");
            }
        }
        // Pull durability: retry any files checkpointed-past without a vault
        // write (chunks landed late). Short-circuits when the set is empty.
        await this.deps.pendingApply.drain();
        // Same for the deletion-conflict class: re-present any persisted
        // remote-deletion-vs-local-edit conflicts not yet shown this session
        // (e.g. parked by a prior session before a restart).
        await this.deps.pullWriter.drainPendingConflict();
    }

    // ── Introspection (tests) ───────────────────────────

    /** @internal test helper */
    getRetryMs(): number { return this.retryMs; }
    /** @internal test helper */
    getLastErrorMsg(): string | null { return this.lastErrorMsg; }
}
