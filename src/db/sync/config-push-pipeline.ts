/**
 * ConfigPushPipeline — incremental push for ConfigSync.
 *
 * Replaces the snapshot push (`fetchRemoteConfigDocs` 全件 + `pushDocs`
 * by id list) with a delta-based pipeline:
 *
 *   1. enumerate local changes since `lastPushSeq` via ConfigLocalDB.changes()
 *   2. fetch remote `_rev` for the affected ids only (per-doc allDocs,
 *      not the legacy "fetch every config from remote" anti-pattern)
 *   3. classify per pair via vclock relation:
 *        concurrent  → divergent[] (caller drives the modal)
 *        dominated   → push skip (next pull will integrate)
 *        equal       → push skip (already converged)
 *        dominates   → proceed
 *   4. if any divergent, return without push — caller decides whether to
 *      cancel or trigger forcePush()
 *   5. bulkDocs the proceed[] set with attached _rev
 *   6. ALL-OR-NOTHING: any `error: "conflict"` row blocks the cursor
 *      advance, so the next run() re-enumerates the same delta and
 *      retries. Mirrors the safety the audit-2026-05-08 push-pipeline
 *      conflict-loss fix targets in vault sync.
 *
 * `forcePush(divergent)` is the post-modal continuation: bumps each
 * divergent doc's local vclock to dominate remote (mergeVC + bump),
 * then re-runs the pipeline. The cursor only advances on a clean run.
 */

import type { ConfigDoc, CouchSyncDoc, ChunkDoc } from "../../types.ts";
import { isConfigDoc } from "../../types.ts";
import {
    configPathFromId, isConfigDocId,
} from "../../types/doc-id.ts";
import { stripRev } from "../../utils/doc.ts";
import { compareVC, mergeVC, incrementVC, type VectorClock }
    from "../../sync/vector-clock.ts";
import { chunkListsEqual } from "../../sync/chunk-equality.ts";
import type {
    BulkDocsResult,
    DocWithAttachments,
    ICouchClient,
} from "../interfaces.ts";
import type { ConfigLocalDB } from "../config-local-db.ts";
import { buildChunkAttachment } from "../chunk-attachment.ts";
import { logDebug, logInfo } from "../../ui/log.ts";
import type { ConfigCheckpoints } from "./config-checkpoints.ts";

export interface ConfigPushDivergence {
    path: string;
    localVclock: VectorClock;
    remoteVclock: VectorClock;
    relation: "concurrent" | "dominated";
}

export interface ConfigPushStats {
    pushed: number;
    skipped: number;
    conflicts: number;
    divergent: number;
    /** Number of chunk docs pushed alongside ConfigDocs. Content-
     *  addressed; conflicts on chunks are benign (same hash = same
     *  content) and not counted as failures. */
    chunksPushed: number;
}

export interface ConfigPushResult {
    stats: ConfigPushStats;
    divergent: ConfigPushDivergence[];
    /** True iff the cursor was advanced. Always false when divergent or
     *  conflicts are nonzero — see all-or-nothing rule. */
    cursorAdvanced: boolean;
}

export interface ConfigPushPipelineDeps {
    db: ConfigLocalDB;
    client: ICouchClient;
    checkpoints: ConfigCheckpoints;
    getDeviceId: () => string;
    signal: AbortSignal;
}

export class ConfigPushPipeline {
    constructor(private deps: ConfigPushPipelineDeps) {}

    /**
     * Drain the local changes feed and push delta to remote. Stops at
     * the first divergence: returns without pushing so the caller can
     * surface a confirm modal and decide on `forcePush`.
     */
    async run(onProgress?: (msg: string) => void): Promise<ConfigPushResult> {
        const since = this.deps.checkpoints.getPushSeq();
        onProgress?.(`Enumerating local changes (since=${since})...`);

        const localChanges = await this.deps.db.changes(since, { include_docs: true });

        const toPush: ConfigDoc[] = [];
        for (const r of localChanges.results) {
            if (!isConfigDocId(r.id)) continue;
            if (r.deleted) continue; // tombstones not pushed in PR4 scope
            if (!r.doc) continue;
            const doc = stripRev(r.doc) as ConfigDoc;
            if (!isConfigDoc(doc)) continue;
            toPush.push(doc);
        }

        if (toPush.length === 0) {
            // Nothing to push and no config doc in this batch. Don't
            // advance the cursor — the local DB's `_update_seq` may have
            // moved due to meta writes (checkpoints, lastSynced, …) which
            // are unrelated to push and shouldn't pretend "we caught up
            // through seq N" when in fact no config delta was processed.
            // Leaving the cursor at `since` means re-running run() is a
            // cheap no-op (same since, same empty result).
            return {
                stats: ConfigPushPipeline.emptyStats(),
                divergent: [],
                cursorAdvanced: false,
            };
        }

        onProgress?.(`Checking remote revs for ${toPush.length} doc(s)...`);
        // include_docs:true is required because vclock lives in doc body —
        // we need the full remote doc to run compareVC on each pair, not
        // just the rev. The fetch is bounded by the local delta size, so
        // it's still O(delta) instead of the legacy O(all-config).
        const remoteRows = await this.deps.client.allDocs<ConfigDoc>(
            { keys: toPush.map((d) => d._id), include_docs: true },
            this.deps.signal,
        );
        const remoteRevMap = new Map<string, string>();
        const remoteVcMap = new Map<string, VectorClock>();
        // Full remote doc, so the equal-vclock skip can verify content
        // (chunks + deleted) rather than trusting the vclock proxy.
        const remoteDocMap = new Map<string, ConfigDoc>();
        for (const row of remoteRows.rows) {
            if (row.value?.rev && !row.value?.deleted) {
                remoteRevMap.set(row.id, row.value.rev);
            }
            if (row.doc) {
                const rdoc = row.doc as ConfigDoc;
                if (rdoc.vclock) remoteVcMap.set(row.id, rdoc.vclock);
                remoteDocMap.set(row.id, rdoc);
            }
        }

        // Classify per pair.
        const proceed: Array<ConfigDoc & { _rev?: string }> = [];
        const divergent: ConfigPushDivergence[] = [];
        let skipped = 0;
        for (const doc of toPush) {
            const remoteVc = remoteVcMap.get(doc._id);
            const path = configPathFromId(doc._id);
            const localVc = doc.vclock ?? {};
            if (!remoteVc) {
                // Remote-absent → safe to push (new doc).
                const stripped = stripRev(doc) as ConfigDoc & { _rev?: string };
                proceed.push(stripped);
                continue;
            }
            const cmp = compareVC(localVc, remoteVc);
            if (cmp === "concurrent") {
                divergent.push({
                    path, localVclock: localVc, remoteVclock: remoteVc,
                    relation: "concurrent",
                });
                continue;
            }
            if (cmp === "dominated") {
                // Remote ahead of local — push would clobber. Skip; next
                // pull integrates. Surface as divergent so the modal can
                // explain the situation.
                divergent.push({
                    path, localVclock: localVc, remoteVclock: remoteVc,
                    relation: "dominated",
                });
                continue;
            }
            if (cmp === "equal") {
                // Content-truthful skip: only converged when chunks AND the
                // deleted flag also match. A vclock tie with differing content
                // is the Config-Init stale-collision anomaly — surface it as
                // divergent so the modal arbitrates, rather than silently
                // dropping the local content (symmetric with the pull-side
                // truthful skip and the dominates-case churn guard).
                const rDoc = remoteDocMap.get(doc._id);
                if (rDoc && chunkListsEqual(doc.chunks, rDoc.chunks)
                    && !!doc.deleted === !!rDoc.deleted) {
                    skipped++;
                    continue;
                }
                divergent.push({
                    path, localVclock: localVc, remoteVclock: remoteVc,
                    relation: "concurrent",
                });
                continue;
            }
            // dominates — push proceeds.
            const stripped = stripRev(doc) as ConfigDoc & { _rev?: string };
            stripped._rev = remoteRevMap.get(doc._id);
            proceed.push(stripped);
        }

        if (divergent.length > 0) {
            // Don't push anything when any divergence exists — caller
            // decides via modal whether to forcePush. Cursor stays put.
            return {
                stats: {
                    ...ConfigPushPipeline.emptyStats(),
                    skipped,
                    divergent: divergent.length,
                },
                divergent,
                cursorAdvanced: false,
            };
        }

        if (proceed.length === 0) {
            // All skipped (every local change was already converged).
            // Advance cursor since the local seq has moved.
            if (localChanges.last_seq !== since) {
                this.deps.checkpoints.setPushSeq(localChanges.last_seq);
                await this.deps.checkpoints.save();
            }
            return {
                stats: { ...ConfigPushPipeline.emptyStats(), skipped },
                divergent: [],
                cursorAdvanced: localChanges.last_seq !== since,
            };
        }

        // Resolve chunks referenced by proceed[]. Chunks ride as
        // separate docs with envelope-formatted attachment "c" so the
        // wrapped client (compress + encrypt) sees one unified bytes
        // path for both push and pull. Content-addressed: pushing the
        // same chunk id twice across devices is a 409 conflict the
        // remote silently absorbs — no follow-up needed.
        const chunkAttachments = await this.buildChunkAttachments(proceed);

        onProgress?.(
            `Pushing ${proceed.length} doc(s)` +
            (chunkAttachments.length > 0
                ? ` + ${chunkAttachments.length} chunk(s)...`
                : `...`),
        );
        const [docResults, chunkResults] = await Promise.all([
            this.deps.client.bulkDocs(proceed, this.deps.signal),
            chunkAttachments.length > 0
                ? this.deps.client.bulkDocsWithAttachments(
                      chunkAttachments, this.deps.signal,
                  )
                : Promise.resolve([] as BulkDocsResult[]),
        ]);

        let conflicts = 0;
        let pushed = 0;
        for (const r of docResults) {
            if (r.error === "conflict") {
                conflicts++;
                logDebug(`  → ${r.id} (conflict, will retry next push)`);
            } else if (r.error) {
                logDebug(`  → ${r.id} (${r.error}: ${r.reason ?? ""})`);
            } else {
                pushed++;
            }
        }

        let chunksPushed = 0;
        for (const r of chunkResults) {
            // Chunk conflicts are benign (content-addressed); only count
            // successful new writes for diagnostics.
            if (!r.error) chunksPushed++;
        }

        const cursorAdvanced = conflicts === 0;
        if (cursorAdvanced) {
            this.deps.checkpoints.setPushSeq(localChanges.last_seq);
            await this.deps.checkpoints.save();
        }
        // else: leave cursor alone — next run() re-enumerates the same
        // delta and retries. All-or-nothing.

        if (pushed + conflicts + chunksPushed > 0) {
            const parts: string[] = [];
            if (pushed > 0) parts.push(`${pushed} pushed`);
            if (chunksPushed > 0) parts.push(`${chunksPushed} chunks`);
            if (skipped > 0) parts.push(`${skipped} skipped`);
            if (conflicts > 0) parts.push(`${conflicts} conflicts`);
            logInfo(`Config Push: ${parts.join(", ")}`);
        }

        return {
            stats: { pushed, skipped, conflicts, divergent: 0, chunksPushed },
            divergent: [],
            cursorAdvanced,
        };
    }

    /** Empty-stats helper so the various "nothing to push" returns share
     *  a single source of truth for which counters exist. */
    private static emptyStats(): ConfigPushStats {
        return {
            pushed: 0, skipped: 0, conflicts: 0, divergent: 0, chunksPushed: 0,
        };
    }

    /** Read referenced ChunkDocs for the proceed[] ConfigDocs from the
     *  local DB, build envelope-formatted attachment items ready for
     *  `bulkDocsWithAttachments`. De-duped by chunk id so the same
     *  chunk referenced by multiple configs ships once. */
    private async buildChunkAttachments(
        proceed: ConfigDoc[],
    ): Promise<DocWithAttachments[]> {
        const allChunkIds = new Set<string>();
        for (const doc of proceed) {
            for (const cid of doc.chunks) allChunkIds.add(cid);
        }
        if (allChunkIds.size === 0) return [];

        const chunks = await this.deps.db.getChunks([...allChunkIds]);
        // `keepRev: false`: local Dexie tracks revisions on its own store;
        // CouchDB's /_bulk_docs rejects a doc that already claims a rev when
        // the destination has no prior version (silent forbidden/conflict
        // per row). Vault's push pipeline keeps the rev because it has
        // back-filled the remote rev first — see buildChunkAttachment.
        return chunks.map((chunk) =>
            buildChunkAttachment(chunk as ChunkDoc & { _rev?: string }, { keepRev: false }),
        );
    }

    /**
     * Continuation after a confirm-divergence modal: causally advance
     * each divergent doc's local vclock so it dominates remote, then
     * caller re-runs `run()` to push. The vclock advance is committed
     * to LocalDB inside a runWriteBuilder so a CAS conflict (someone
     * else just edited the same path) restarts the merge cleanly.
     *
     * mergeVC + incrementVC produces a vclock strictly greater than both
     * sides — pull-side resolvers on peers will treat it as `dominated`
     * (i.e., a normal update), not a conflict.
     */
    async forcePushAdvanceVclocks(divergent: ConfigPushDivergence[]): Promise<void> {
        const deviceId = this.deps.getDeviceId();
        for (const entry of divergent) {
            const id = `config:${entry.path}`;
            await this.deps.db.runWriteBuilder(async (snap) => {
                const local = (await snap.get(id)) as ConfigDoc | null;
                if (!local) return null;
                const merged = mergeVC(local.vclock ?? {}, entry.remoteVclock);
                const bumped = incrementVC(merged, deviceId);
                const next: ConfigDoc = { ...local, vclock: bumped };
                return {
                    docs: [{ doc: next as CouchSyncDoc, expectedVclock: local.vclock ?? {} }],
                };
            });
        }
    }
}
