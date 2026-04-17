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
import { logDebug, logInfo } from "../../ui/log.ts";
import type { EchoTracker } from "./echo-tracker.ts";
import type { SyncEvents } from "./sync-events.ts";

const PUSH_POLL_INTERVAL_MS = 2000;

export interface PushPipelineDeps {
    localDb: LocalDB;
    client: ICouchClient;
    echoes: EchoTracker;
    events: SyncEvents;

    /** Session cancellation signal — pipeline exits its loop when true. */
    isCancelled: () => boolean;
    getLastPushedSeq: () => number | string;
    setLastPushedSeq: (s: number | string) => void;
    saveCheckpoints: () => Promise<void>;
    handleLocalDbError: (e: unknown, context: string) => void;
    delay: (ms: number) => Promise<void>;
}

export class PushPipeline {
    /** Latch so we emit at most one warning per `denied` storm. */
    private deniedWarningEmitted = false;

    constructor(private deps: PushPipelineDeps) {}

    async run(): Promise<void> {
        while (!this.deps.isCancelled()) {
            try {
                const localChanges = await this.deps.localDb.changes(
                    this.deps.getLastPushedSeq(),
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
                    await this.pushDocs(docs);
                    // SyncEngine subscribes to "paused" to update lastHealthyAt.
                    this.deps.events.emit("paused");
                }

                this.deps.setLastPushedSeq(localChanges.last_seq);
                await this.deps.saveCheckpoints();
            } catch (e: any) {
                if (this.deps.isCancelled()) return;
                if (e instanceof DbError) {
                    this.deps.handleLocalDbError(e, "push loop");
                    if (e.recovery === "halt") return;
                } else {
                    // Push errors are logged but don't escalate — the next
                    // cycle will retry.
                    logDebug(`push error: ${e?.message ?? e}`);
                }
            }

            await this.deps.delay(PUSH_POLL_INTERVAL_MS);
        }
    }

    /**
     * Push docs to remote. Fetches current remote revs and threads them
     * onto the docs before bulkDocs, same approach as remote-couch.ts.
     * Exposed for tests and potential one-shot callers.
     */
    async pushDocs(docs: CouchSyncDoc[]): Promise<void> {
        if (docs.length === 0) return;

        const prepared: Array<CouchSyncDoc & { _rev?: string }> = docs.map(
            (d) => stripRev(d) as CouchSyncDoc,
        );

        const remoteResult = await this.deps.client.allDocs<CouchSyncDoc>({
            keys: prepared.map((d) => d._id),
        });
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

        const results = await this.deps.client.bulkDocs(prepared);

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
