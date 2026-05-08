/**
 * ConfigPullWriter — incremental `_changes`-based pull for ConfigSync.
 *
 * Replaces the snapshot-style `pullByPrefix` (`remote-couch.ts:156`) with
 * a cursor-driven loop:
 *
 *   loop:
 *     batch = client.changes({since=lastPullSeq, limit, include_docs}, signal)
 *     classify(batch):
 *       deleted          → tombstone in local
 *       vclock-equal     → convergedSkip (silent)
 *       resolver:keep    → skip
 *       resolver:concurrent → divergent[]; caller drives the modal
 *       else             → accepted
 *     commit accepted + deletes + new pullSeq in a single runWriteTx
 *     break when last_seq is unchanged AND batch is empty (= caught up)
 *
 * Mirror of `PullWriter` (vault sync), but without chunk handling and
 * without the `applyPullWrite` callback — config writes go to filesystem
 * via the separate `ConfigSync.write()` step, not inline per-doc.
 *
 * Atomicity: each batch lands docs + tombstones + new cursor in one tx.
 * Crash mid-loop leaves the next session at the last successful batch's
 * cursor, with no half-applied state. Mirrors the vault PullWriter.
 */

import type { ConfigDoc, CouchSyncDoc } from "../../types.ts";
import { isConfigDoc } from "../../types.ts";
import { configPathFromId, isConfigDocId } from "../../types/doc-id.ts";
import { stripRev } from "../../utils/doc.ts";
import { compareVC } from "../../sync/vector-clock.ts";
import type { ICouchClient } from "../interfaces.ts";
import type { ChangesResult } from "../interfaces.ts";
import type { ConfigLocalDB } from "../config-local-db.ts";
import type { ConflictResolver } from "../../conflict/conflict-resolver.ts";
import { base64ToArrayBuffer } from "../chunker.ts";
import { logDebug, logInfo } from "../../ui/log.ts";
import {
    ConfigLastSynced,
    computeConfigDataHash,
    configLastSyncedKey,
} from "./config-last-synced.ts";
import {
    ConfigCheckpoints,
    META_CONFIG_PULL_SEQ,
} from "./config-checkpoints.ts";

const PULL_BATCH_LIMIT = 100;
/** Hard guard against runaway loops if the server returns the same
 *  last_seq with non-empty results indefinitely. 100k configs is well
 *  beyond any realistic vault. */
const MAX_PULL_BATCHES = 1000;

export interface ConfigConcurrentEntry {
    path: string;
    localDoc: ConfigDoc;
    remoteDoc: ConfigDoc;
}

export interface ConfigPullStats {
    accepted: number;
    convergedSkip: number;
    keepLocal: number;
    deleted: number;
    concurrent: number;
}

export interface ConfigPullResult {
    stats: ConfigPullStats;
    concurrent: ConfigConcurrentEntry[];
}

export interface ConfigPullWriterDeps {
    db: ConfigLocalDB;
    client: ICouchClient;
    checkpoints: ConfigCheckpoints;
    lastSynced: ConfigLastSynced;
    getConflictResolver: () => ConflictResolver | undefined;
    signal: AbortSignal;
}

export class ConfigPullWriter {
    constructor(private deps: ConfigPullWriterDeps) {}

    /**
     * Drain remote `_changes` from the current pullSeq cursor onward,
     * landing each batch atomically. Returns aggregate stats and the
     * full list of concurrent entries collected across all batches —
     * the caller decides whether to surface a modal or drop them.
     */
    async run(onProgress?: (msg: string) => void): Promise<ConfigPullResult> {
        await this.deps.lastSynced.ensureLoaded();
        const stats: ConfigPullStats = {
            accepted: 0, convergedSkip: 0, keepLocal: 0, deleted: 0, concurrent: 0,
        };
        const concurrent: ConfigConcurrentEntry[] = [];

        let totalReceived = 0;
        for (let loop = 0; loop < MAX_PULL_BATCHES; loop++) {
            const since = this.deps.checkpoints.getPullSeq();
            onProgress?.(
                `Pulling config from remote (since=${since}, received=${totalReceived})...`,
            );

            const batch = await this.deps.client.changes<ConfigDoc>(
                { since, limit: PULL_BATCH_LIMIT, include_docs: true },
                this.deps.signal,
            );

            if (batch.results.length === 0) {
                if (batch.last_seq !== since) {
                    await this.deps.checkpoints.saveEmptyPullBatch(batch.last_seq);
                }
                break;
            }
            totalReceived += batch.results.length;

            const partition = await this.classify(batch);

            await this.commitBatch(partition.accepted, partition.deleted, batch.last_seq);

            stats.accepted += partition.accepted.length;
            stats.deleted += partition.deleted.length;
            stats.convergedSkip += partition.convergedSkipCount;
            stats.keepLocal += partition.keepLocalCount;
            stats.concurrent += partition.concurrent.length;
            concurrent.push(...partition.concurrent);

            // No advance + no docs → server is at our cursor, done.
            if (batch.last_seq === since && partition.accepted.length === 0
                && partition.deleted.length === 0) {
                break;
            }

            // Server returned fewer than the limit — almost certainly the
            // tail of changes. One more poll only if last_seq advanced.
            if (batch.results.length < PULL_BATCH_LIMIT
                && batch.last_seq === this.deps.checkpoints.getPullSeq()) {
                break;
            }
        }

        if (stats.accepted + stats.deleted > 0 || stats.convergedSkip > 0
            || stats.concurrent > 0 || stats.keepLocal > 0) {
            const parts: string[] = [];
            if (stats.accepted) parts.push(`${stats.accepted} accepted`);
            if (stats.deleted) parts.push(`${stats.deleted} deleted`);
            if (stats.convergedSkip) parts.push(`${stats.convergedSkip} converged`);
            if (stats.keepLocal) parts.push(`${stats.keepLocal} keep-local`);
            if (stats.concurrent) parts.push(`${stats.concurrent} concurrent`);
            logInfo(`Config Pull: ${parts.join(", ")}`);
        }

        return { stats, concurrent };
    }

    // ── classify ────────────────────────────────────────

    private async classify(batch: ChangesResult<ConfigDoc>): Promise<{
        accepted: ConfigDoc[];
        deleted: string[];
        concurrent: ConfigConcurrentEntry[];
        convergedSkipCount: number;
        keepLocalCount: number;
    }> {
        const accepted: ConfigDoc[] = [];
        const deleted: string[] = [];
        const concurrent: ConfigConcurrentEntry[] = [];
        let convergedSkipCount = 0;
        let keepLocalCount = 0;
        const resolver = this.deps.getConflictResolver();

        for (const row of batch.results) {
            // Filter to config docs. The config DB shouldn't contain
            // anything else, but defend against future schema drift.
            if (!isConfigDocId(row.id)) continue;

            if (row.deleted) {
                deleted.push(row.id);
                continue;
            }
            if (!row.doc) continue;
            const remoteDoc = stripRev(row.doc) as ConfigDoc;
            if (!isConfigDoc(remoteDoc)) continue;

            const localDoc = (await this.deps.db.get(row.id)) as ConfigDoc | null;
            if (localDoc) {
                const localVC = localDoc.vclock ?? {};
                const remoteVC = remoteDoc.vclock ?? {};
                if (Object.keys(localVC).length > 0
                    && compareVC(localVC, remoteVC) === "equal") {
                    convergedSkipCount++;
                    continue;
                }
                if (resolver) {
                    const verdict = await resolver.resolveOnPull(localDoc, remoteDoc);
                    const path = configPathFromId(remoteDoc._id);
                    if (verdict === "keep-local") {
                        logDebug(`  × ${path} (keep-local)`);
                        keepLocalCount++;
                        continue;
                    }
                    if (verdict === "concurrent") {
                        logDebug(`  ⚡ ${path} (concurrent)`);
                        concurrent.push({ path, localDoc, remoteDoc });
                        continue;
                    }
                    // "take-remote" falls through.
                }
            }
            accepted.push(remoteDoc);
        }

        return { accepted, deleted, concurrent, convergedSkipCount, keepLocalCount };
    }

    // ── commit ─────────────────────────────────────────

    /**
     * Land accepted docs + tombstones + new pullSeq in one runWriteTx.
     * Updates the in-memory `lastSynced` cache + cursor only after the
     * durable write succeeds, so callers always observe consistent state.
     *
     * Note: we don't use `ConfigCheckpoints.commitPullBatch` here because
     * that helper accepts only docs, not deletes. Inlining the runWriteTx
     * keeps the atomic boundary clean and lets us also write `lastSynced`
     * meta entries in the same tx.
     */
    private async commitBatch(
        accepted: ConfigDoc[],
        deletes: string[],
        nextPullSeq: number | string,
    ): Promise<void> {
        // Pre-compute lastSynced meta entries for accepted docs. Each
        // doc carries base64 `data`; we hash it once here so the cache
        // can short-circuit a subsequent scan() against the same content.
        const lastSyncedMeta: Array<{
            op: "put"; key: string;
            value: { vclock: ConfigDoc["vclock"]; size: number; dataHash: string };
        }> = [];
        const acceptedHashes = new Map<string, string>();
        for (const doc of accepted) {
            const hash = await computeConfigDataHash(base64ToArrayBuffer(doc.data));
            const path = configPathFromId(doc._id);
            acceptedHashes.set(doc._id, hash);
            lastSyncedMeta.push({
                op: "put",
                key: configLastSyncedKey(path),
                value: { vclock: doc.vclock, size: doc.size, dataHash: hash },
            });
        }
        const lastSyncedDeletes = deletes
            .filter(isConfigDocId)
            .map((id) => ({
                op: "delete" as const,
                key: configLastSyncedKey(configPathFromId(id)),
            }));

        if (accepted.length === 0 && deletes.length === 0) {
            // Pure cursor advance (only convergedSkip / keep-local in batch).
            await this.deps.checkpoints.saveEmptyPullBatch(nextPullSeq);
            return;
        }

        await this.deps.db.runWriteTx({
            docs: accepted.map((d) => ({ doc: d as CouchSyncDoc })),
            deletes,
            meta: [
                { op: "put", key: META_CONFIG_PULL_SEQ, value: nextPullSeq },
                ...lastSyncedMeta,
                ...lastSyncedDeletes,
            ],
            onCommit: () => {
                this.deps.checkpoints.setPullSeq(nextPullSeq);
                for (const doc of accepted) {
                    const path = configPathFromId(doc._id);
                    const hash = acceptedHashes.get(doc._id)!;
                    this.deps.lastSynced.set(path, {
                        vclock: doc.vclock,
                        size: doc.size,
                        dataHash: hash,
                    });
                }
                for (const id of deletes) {
                    if (isConfigDocId(id)) {
                        this.deps.lastSynced.delete(configPathFromId(id));
                    }
                }
            },
        });
    }
}
