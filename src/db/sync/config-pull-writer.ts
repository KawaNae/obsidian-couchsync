/**
 * ConfigPullWriter — copies the server's config docs into the local config
 * DB, from the `_changes` cursor onward.
 *
 *   loop:
 *     batch = client.changes({since=pullSeq, limit, include_docs}, signal)
 *     land the batch's docs, tombstones and the new pullSeq in one tx
 *     fetch the chunks the landed docs reference
 *     break when caught up
 *
 * The local config DB doc is the copy of the shared state, so the remote
 * doc always replaces it: nothing is classified here. Comparing the shared
 * version with the disk is Pull's next step (`config-reconcile.ts`), which
 * also moves lastSynced. A remote deletion removes the doc and its
 * lastSynced: the path has no shared version any more, and a file still on
 * disk is new to the shared state.
 *
 * Atomicity: each batch lands docs + tombstones + new cursor in one tx.
 * Crash mid-loop leaves the next session at the last successful batch's
 * cursor, with no half-applied state.
 */

import type { ConfigDoc, CouchSyncDoc } from "../../types.ts";
import { isConfigDoc, CONFIG_SCHEMA_VERSION } from "../../types.ts";
import { configPathFromId, isConfigDocId } from "../../types/doc-id.ts";
import { stripRev } from "../../utils/doc.ts";
import type { ICouchClient } from "../interfaces.ts";
import type { ConfigLocalDB } from "../config-local-db.ts";
import { fetchMissingChunks } from "../chunk-attachment.ts";
import type { ChunkHasher } from "../chunker.ts";
import { assertSchemaVersion } from "./schema-gate.ts";
import { logInfo, logWarn } from "../../ui/log.ts";
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

export interface ConfigPullStats {
    /** Docs copied into the local config DB. */
    received: number;
    /** Remote deletions applied. */
    deleted: number;
}

export interface ConfigPullWriterDeps {
    db: ConfigLocalDB;
    client: ICouchClient;
    checkpoints: ConfigCheckpoints;
    lastSynced: ConfigLastSynced;
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
     * landing each batch atomically.
     */
    async run(onProgress?: (msg: string) => void): Promise<ConfigPullStats> {
        await this.deps.lastSynced.ensureLoaded();
        const stats: ConfigPullStats = { received: 0, deleted: 0 };

        let totalReceived = 0;
        // One-shot guard for the seq-regression self-heal. A healthy
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
            // a config Create on another device, so its update-seq counter reset
            // below our cursor — `since > last_seq` means we'd silently fetch
            // nothing forever. Reset to 0 and re-pull the whole DB. The vault
            // pull guard (pull-pipeline.ts) throws into an error state, but a
            // config Create is an admin op the other devices should simply follow,
            // so we self-heal instead.
            if (seqNumeric(batch.last_seq) < seqNumeric(since)) {
                // A second regression in one run is not a legitimate recreate —
                // the server is unstable or lying about last_seq. Fail terminally
                // rather than spin to MAX_PULL_BATCHES. The re-pulled docs
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
                // Durable reset: persist pullSeq=0 to disk, not just the
                // in-memory cursor. A crash after a memory-only reset would leave
                // the high cursor on disk and re-trigger this regression (and a
                // full re-pull) every session.
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

            const { docs, deleted } = this.collect(batch.results);
            await this.commitBatch(docs, deleted, batch.last_seq);
            stats.received += docs.length;
            stats.deleted += deleted.length;

            if (batch.last_seq === since && docs.length === 0 && deleted.length === 0) {
                break;
            }
            // Server returned fewer than the limit — almost certainly the
            // tail of changes. One more poll only if last_seq advanced.
            if (batch.results.length < PULL_BATCH_LIMIT
                && batch.last_seq === this.deps.checkpoints.getPullSeq()) {
                break;
            }
        }

        if (stats.received + stats.deleted > 0) {
            logInfo(`Config Pull: ${stats.received} received, ${stats.deleted} deleted`);
        }
        return stats;
    }

    private collect(rows: Array<{ id: string; deleted?: boolean; doc?: ConfigDoc }>): {
        docs: ConfigDoc[];
        deleted: string[];
    } {
        const docs: ConfigDoc[] = [];
        const deleted: string[] = [];
        for (const row of rows) {
            // The config DB also carries chunk docs; their bodies arrive
            // through `ensureChunks`. Anything else in the id space is
            // unexpected and dropped.
            if (!isConfigDocId(row.id)) continue;
            if (row.deleted) {
                deleted.push(row.id);
                continue;
            }
            if (!row.doc) continue;
            const remoteDoc = stripRev(row.doc) as ConfigDoc;
            if (!isConfigDoc(remoteDoc)) continue;
            // A ConfigDoc shape this build cannot read aborts the pull
            // loudly (mixing shapes corrupts disk writes); the error names
            // the migration. Shared with the vault pull path.
            assertSchemaVersion(remoteDoc, CONFIG_SCHEMA_VERSION, "config");
            docs.push(remoteDoc);
        }
        return { docs, deleted };
    }

    /**
     * Land docs + tombstones + new pullSeq in one runWriteTx, then fetch the
     * chunks the docs reference outside the tx (the attachment round-trips
     * must not keep the IDB write transaction open). A chunk that cannot be
     * fetched only holds back that one path; the merge step skips it.
     */
    private async commitBatch(
        docs: ConfigDoc[],
        deletes: string[],
        nextPullSeq: number | string,
    ): Promise<void> {
        if (docs.length === 0 && deletes.length === 0) {
            await this.deps.checkpoints.saveEmptyPullBatch(nextPullSeq);
            return;
        }
        await this.deps.db.runWriteTx({
            docs: docs.map((d) => ({ doc: d as CouchSyncDoc })),
            deletes,
            meta: [
                { op: "put", key: META_CONFIG_PULL_SEQ, value: nextPullSeq },
                ...deletes.map((id) => ({
                    op: "delete" as const,
                    key: configLastSyncedKey(configPathFromId(id)),
                })),
            ],
            onCommit: () => {
                this.deps.checkpoints.setPullSeq(nextPullSeq);
                for (const id of deletes) this.deps.lastSynced.delete(configPathFromId(id));
            },
        });
        for (const doc of docs) {
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
     * for vault FileDocs. Bounded concurrency keeps a first pull after a Join
     * within reasonable latency over HTTP/2-multiplexed transports.
     *
     * Missing-on-server chunks are logged via WARN and left missing —
     * the merge step skips that path with a clear diagnostic rather than
     * blocking the whole pull, and tries the fetch again on a later Pull.
     */
    async ensureChunks(configDoc: ConfigDoc): Promise<void> {
        const existing = await this.deps.db.getChunks(configDoc.chunks);
        // Availability: content-less doc counts as missing so it
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
        // (the config copy previously rethrew EnvelopeError, aborting the
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
