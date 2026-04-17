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
 * The pipeline is stateless w.r.t. durable data: it delegates all doc
 * writes to `PullWriter` / `Checkpoints` (which together own the atomic
 * runWriteTx boundary) and reads the feed cursor from Checkpoints. The
 * only state it owns is its own backoff and error-dedup registers,
 * both session-scoped and reset on construction.
 */

import type { CouchSyncDoc } from "../../types.ts";
import type { ICouchClient, ChangesResult } from "../interfaces.ts";
import { DbError } from "../write-transaction.ts";
import type { ErrorRecovery } from "../error-recovery.ts";
import { logDebug, logInfo } from "../../ui/log.ts";
import type { PullWriter } from "./pull-writer.ts";
import type { SyncEvents } from "./sync-events.ts";
import type { Checkpoints } from "./checkpoints.ts";

const CATCHUP_BATCH_SIZE = 200;
const CATCHUP_IDLE_TIMEOUT_MS = 60_000;
const PULL_RETRY_MIN_MS = 2_000;
const PULL_RETRY_MAX_MS = 30_000;

export interface PullPipelineDeps {
    client: ICouchClient;
    pullWriter: PullWriter;
    checkpoints: Checkpoints;
    errorRecovery: ErrorRecovery;
    events: SyncEvents;

    isCancelled: () => boolean;
    handleLocalDbError: (e: unknown, context: string) => void;
    delay: (ms: number) => Promise<void>;
}

export class PullPipeline {
    private retryMs = PULL_RETRY_MIN_MS;
    private lastErrorMsg: string | null = null;

    constructor(private deps: PullPipelineDeps) {}

    // ── Catchup ──────────────────────────────────────────

    async runCatchup(): Promise<void> {
        logDebug("catchup: starting HTTP changes pull");
        let lastProgressAt = Date.now();

        while (true) {
            if (this.deps.isCancelled()) return;

            if (Date.now() - lastProgressAt > CATCHUP_IDLE_TIMEOUT_MS) {
                logInfo("Catchup timed out (no progress for 60s)");
                throw new Error("Catchup timed out");
            }

            const result = await this.deps.client.changes<CouchSyncDoc>({
                since: this.deps.checkpoints.getRemoteSeq(),
                include_docs: true,
                limit: CATCHUP_BATCH_SIZE,
            });

            if (this.deps.isCancelled()) return;

            if (result.results.length > 0) {
                lastProgressAt = Date.now();
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
                return;
            }
        }
    }

    // ── Live longpoll ───────────────────────────────────

    async runLongpoll(): Promise<void> {
        while (!this.deps.isCancelled()) {
            try {
                const result = await this.deps.client.changesLongpoll<CouchSyncDoc>({
                    since: this.deps.checkpoints.getRemoteSeq(),
                    include_docs: true,
                });

                if (this.deps.isCancelled()) return;

                if (result.results.length > 0) {
                    this.retryMs = PULL_RETRY_MIN_MS;
                    this.lastErrorMsg = null;
                    await this.applyBatch(result);
                    if (this.deps.isCancelled()) return;
                    // State machine is SyncEngine's concern; pipeline just
                    // signals that a batch was applied. SyncEngine subscribes
                    // to "paused" to update lastHealthyAt.
                    this.deps.events.emit("paused");
                }
                // Empty result (longpoll max-wait): stay connected.
            } catch (e: any) {
                if (this.deps.isCancelled()) return;

                if (e instanceof DbError) {
                    this.deps.handleLocalDbError(e, "pull write");
                    if (e.recovery === "halt") return; // teardown already invoked
                    await this.deps.delay(this.retryMs);
                    continue;
                }

                const detail = this.deps.errorRecovery.classifyError(e);

                if (detail.kind === "auth" || detail.kind === "server") {
                    this.deps.errorRecovery.handleTransientError(e);
                } else {
                    // Deduplicate consecutive identical messages.
                    if (detail.message !== this.lastErrorMsg) {
                        this.lastErrorMsg = detail.message;
                        logDebug(
                            `pullLoop: ${detail.kind} error, retrying — ${detail.message}`,
                        );
                    }
                }

                await this.deps.delay(this.retryMs);
                this.retryMs = Math.min(this.retryMs * 2, PULL_RETRY_MAX_MS);
            }
        }
    }

    // ── Internal ────────────────────────────────────────

    private async applyBatch(result: ChangesResult<CouchSyncDoc>): Promise<void> {
        const applied = await this.deps.pullWriter.apply(result);
        // When the batch had no accepted docs, PullWriter didn't run a
        // tx — advance the checkpoint explicitly here. Otherwise
        // commitPullBatch already advanced remoteSeq inside its onCommit.
        if (applied.empty) {
            try {
                await this.deps.checkpoints.saveEmptyPullBatch(applied.nextRemoteSeq);
            } catch (e) {
                this.deps.handleLocalDbError(e, "checkpoint save");
            }
        }
    }

    // ── Introspection (tests) ───────────────────────────

    /** @internal test helper */
    getRetryMs(): number { return this.retryMs; }
    /** @internal test helper */
    getLastErrorMsg(): string | null { return this.lastErrorMsg; }
}
