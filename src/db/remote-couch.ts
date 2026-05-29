/**
 * Stateless helpers for one-shot remote CouchDB operations.
 *
 * Each function takes ICouchClient + IDocStore; production callers
 * pass a CouchClient and LocalDB/ConfigLocalDB.
 *
 * The helpers remain stateless — construct, call, discard. Callers own
 * the lifecycle of both the local store and the remote client.
 *
 * AbortSignal: every helper takes an optional `signal` that propagates
 * into every `client.*` call. ConfigOperation uses this to cancel
 * in-flight HTTP work when the user cancels or session is disposed.
 */

import type { ICouchClient, IDocStore, DocWithAttachments, BulkDocsResult } from "./interfaces.ts";
import type { CouchSyncDoc, ChunkDoc } from "../types.ts";
import { stripRev } from "../utils/doc.ts";
import { isChunkDocId } from "../types/doc-id.ts";
import { paginateAllDocs, DEFAULT_BATCH_SIZE } from "./sync/pagination.ts";
import { buildChunkAttachment, chunkFromAttachment } from "./chunk-attachment.ts";
import { logWarn } from "../ui/log.ts";

/** Partition a doc list into chunk attachments vs everything else,
 *  matching the v2 push-pipeline split. Used by setup-time bulk push
 *  paths (`pushAll`, `pushDocs`) so the chunk body never travels in
 *  the JSON of `_bulk_docs`. */
function splitForPush(docs: Array<CouchSyncDoc & { _rev?: string }>): {
    chunks: DocWithAttachments[];
    chunkPositions: number[];
    rest: Array<CouchSyncDoc & { _rev?: string }>;
    restPositions: number[];
} {
    const chunks: DocWithAttachments[] = [];
    const chunkPositions: number[] = [];
    const rest: Array<CouchSyncDoc & { _rev?: string }> = [];
    const restPositions: number[] = [];
    for (let i = 0; i < docs.length; i++) {
        const d = docs[i];
        if (isChunkDocId(d._id)) {
            const c = d as ChunkDoc & { _rev?: string };
            chunkPositions.push(i);
            chunks.push(buildChunkAttachment(c));
        } else {
            restPositions.push(i);
            rest.push(d);
        }
    }
    return { chunks, chunkPositions, rest, restPositions };
}

async function pushSplit(
    remote: ICouchClient,
    docs: Array<CouchSyncDoc & { _rev?: string }>,
    signal?: AbortSignal,
): Promise<BulkDocsResult[]> {
    const split = splitForPush(docs);
    const results: BulkDocsResult[] = new Array(docs.length);
    const work: Promise<unknown>[] = [];
    if (split.rest.length > 0) {
        work.push(remote.bulkDocs(split.rest, signal).then((res) => {
            for (let i = 0; i < res.length; i++) {
                results[split.restPositions[i]] = res[i];
            }
        }));
    }
    if (split.chunks.length > 0) {
        work.push(remote.bulkDocsWithAttachments(split.chunks, signal).then((res) => {
            for (let i = 0; i < res.length; i++) {
                results[split.chunkPositions[i]] = res[i];
            }
        }));
    }
    await Promise.all(work);
    return results;
}

export type ProgressCallback = (docId: string, count: number) => void;

/**
 * Push specific documents from `local` to `remote`. Reads the docs
 * from the local store and writes them to the remote via _bulk_docs.
 * Returns the count of docs written. Skips work if the id list is empty.
 */
export async function pushDocs(
    local: IDocStore<CouchSyncDoc>,
    remote: ICouchClient,
    docIds: string[],
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
): Promise<number> {
    if (docIds.length === 0) return 0;

    // Read all requested docs from local store.
    const result = await local.allDocs({
        keys: docIds,
        include_docs: true,
    });
    const docs: any[] = [];
    for (const row of result.rows) {
        if (row.doc && !row.value?.deleted) {
            // Strip local _rev — remote will assign its own.
            docs.push(stripRev(row.doc));
        }
    }
    if (docs.length === 0) return 0;

    // Fetch current remote revisions so we can include _rev for updates.
    const remoteResult = await remote.allDocs<CouchSyncDoc>({
        keys: docs.map((d) => d._id),
    }, signal);
    const remoteRevMap = new Map<string, string>();
    for (const row of remoteResult.rows) {
        if (row.value?.rev && !row.value?.deleted) {
            remoteRevMap.set(row.id, row.value.rev);
        }
    }
    for (const doc of docs) {
        const remoteRev = remoteRevMap.get(doc._id);
        if (remoteRev) doc._rev = remoteRev;
    }

    const results = await pushSplit(remote, docs as Array<CouchSyncDoc & { _rev?: string }>, signal);
    let total = 0;
    for (const res of results) {
        if (res?.ok) {
            total++;
            onProgress?.(res.id, total);
        }
    }
    return total;
}

/**
 * Pull specific documents by id from `remote` to `local`. Counterpart
 * to `pushDocs` — a symmetric one-shot helper. Ids missing on the
 * remote are silently skipped (mirrors bulkGet's semantics).
 */
export async function pullDocs(
    local: IDocStore<CouchSyncDoc>,
    remote: ICouchClient,
    docIds: string[],
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
): Promise<number> {
    if (docIds.length === 0) return 0;

    const fetched = await remote.bulkGet<CouchSyncDoc>(docIds, signal);
    if (fetched.length === 0) return 0;

    const localDocs = fetched.map((d) => stripRev(d) as CouchSyncDoc);
    await local.runWriteTx({
        docs: localDocs.map((doc) => ({ doc })),
    });

    let total = 0;
    for (const doc of localDocs) {
        total++;
        onProgress?.(doc._id, total);
    }
    return total;
}

/**
 * Delete specific documents on `remote` by sending tombstones. Fetches
 * the current remote `_rev` for each id, then issues `_deleted: true`
 * records via _bulk_docs. Ids that don't currently exist on remote (or
 * are already tombstoned) are silently skipped. Returns the count of
 * tombstones actually accepted.
 */
export async function deleteRemoteDocs(
    remote: ICouchClient,
    docIds: string[],
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
): Promise<number> {
    if (docIds.length === 0) return 0;

    const remoteResult = await remote.allDocs<CouchSyncDoc>({
        keys: docIds,
    }, signal);
    const tombstones: Array<{ _id: string; _rev: string; _deleted: true }> = [];
    for (const row of remoteResult.rows) {
        const rev = row.value?.rev;
        if (rev && !row.value?.deleted) {
            tombstones.push({ _id: row.id, _rev: rev, _deleted: true });
        }
    }
    if (tombstones.length === 0) return 0;

    const results = await remote.bulkDocs(tombstones, signal);
    let total = 0;
    for (const res of results) {
        if (res.ok) {
            total++;
            onProgress?.(res.id, total);
        }
    }
    return total;
}

/**
 * Pull every doc whose `_id` matches `prefix` from `remote` into `local`.
 * Used by ConfigSync to fetch all `config:*` docs without touching
 * file/chunk space. Returns the count of docs written locally.
 *
 * Paginated: fetches `DEFAULT_BATCH_SIZE` rows per request (over
 * keyset continuation), and writes each batch to local in its own
 * `runWriteTx`. This bounds both per-request HTTP payload size (so the
 * 30s wall-clock timeout is survivable on slow mobile) and per-tx IDB
 * write size (so a single dead-handle window doesn't lose the whole
 * batch).
 */
export async function pullByPrefix(
    local: IDocStore<CouchSyncDoc>,
    remote: ICouchClient,
    prefix: string,
    onProgress?: (fetched: number) => void,
    signal?: AbortSignal,
): Promise<number> {
    let written = 0;
    for await (const rows of paginateAllDocs<CouchSyncDoc>(
        remote,
        {
            startkey: prefix,
            endkey: prefix + "\ufff0",
            include_docs: true,
        },
        { signal, batchSize: DEFAULT_BATCH_SIZE },
    )) {
        const docs: CouchSyncDoc[] = [];
        for (const row of rows) {
            if (row.doc && !row.value?.deleted) {
                docs.push(row.doc);
            }
        }
        if (docs.length === 0) continue;

        // Strip remote _rev before writing to local.
        const localDocs = docs.map((d) => stripRev(d) as CouchSyncDoc);
        await local.runWriteTx({
            docs: localDocs.map((doc) => ({ doc })),
        });
        written += localDocs.length;
        onProgress?.(written);
    }
    return written;
}

/**
 * List remote document ids matching `prefix`. Lightweight — no doc
 * bodies loaded. Used by the Files-tab suggestion list and the
 * Maintenance migration helpers.
 */
export async function listRemoteByPrefix(
    remote: ICouchClient,
    prefix: string,
    signal?: AbortSignal,
): Promise<string[]> {
    const ids: string[] = [];
    for await (const rows of paginateAllDocs<CouchSyncDoc>(
        remote,
        {
            startkey: prefix,
            endkey: prefix + "\ufff0",
        },
        { signal, batchSize: DEFAULT_BATCH_SIZE },
    )) {
        for (const row of rows) {
            if (!row.value?.deleted) ids.push(row.id);
        }
    }
    return ids;
}

/** Destroy the remote database. Tolerates 404 (DB already gone). */
export async function destroyRemote(
    remote: ICouchClient,
    signal?: AbortSignal,
): Promise<void> {
    try {
        await remote.destroy(signal);
    } catch (e: any) {
        if (e?.status === 404) return;
        throw e;
    }
}

/**
 * Push every doc in `local` to `remote` as a one-shot. Used by SetupService
 * during Init to seed the remote from a freshly-scanned vault.
 *
 * Enumerates ids without loading bodies (`listIds`), then loads + pushes
 * one `DEFAULT_BATCH_SIZE` page at a time. This keeps peak memory bounded
 * (a large vault's chunk bodies are never all resident at once) and is
 * symmetric with the paginated `pullAll`. The per-page remote rev lookup
 * is itself batched inside `CouchClient.allDocs`.
 */
export async function pushAll(
    local: IDocStore<CouchSyncDoc>,
    remote: ICouchClient,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
): Promise<number> {
    const ids = await local.listIds({ startkey: "", endkey: "\ufff0" });
    let total = 0;

    for (let i = 0; i < ids.length; i += DEFAULT_BATCH_SIZE) {
        const pageIds = ids.slice(i, i + DEFAULT_BATCH_SIZE);
        const result = await local.allDocs({ keys: pageIds, include_docs: true });
        const docs: Array<CouchSyncDoc & { _rev?: string }> = [];
        for (const row of result.rows) {
            if (row.doc && !row.value?.deleted) {
                docs.push(stripRev(row.doc) as CouchSyncDoc);
            }
        }
        if (docs.length === 0) continue;

        // Fetch current remote revisions for existing docs.
        const remoteResult = await remote.allDocs<CouchSyncDoc>({
            keys: docs.map((d) => d._id),
        }, signal);
        const remoteRevMap = new Map<string, string>();
        for (const row of remoteResult.rows) {
            if (row.value?.rev && !row.value?.deleted) {
                remoteRevMap.set(row.id, row.value.rev);
            }
        }
        for (const doc of docs) {
            const remoteRev = remoteRevMap.get(doc._id);
            if (remoteRev) doc._rev = remoteRev;
        }

        const results = await pushSplit(remote, docs, signal);
        for (const res of results) {
            if (res?.ok) {
                total++;
                onProgress?.(res.id, total);
            }
        }
    }
    return total;
}

/** Concurrency for the per-batch chunk attachment fetch in `pullAll`. */
const PULL_ATTACHMENT_CONCURRENCY = 4;

/**
 * Resolve chunk bodies for one batch of pulled docs in place. v2 chunk
 * bodies live in attachments, not in the doc body, so each chunk doc
 * must have its `[codec][body]` envelope fetched and decoded before it
 * can be committed locally. Bounded-concurrency parallel fetch (mirrors
 * `ensureChunks`). Returns the set of chunk ids whose attachment 404'd —
 * those are dropped by the caller (NOT written as empty, which would
 * pass every id-based consistency gate and silently truncate the file).
 */
async function resolveChunkAttachments(
    docs: CouchSyncDoc[],
    remote: ICouchClient,
    signal?: AbortSignal,
): Promise<Set<string>> {
    const queue: number[] = [];
    for (let i = 0; i < docs.length; i++) {
        if (isChunkDocId(docs[i]._id)) queue.push(i);
    }
    const notFound = new Set<string>();
    if (queue.length === 0) return notFound;

    const workers: Promise<void>[] = [];
    for (let w = 0; w < PULL_ATTACHMENT_CONCURRENCY; w++) {
        workers.push((async () => {
            while (queue.length > 0) {
                const i = queue.shift();
                if (i === undefined) return;
                const id = docs[i]._id;
                const blob = await remote.getAttachment(id, "c", signal);
                if (blob === null) {
                    notFound.add(id);
                    continue;
                }
                // Decoder stack already stripped encryption + compression
                // (no hasher here — Clone runs before a stable hmac hasher
                // is available).
                docs[i] = await chunkFromAttachment(id, blob);
            }
        })());
    }
    await Promise.all(workers);
    return notFound;
}

/**
 * Pull every doc from `remote` into `local`. Returns the count written.
 *
 * Paginated over keyset continuation (`DEFAULT_BATCH_SIZE` rows per
 * request), with each batch's chunk attachments fetched and the batch
 * committed in its own `runWriteTx`. This bounds per-request HTTP payload
 * (so the 30s mobile timeout is survivable) and peak memory (so a
 * fresh-clone of a large vault never has to hold every chunk body at
 * once) — mirroring `pullByPrefix`. The single-request `allDocs(
 * {include_docs:true})` this replaces regressed on exactly the mobile
 * timeout this project already learned to paginate around for Config Pull.
 */
export async function pullAll(
    local: IDocStore<CouchSyncDoc>,
    remote: ICouchClient,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
): Promise<number> {
    let written = 0;
    const notFoundTotal = new Set<string>();

    for await (const rows of paginateAllDocs<CouchSyncDoc>(
        remote,
        { startkey: "", endkey: "\ufff0", include_docs: true },
        { signal, batchSize: DEFAULT_BATCH_SIZE },
    )) {
        const docs: CouchSyncDoc[] = [];
        for (const row of rows) {
            if (row.doc && !row.value?.deleted) docs.push(row.doc);
        }
        if (docs.length === 0) continue;

        const notFound = await resolveChunkAttachments(docs, remote, signal);
        for (const id of notFound) notFoundTotal.add(id);

        // Exclude chunks whose attachment 404'd, then strip remote _rev.
        const localDocs = docs
            .filter((d) => !notFound.has(d._id))
            .map((d) => stripRev(d) as CouchSyncDoc);
        if (localDocs.length === 0) continue;

        await local.runWriteTx({
            docs: localDocs.map((doc) => ({ doc })),
        });
        for (const doc of localDocs) {
            written++;
            onProgress?.(doc._id, written);
        }
    }

    if (notFoundTotal.size > 0) {
        logWarn(
            `pullAll: ${notFoundTotal.size} chunk attachment(s) missing on remote; ` +
            `skipped (not written as empty): ` +
            `${[...notFoundTotal].slice(0, 3).join(", ")}${notFoundTotal.size > 3 ? "…" : ""}`,
        );
    }
    return written;
}
