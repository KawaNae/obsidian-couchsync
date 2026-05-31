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
import { isConfigDoc, CONFIG_SCHEMA_VERSION } from "../../types.ts";
import { configPathFromId, isConfigDocId } from "../../types/doc-id.ts";
import { stripRev } from "../../utils/doc.ts";
import { compareVC, mergeVC } from "../../sync/vector-clock.ts";
import type { ICouchClient } from "../interfaces.ts";
import type { ChangesResult } from "../interfaces.ts";
import type { ConfigLocalDB } from "../config-local-db.ts";
import type { ConflictResolver } from "../../conflict/conflict-resolver.ts";
import { fetchMissingChunks } from "../chunk-attachment.ts";
import type { ChunkHasher } from "../chunker.ts";
import { assertSchemaVersion } from "./schema-gate.ts";
import { logDebug, logInfo, logWarn } from "../../ui/log.ts";
import {
    ConfigLastSynced,
    configLastSyncedKey,
} from "./config-last-synced.ts";
import {
    ConfigCheckpoints,
    META_CONFIG_PULL_SEQ,
} from "./config-checkpoints.ts";

const PULL_BATCH_LIMIT = 100;

/** Numeric prefix of a CouchDB update seq ("225-g1AA…" → 225). Mirrors the
 *  vault pull-pipeline helper; used to detect a remote that was recreated
 *  (its seq counter reset below our cursor). */
function seqNumeric(seq: number | string): number {
    if (typeof seq === "number") return seq;
    const n = parseInt(seq, 10);
    return Number.isNaN(n) ? 0 : n;
}
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
    /** PR-C: chunks-equal but vclocks drifted — committed with mergeVC,
     *  no concurrent modal. Closes audit-2026-05-08 MEDIUM on the
     *  ConfigSync side (vault PullWriter has the same counter under the
     *  name `vclockOnlyDriftCount`). */
    vclockOnlyDrift: number;
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
    /** Optional hasher to verify pulled chunk bodies hash to their id
     *  (the inverse of the mint in `splitIntoChunks`). When unset, chunks
     *  are stored without verification. */
    hasher?: ChunkHasher;
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
            accepted: 0, convergedSkip: 0, keepLocal: 0, deleted: 0,
            concurrent: 0, vclockOnlyDrift: 0,
        };
        const concurrent: ConfigConcurrentEntry[] = [];

        let totalReceived = 0;
        // One-shot guard for the seq-regression self-heal (L-2/L-3). A healthy
        // recreate-elsewhere event resets the cursor exactly once; a SECOND
        // regression in the same run means the server keeps reporting a
        // last_seq below our cursor — a pathological / hostile server we must
        // not let drive us around the MAX_PULL_BATCHES loop. Bound it to one
        // self-heal per run and fail terminally on the second.
        let didSeqReset = false;
        for (let loop = 0; loop < MAX_PULL_BATCHES; loop++) {
            const since = this.deps.checkpoints.getPullSeq();
            onProgress?.(
                `Pulling config from remote (since=${since}, received=${totalReceived})...`,
            );

            const batch = await this.deps.client.changes<ConfigDoc>(
                { since, limit: PULL_BATCH_LIMIT, include_docs: true },
                this.deps.signal,
            );

            // Seq regression: the remote config DB was destroyed + recreated by
            // a Config Init on another device, so its update-seq counter reset
            // below our cursor — `since > last_seq` means we'd silently fetch
            // nothing forever. Reset to 0 and re-pull the whole DB. The vault
            // pull guard (pull-pipeline.ts) throws into an error state, but a
            // config Init is an admin op the other devices should simply follow,
            // so we self-heal instead. (#config-codec)
            if (seqNumeric(batch.last_seq) < seqNumeric(since)) {
                // A second regression in one run is not a legitimate recreate —
                // the server is unstable or lying about last_seq. Fail terminally
                // rather than spin to MAX_PULL_BATCHES (L-3). The re-pulled docs
                // are still integrity-checked (cipherVersion floor + HMAC), so
                // this is an availability guard, not a confidentiality one.
                if (didSeqReset) {
                    throw new Error(
                        `Config pull: repeated seq regression in one run ` +
                        `(last_seq=${batch.last_seq} < cursor=${since}) — ` +
                        `server is unstable; aborting.`,
                    );
                }
                didSeqReset = true;
                logWarn(
                    `Config pull: remote seq regression (last_seq=${batch.last_seq} ` +
                    `< cursor=${since}) — config DB recreated elsewhere; ` +
                    `resetting cursor and re-pulling from scratch.`,
                );
                // Durable reset (L-2): persist pullSeq=0 to disk, not just the
                // in-memory cursor. A crash after a memory-only reset would leave
                // the high cursor on disk and re-trigger this regression (and a
                // full re-pull) every session. saveEmptyPullBatch writes
                // META_CONFIG_PULL_SEQ in its own tx and advances the cursor.
                await this.deps.checkpoints.saveEmptyPullBatch(0);
                continue;
            }

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
            stats.vclockOnlyDrift += partition.vclockOnlyDriftCount;
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
            || stats.concurrent > 0 || stats.keepLocal > 0
            || stats.vclockOnlyDrift > 0) {
            const parts: string[] = [];
            if (stats.accepted) parts.push(`${stats.accepted} accepted`);
            if (stats.deleted) parts.push(`${stats.deleted} deleted`);
            if (stats.convergedSkip) parts.push(`${stats.convergedSkip} converged`);
            if (stats.keepLocal) parts.push(`${stats.keepLocal} keep-local`);
            if (stats.vclockOnlyDrift) parts.push(`${stats.vclockOnlyDrift} silent-merge`);
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
        vclockOnlyDriftCount: number;
    }> {
        const accepted: ConfigDoc[] = [];
        const deleted: string[] = [];
        const concurrent: ConfigConcurrentEntry[] = [];
        let convergedSkipCount = 0;
        let keepLocalCount = 0;
        let vclockOnlyDriftCount = 0;
        const resolver = this.deps.getConflictResolver();

        for (const row of batch.results) {
            // Filter to config docs. The config DB also carries chunk
            // docs (v0.26+); their bodies arrive lazily through
            // `ensureChunks` and are skipped here. Anything else in
            // the config DB id space is unexpected — defend against
            // schema drift and drop.
            if (!isConfigDocId(row.id)) continue;

            if (row.deleted) {
                deleted.push(row.id);
                continue;
            }
            if (!row.doc) continue;
            const remoteDoc = stripRev(row.doc) as ConfigDoc;
            if (!isConfigDoc(remoteDoc)) continue;

            // Schema-version gate (Plan agent C1, invariant 17). v0.25
            // shipped ConfigDoc with `data: string` and `schemaVersion: 2`;
            // v0.26 expects `chunks: string[]` + `schemaVersion: 3`. Mixing
            // shapes silently corrupts disk writes, so we abort loudly
            // and route the host to the migration flow. Shared with the
            // vault pull path via schema-gate.ts.
            assertSchemaVersion(remoteDoc, CONFIG_SCHEMA_VERSION, "config");

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
                    // **Invariant 5 (PullVerdict 完全網羅).** Every verdict
                    // must be handled explicitly — fall-through silently
                    // dropping `silent-merge` was the audit-2026-05-08
                    // MEDIUM bug shape on the ConfigSync side. The final
                    // `_exhaustive: never` makes future verdict additions
                    // a compile error rather than a silent regression.
                    switch (verdict) {
                        case "keep-local":
                            logDebug(`  × ${path} (keep-local)`);
                            keepLocalCount++;
                            continue;
                        case "concurrent":
                            logDebug(`  ⚡ ${path} (concurrent)`);
                            concurrent.push({ path, localDoc, remoteDoc });
                            continue;
                        case "silent-merge": {
                            // Same content, drifted vclocks → mergeVC and
                            // accept. Mirrors vault PullWriter's silent-
                            // merge handling at pull-writer.ts:217.
                            const merged = mergeVC(localVC, remoteVC);
                            const mergedDoc: ConfigDoc = {
                                ...remoteDoc, vclock: merged,
                            };
                            logDebug(`  ⊔ ${path} (silent-merge)`);
                            vclockOnlyDriftCount++;
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

        return {
            accepted, deleted, concurrent,
            convergedSkipCount, keepLocalCount, vclockOnlyDriftCount,
        };
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
        // Build per-path lastSynced meta entries. v0.26 stores the
        // chunk-id list directly — same fingerprint the next scan()
        // compares against, so the short-circuit and the integration
        // baseline share one shape (vault symmetry).
        const lastSyncedMeta: Array<{
            op: "put"; key: string;
            value: {
                vclock: ConfigDoc["vclock"];
                size: number;
                chunks: string[];
            };
        }> = [];
        for (const doc of accepted) {
            const path = configPathFromId(doc._id);
            lastSyncedMeta.push({
                op: "put",
                key: configLastSyncedKey(path),
                value: { vclock: doc.vclock, size: doc.size, chunks: doc.chunks },
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
                    this.deps.lastSynced.set(path, {
                        vclock: doc.vclock,
                        size: doc.size,
                        chunks: doc.chunks,
                    });
                }
                for (const id of deletes) {
                    if (isConfigDocId(id)) {
                        this.deps.lastSynced.delete(configPathFromId(id));
                    }
                }
            },
        });

        // After the batch's docs and tombstones land durably, pull any
        // referenced chunks that aren't already local. ensureChunks runs
        // outside the runWriteTx so the per-chunk attachment fetch
        // round-trips don't keep the IDB write transaction open. A
        // missing chunk only blocks the eventual `ConfigSync.write()`
        // for that one path — config-pull stats already advanced.
        for (const doc of accepted) {
            try {
                await this.ensureChunks(doc);
            } catch (e: any) {
                logWarn(
                    `ConfigPullWriter.ensureChunks: ${configPathFromId(doc._id)}: ` +
                    `${e?.message ?? e}`,
                );
            }
        }
    }

    /**
     * Fetch any chunks referenced by `configDoc` that aren't already
     * present in the local config DB. Mirrors `SyncEngine.ensureChunksInternal`
     * for vault FileDocs. Bounded concurrency keeps a fresh-clone Init
     * within reasonable latency over HTTP/2-multiplexed transports.
     *
     * Missing-on-server chunks are logged via WARN and left missing —
     * the next `ConfigSync.write()` will skip that path with a clear
     * diagnostic rather than blocking the whole pull.
     */
    private async ensureChunks(configDoc: ConfigDoc): Promise<void> {
        const existing = await this.deps.db.getChunks(configDoc.chunks);
        // Availability (Invariant I): content-less doc counts as missing so it
        // is re-fetched rather than trusted by id. Symmetric with the vault
        // side (SyncEngine.ensureChunksInternal).
        const usableIds = new Set(
            existing.filter((c) => c.content instanceof Uint8Array).map((c) => c._id),
        );
        const missing = configDoc.chunks.filter((id) => !usableIds.has(id));
        if (missing.length === 0) return;

        // Fetch + verify + classify via the shared chunk-fetch core. This is
        // the same implementation the vault boundary uses, so a corrupt config
        // chunk is classified identically — `isCorruptChunkError` (incl. a
        // structurally-malformed EnvelopeError), not just ChunkIntegrityError
        // (L-8: the config copy previously rethrew EnvelopeError, aborting the
        // whole doc's ensureChunks instead of skipping + warning like vault).
        const { fetched, notFound, corrupt } = await fetchMissingChunks(missing, {
            getAttachment: (id, name, sig) =>
                this.deps.client.getAttachment(id, name, sig),
            hasher: this.deps.hasher,
            signal: this.deps.signal,
        });
        if (notFound.length > 0 || corrupt.length > 0) {
            const bad = [...notFound, ...corrupt];
            logWarn(
                `ConfigPullWriter: ${notFound.length} missing + ${corrupt.length} corrupt chunk(s) ` +
                `for ${configPathFromId(configDoc._id)}: ` +
                `${bad.slice(0, 3).join(", ")}${bad.length > 3 ? "…" : ""}`,
            );
        }
        if (fetched.length > 0) {
            await this.deps.db.runWriteTx({ chunks: fetched });
        }
    }
}
