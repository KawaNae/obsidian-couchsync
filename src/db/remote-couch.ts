/**
 * Stateless helpers for one-shot remote CouchDB operations.
 *
 * Phase 2: rewritten from PouchDB replication to ICouchClient HTTP +
 * ILocalStore CRUD. Each function takes the appropriate abstraction
 * layer; production callers pass a CouchClient and LocalDB/ConfigLocalDB.
 *
 * The helpers remain stateless — construct, call, discard. Callers own
 * the lifecycle of both the local store and the remote client.
 */

import type { ICouchClient, ILocalStore } from "./interfaces.ts";
import type { CouchSyncDoc } from "../types.ts";

export type ProgressCallback = (docId: string, count: number) => void;

/**
 * Push specific documents from `local` to `remote`. Reads the docs
 * from the local store and writes them to the remote via _bulk_docs.
 * Returns the count of docs written. Skips work if the id list is empty.
 */
export async function pushDocs(
    local: ILocalStore<CouchSyncDoc>,
    remote: ICouchClient,
    docIds: string[],
    onProgress?: ProgressCallback,
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
            const { _rev, ...rest } = row.doc as any;
            docs.push(rest);
        }
    }
    if (docs.length === 0) return 0;

    // Fetch current remote revisions so we can include _rev for updates.
    const remoteResult = await remote.allDocs<CouchSyncDoc>({
        keys: docs.map((d) => d._id),
    });
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

    const results = await remote.bulkDocs(docs);
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
 */
export async function pullByPrefix(
    local: ILocalStore<CouchSyncDoc>,
    remote: ICouchClient,
    prefix: string,
): Promise<number> {
    const remoteResult = await remote.allDocs<CouchSyncDoc>({
        startkey: prefix,
        endkey: prefix + "\ufff0",
        include_docs: true,
    });

    const docs: CouchSyncDoc[] = [];
    for (const row of remoteResult.rows) {
        if (row.doc && !row.value?.deleted) {
            docs.push(row.doc);
        }
    }
    if (docs.length === 0) return 0;

    // Strip remote _rev before writing to local.
    const localDocs = docs.map((d) => {
        const { _rev, ...rest } = d as any;
        return rest as CouchSyncDoc;
    });

    const results = await local.bulkPut(localDocs);
    return results.filter((r) => r.ok).length;
}

/**
 * List remote document ids matching `prefix`. Lightweight — no doc
 * bodies loaded. Used by the Files-tab suggestion list and the
 * Maintenance migration helpers.
 */
export async function listRemoteByPrefix(
    remote: ICouchClient,
    prefix: string,
): Promise<string[]> {
    const result = await remote.allDocs<CouchSyncDoc>({
        startkey: prefix,
        endkey: prefix + "\ufff0",
    });
    return result.rows
        .filter((row) => !row.value?.deleted)
        .map((row) => row.id);
}

/** Destroy the remote database. Will be auto-recreated on the next push. */
export async function destroyRemote(
    remote: ICouchClient,
): Promise<void> {
    await remote.destroy();
}

/**
 * Push every doc in `local` to `remote` as a one-shot. Used by SetupService
 * during Init to seed the remote from a freshly-scanned vault.
 */
export async function pushAll(
    local: ILocalStore<CouchSyncDoc>,
    remote: ICouchClient,
    onProgress?: ProgressCallback,
): Promise<number> {
    const result = await local.allDocs({ include_docs: true });
    const docs: any[] = [];
    for (const row of result.rows) {
        if (row.doc && !row.value?.deleted) {
            const { _rev, ...rest } = row.doc as any;
            docs.push(rest);
        }
    }
    if (docs.length === 0) return 0;

    // Fetch current remote revisions for existing docs.
    const remoteResult = await remote.allDocs<CouchSyncDoc>({
        keys: docs.map((d) => d._id),
    });
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

    const results = await remote.bulkDocs(docs);
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
 * Pull every doc from `remote` into `local`. Returns both the written
 * count and the array of pulled documents (so callers can react to each,
 * e.g. SetupService writing files to the vault during Clone).
 */
export async function pullAll(
    local: ILocalStore<CouchSyncDoc>,
    remote: ICouchClient,
    onProgress?: ProgressCallback,
): Promise<{ written: number; docs: CouchSyncDoc[] }> {
    const remoteResult = await remote.allDocs<CouchSyncDoc>({
        include_docs: true,
    });

    const docs: CouchSyncDoc[] = [];
    for (const row of remoteResult.rows) {
        if (row.doc && !row.value?.deleted) {
            docs.push(row.doc);
        }
    }
    if (docs.length === 0) return { written: 0, docs: [] };

    // Strip remote _rev before writing to local.
    const localDocs = docs.map((d) => {
        const { _rev, ...rest } = d as any;
        return rest as CouchSyncDoc;
    });

    const results = await local.bulkPut(localDocs);
    let total = 0;
    for (const res of results) {
        if (res.ok) {
            total++;
            onProgress?.(res.id, total);
        }
    }
    return { written: total, docs };
}
