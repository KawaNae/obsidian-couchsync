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
import { base64ToArrayBuffer } from "./chunker.ts";
import { paginateAllDocs, DEFAULT_BATCH_SIZE } from "./sync/pagination.ts";

/** Strip the v2 binary `content` (and legacy `data`) from a chunk doc
 *  body before sending it to the remote. The attachment carries the
 *  canonical payload; these fields would either serialise as junk
 *  (Uint8Array → giant numeric JSON) or duplicate the storage. */
function stripChunkBody(c: ChunkDoc & { _rev?: string }) {
    const { data: _data, content: _content, ...rest } = c;
    void _data; void _content;
    return rest;
}

function chunkAttachmentBytes(c: ChunkDoc): Uint8Array | null {
    if (c.content) return c.content;
    if (typeof c.data === "string") {
        if (c.data.length === 0) return new Uint8Array(0);
        return new Uint8Array(base64ToArrayBuffer(c.data));
    }
    return null;
}

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
            const body = chunkAttachmentBytes(c) ?? new Uint8Array(0);
            chunkPositions.push(i);
            chunks.push({
                doc: stripChunkBody(c),
                attachments: {
                    c: {
                        contentType: "application/octet-stream",
                        data: body,
                    },
                },
            });
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
 */
export async function pushAll(
    local: IDocStore<CouchSyncDoc>,
    remote: ICouchClient,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
): Promise<number> {
    const result = await local.allDocs({ include_docs: true });
    const docs: Array<CouchSyncDoc & { _rev?: string }> = [];
    for (const row of result.rows) {
        if (row.doc && !row.value?.deleted) {
            docs.push(stripRev(row.doc) as CouchSyncDoc);
        }
    }
    if (docs.length === 0) return 0;

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
 * Pull every doc from `remote` into `local`. Returns both the written
 * count and the array of pulled documents (so callers can react to each,
 * e.g. SetupService writing files to the vault during Clone).
 */
export async function pullAll(
    local: IDocStore<CouchSyncDoc>,
    remote: ICouchClient,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
): Promise<{ written: number; docs: CouchSyncDoc[] }> {
    const remoteResult = await remote.allDocs<CouchSyncDoc>({
        include_docs: true,
    }, signal);

    const docs: CouchSyncDoc[] = [];
    for (const row of remoteResult.rows) {
        if (row.doc && !row.value?.deleted) {
            docs.push(row.doc);
        }
    }
    if (docs.length === 0) return { written: 0, docs: [] };

    // v2: chunk bodies live in attachments, not in the doc body. Fetch
    // the binary content for every chunk before committing locally.
    // Bounded-concurrency parallel fetch (mirrors `ensureChunks`) so a
    // fresh-clone pullAll completes in reasonable time over modern
    // HTTP/2 connections.
    const CONCURRENCY = 4;
    const chunkIndices: number[] = [];
    for (let i = 0; i < docs.length; i++) {
        if (isChunkDocId(docs[i]._id)) chunkIndices.push(i);
    }
    if (chunkIndices.length > 0) {
        const queue = [...chunkIndices];
        const workers: Promise<void>[] = [];
        for (let w = 0; w < CONCURRENCY; w++) {
            workers.push((async () => {
                while (queue.length > 0) {
                    const i = queue.shift();
                    if (i === undefined) return;
                    const blob = await remote.getAttachment(docs[i]._id, "c", signal);
                    const c = docs[i] as ChunkDoc;
                    c.data = "";
                    c.content = blob ?? new Uint8Array(0);
                }
            })());
        }
        await Promise.all(workers);
    }

    // Strip remote _rev before writing to local.
    const localDocs = docs.map((d) => stripRev(d) as CouchSyncDoc);

    await local.runWriteTx({
        docs: localDocs.map((doc) => ({ doc })),
    });
    let total = 0;
    for (const doc of localDocs) {
        total++;
        onProgress?.(doc._id, total);
    }
    return { written: total, docs };
}
