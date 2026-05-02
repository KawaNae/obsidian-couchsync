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
 *      runs post-durable-write: echo recording, pull-write emission,
 *      vault writes, auto-resolve events.
 *
 *   3. `dispatch()` — emit concurrent events + format the log summary.
 *      Pure post-commit bookkeeping.
 *
 * Atomicity is the load-bearing guarantee here: if the pull loop crashes
 * mid-batch, the next session must either see every doc in `accepted`
 * applied with the new seq, or none with the old seq. Never half.
 */

import type { CouchSyncDoc, FileDoc } from "../../types.ts";
import { isFileDoc, isConfigDoc } from "../../types.ts";
import {
    filePathFromId, configPathFromId, isFileDocId,
} from "../../types/doc-id.ts";
import { stripRev } from "../../utils/doc.ts";
import { compareVC } from "../../sync/vector-clock.ts";
import type { LocalDB } from "../local-db.ts";
import type { ChangesResult } from "../interfaces.ts";
import type { ConflictResolver } from "../../conflict/conflict-resolver.ts";
import { logDebug, logError, logInfo } from "../../ui/log.ts";
import type { EchoTracker } from "./echo-tracker.ts";
import type { SyncEvents } from "./sync-events.ts";
import type { Checkpoints } from "./checkpoints.ts";

export interface PullApplyResult {
    nextRemoteSeq: number | string;
    /** True when the batch had no accepted docs (caller may still want
     *  to advance its checkpoint outside the tx). */
    empty: boolean;
}

export interface PullWriterDeps {
    localDb: LocalDB;
    events: SyncEvents;
    echoes: EchoTracker;
    checkpoints: Checkpoints;
    getConflictResolver: () => ConflictResolver | undefined;
    ensureChunks: (doc: FileDoc) => Promise<void>;
}

interface BatchStats {
    writtenCount: number;
    writeFailCount: number;
    keepLocalCount: number;
    chunkCount: number;
    deletedCount: number;
    /** Docs already converged with local (vclock equal for file/config,
     *  or chunk already on disk). Counts the doc-level idempotency
     *  short-circuits that replaced the old session-scoped push-echo
     *  Map — see echo-tracker.ts for history. */
    convergedSkipCount: number;
}

interface ConcurrentEntry {
    filePath: string;
    localDoc: CouchSyncDoc;
    remoteDoc: CouchSyncDoc;
}

export class PullWriter {
    constructor(private deps: PullWriterDeps) {}

    async apply(result: ChangesResult<CouchSyncDoc>): Promise<PullApplyResult> {
        const { accepted, concurrent, stats } = await this.classify(result);

        if (accepted.length > 0) {
            await this.commit(accepted, result.last_seq, stats);
        }

        this.logSummary(stats, concurrent.length);
        this.emitConcurrent(concurrent);

        return {
            nextRemoteSeq: result.last_seq,
            empty: accepted.length === 0,
        };
    }

    // ── Phase 1: classify ───────────────────────────────

    private async classify(
        result: ChangesResult<CouchSyncDoc>,
    ): Promise<{
        accepted: CouchSyncDoc[];
        concurrent: ConcurrentEntry[];
        stats: BatchStats;
    }> {
        const accepted: CouchSyncDoc[] = [];
        const concurrent: ConcurrentEntry[] = [];
        const stats: BatchStats = {
            writtenCount: 0,
            writeFailCount: 0,
            keepLocalCount: 0,
            chunkCount: 0,
            deletedCount: 0,
            convergedSkipCount: 0,
        };
        const resolver = this.deps.getConflictResolver();

        for (const row of result.results) {
            if (row.deleted) {
                if (isFileDocId(row.id)) {
                    await this.handlePulledDeletion(row.id, concurrent);
                    stats.deletedCount++;
                }
                continue;
            }
            if (!row.doc) continue;
            const remoteDoc = stripRev(row.doc) as CouchSyncDoc;

            // ChunkDocs have no vclock and are content-addressed (id =
            // hash of payload). If the chunk already exists locally, the
            // re-put is a no-op — short-circuit to avoid pointless I/O
            // when a session-boundary catchup re-delivers self-pushed
            // chunks. R1b path: the old recordPushEcho/consumePushEcho
            // pair gated this; with that gone, content-addressing is
            // the durable check.
            if (!isFileDoc(remoteDoc) && !isConfigDoc(remoteDoc)) {
                const existing = await this.deps.localDb.get(remoteDoc._id);
                if (existing) {
                    stats.convergedSkipCount++;
                    continue;
                }
                accepted.push(remoteDoc);
                stats.chunkCount++;
                continue;
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
                    if (verdict === "keep-local") {
                        const path = isFileDoc(remoteDoc)
                            ? filePathFromId(remoteDoc._id)
                            : configPathFromId(remoteDoc._id);
                        logDebug(`  × ${path} (keep-local)`);
                        stats.keepLocalCount++;
                        continue;
                    }
                    if (verdict === "concurrent") {
                        const filePath = isFileDoc(remoteDoc)
                            ? filePathFromId(remoteDoc._id)
                            : configPathFromId(remoteDoc._id);
                        // Ensure remote chunks are available locally so the
                        // conflict modal can display remote content.
                        if (isFileDoc(remoteDoc)) {
                            await this.deps.ensureChunks(remoteDoc);
                        }
                        logDebug(`  ⚡ ${filePath} (concurrent)`);
                        concurrent.push({ filePath, localDoc, remoteDoc });
                        continue;
                    }
                    // "take-remote" falls through.
                }
            }

            accepted.push(remoteDoc);
        }

        return { accepted, concurrent, stats };
    }

    private async handlePulledDeletion(
        docId: string,
        concurrent: ConcurrentEntry[],
    ): Promise<void> {
        const path = filePathFromId(docId);
        const localDoc = await this.deps.localDb.get<FileDoc>(docId);

        if (!localDoc || !isFileDoc(localDoc) || localDoc.deleted) return;

        const hasUnpushed = await this.deps.events.emitAsyncAny("pull-delete", {
            path, localDoc,
        });
        if (hasUnpushed) {
            const tombstone: FileDoc = {
                _id: docId, type: "file", chunks: [],
                mtime: localDoc.mtime, ctime: localDoc.ctime,
                size: 0, deleted: true, vclock: {},
            };
            concurrent.push({ filePath: path, localDoc, remoteDoc: tombstone });
            logDebug(`  ⚡ ${path} (concurrent: remote-deleted vs local-edit)`);
        }
    }

    // ── Phase 2: commit ─────────────────────────────────

    /**
     * Hand the batch to Checkpoints, which owns the atomic tx. The
     * onCommit closure here records echoes, fires pull-write, and emits
     * auto-resolve — all after the durable write and after `remoteSeq`
     * has advanced in memory.
     */
    private async commit(
        accepted: CouchSyncDoc[],
        nextRemoteSeq: number | string,
        stats: BatchStats,
    ): Promise<void> {
        await this.deps.checkpoints.commitPullBatch({
            docs: accepted,
            nextRemoteSeq,
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
                        await this.deps.events.emitAsync("pull-write", { doc });
                        logDebug(`  ← ${path} (take-remote)`);
                        stats.writtenCount++;
                        this.deps.events.emit("auto-resolve", { filePath: path });
                    } catch (e: any) {
                        logError(`pull vault write failed: ${path}: ${e?.message ?? e}`);
                        stats.writeFailCount++;
                    }
                }
            },
        });
    }

    // ── Phase 3: dispatch ───────────────────────────────

    private logSummary(stats: BatchStats, concurrentCount: number): void {
        const active = stats.writtenCount > 0
            || stats.keepLocalCount > 0
            || concurrentCount > 0
            || stats.writeFailCount > 0
            || stats.deletedCount > 0
            || stats.convergedSkipCount > 0;
        if (!active) return;

        const parts: string[] = [];
        if (stats.writtenCount > 0) parts.push(`${stats.writtenCount} written`);
        if (stats.deletedCount > 0) parts.push(`${stats.deletedCount} deleted`);
        if (stats.keepLocalCount > 0) parts.push(`${stats.keepLocalCount} keep-local`);
        if (stats.convergedSkipCount > 0) parts.push(`${stats.convergedSkipCount} converged`);
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
