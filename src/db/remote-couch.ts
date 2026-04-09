/**
 * Stateless helpers for one-shot remote PouchDB operations.
 *
 * These used to be methods on `Replicator`, but live-sync state and the
 * generic push/pull/list operations have different lifetimes and (after
 * v0.11.0) potentially different remote DBs:
 *
 *   - The vault Replicator does live bidirectional sync with the vault DB.
 *   - ConfigSync does scan-based push/pull against a separate config DB.
 *
 * Mixing both responsibilities in one class meant ConfigSync was bound to
 * the vault DB's URL. Extracting these helpers gives ConfigSync the
 * freedom to point at any remote.
 *
 * Each function takes BOTH a local and remote PouchDB instance. Production
 * callers construct the remote with `new PouchDB(remoteUrl, ...)`; tests
 * pass memory-adapter instances directly. The helper does NOT close the
 * remote it received — that's the caller's choice (allows reuse across
 * multiple calls if desired). Functions that internally allocate a remote
 * via the URL overload close it themselves.
 */

/// <reference types="pouchdb-browser" />
// Triple-slash reference pulls in the global `PouchDB` namespace types
// without any runtime import — `pouchdb-browser/lib/index.js` references
// `self` at module init and would break node-only tests if imported.
// All actual PouchDB instances are constructed by callers and passed in.
import type { CouchSyncDoc } from "../types.ts";

export type ProgressCallback = (docId: string, count: number) => void;

/**
 * Push specific documents from `local` to `remote`. Skips work if the
 * id list is empty. Returns the count of docs written.
 */
export async function pushDocs(
    local: PouchDB.Database<CouchSyncDoc>,
    remote: PouchDB.Database<CouchSyncDoc>,
    docIds: string[],
    onProgress?: ProgressCallback,
): Promise<number> {
    if (docIds.length === 0) return 0;
    let total = 0;
    return new Promise<number>((resolve, reject) => {
        const replication = local.replicate.to(remote, {
            doc_ids: docIds,
        } as any);
        replication.on("change", (info) => {
            if (info.docs) {
                for (const doc of info.docs) {
                    total++;
                    onProgress?.(doc._id, total);
                }
            }
        });
        replication.on("complete", (info) => {
            resolve(info.docs_written);
        });
        replication.on("error", (err) => {
            reject(err);
        });
    });
}

/**
 * Pull every doc whose `_id` matches `prefix` from `remote` to `local`.
 * Used by ConfigSync to fetch all `config:*` docs without touching
 * file/chunk space. Returns the count of docs written locally.
 */
export async function pullByPrefix(
    local: PouchDB.Database<CouchSyncDoc>,
    remote: PouchDB.Database<CouchSyncDoc>,
    prefix: string,
): Promise<number> {
    const result = await remote.allDocs({
        startkey: prefix,
        endkey: prefix + "\ufff0",
    });
    const docIds = result.rows.map((row) => row.id);
    if (docIds.length === 0) return 0;

    return new Promise<number>((resolve, reject) => {
        const replication = local.replicate.from(remote, {
            doc_ids: docIds,
        } as any);
        replication.on("complete", (info) => {
            resolve(info.docs_written);
        });
        replication.on("error", (err) => {
            reject(err);
        });
    });
}

/**
 * List remote document ids matching `prefix`. Lightweight — no doc
 * bodies loaded. Used by the Files-tab suggestion list and the
 * Maintenance migration helpers.
 */
export async function listRemoteByPrefix(
    remote: PouchDB.Database<CouchSyncDoc>,
    prefix: string,
): Promise<string[]> {
    const result = await remote.allDocs({
        startkey: prefix,
        endkey: prefix + "\ufff0",
    });
    return result.rows.map((row) => row.id);
}

/** Destroy the remote database. Will be auto-recreated on the next push. */
export async function destroyRemote(
    remote: PouchDB.Database<CouchSyncDoc>,
): Promise<void> {
    await remote.destroy();
}

/**
 * Push every doc in `local` to `remote` as a one-shot. Used by SetupService
 * during Init to seed the remote from a freshly-scanned vault.
 */
export async function pushAll(
    local: PouchDB.Database<CouchSyncDoc>,
    remote: PouchDB.Database<CouchSyncDoc>,
    onProgress?: ProgressCallback,
): Promise<number> {
    let total = 0;
    return new Promise<number>((resolve, reject) => {
        const replication = local.replicate.to(remote, { batch_size: 100 });
        replication.on("change", (info) => {
            if (info.docs) {
                for (const doc of info.docs) {
                    total++;
                    onProgress?.(doc._id, total);
                }
            }
        });
        replication.on("complete", (info) => {
            resolve(info.docs_written);
        });
        replication.on("error", (err) => {
            reject(err);
        });
    });
}

/**
 * Pull every doc from `remote` to `local`. Returns both the written count
 * and the array of pulled documents (so callers can react to each, e.g.
 * SetupService writing files to the vault during Clone).
 */
export async function pullAll(
    local: PouchDB.Database<CouchSyncDoc>,
    remote: PouchDB.Database<CouchSyncDoc>,
    onProgress?: ProgressCallback,
): Promise<{ written: number; docs: CouchSyncDoc[] }> {
    let total = 0;
    const docs: CouchSyncDoc[] = [];
    return new Promise((resolve, reject) => {
        const replication = local.replicate.from(remote, { batch_size: 100 });
        replication.on("change", (info) => {
            if (info.docs) {
                for (const doc of info.docs) {
                    total++;
                    docs.push(doc as unknown as CouchSyncDoc);
                    onProgress?.(doc._id, total);
                }
            }
        });
        replication.on("complete", (info) => {
            resolve({ written: info.docs_written, docs });
        });
        replication.on("error", (err) => {
            reject(err);
        });
    });
}
