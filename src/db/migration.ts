/**
 * PouchDB → Dexie one-time migration.
 *
 * On plugin startup, detects whether a PouchDB IndexedDB exists for the
 * vault. If it does and the Dexie store is empty, migrates all documents
 * in batches. `_local/*` metadata docs are stored in Dexie's `meta` table.
 *
 * The PouchDB IndexedDB is left intact for one release cycle (safety net).
 * After the next version, `cleanupPouchDB()` can delete it.
 *
 * This module is used in Phase 3 when LocalDB switches to DexieStore.
 * It's created and tested in Phase 1 so it's ready when needed.
 */

import type { DexieStore } from "./dexie-store.ts";

/** Batch size for migrating docs. */
const MIGRATION_BATCH = 1000;

/** Well-known _local doc IDs that carry metadata to the meta table. */
const LOCAL_META_KEYS: Record<string, string> = {
    "_local/scan-cursor": "scan-cursor",
    "_local/vault-manifest": "vault-manifest",
    "_local/skipped-files": "skipped-files",
    "_local/last-synced-vclocks": "last-synced-vclocks",
};

export interface MigrationProgress {
    phase: "checking" | "migrating" | "meta" | "done";
    current: number;
    total: number;
}

export type OnProgress = (progress: MigrationProgress) => void;

export interface MigrationResult {
    migrated: boolean;
    docCount: number;
    metaCount: number;
}

/**
 * Check whether a PouchDB IndexedDB database exists.
 * PouchDB uses `_pouch_<name>` as its IndexedDB name.
 */
export async function pouchDBExists(dbName: string): Promise<boolean> {
    if (typeof indexedDB === "undefined") return false;
    try {
        const dbs = await indexedDB.databases();
        return dbs.some((db) => db.name === `_pouch_${dbName}`);
    } catch {
        // indexedDB.databases() is not available in all browsers
        // Fall back to attempting to open
        return new Promise<boolean>((resolve) => {
            const req = indexedDB.open(`_pouch_${dbName}`);
            req.onsuccess = () => {
                const db = req.result;
                const hasStores = db.objectStoreNames.length > 0;
                db.close();
                if (!hasStores) {
                    // Empty DB — PouchDB never wrote to it
                    indexedDB.deleteDatabase(`_pouch_${dbName}`);
                }
                resolve(hasStores);
            };
            req.onerror = () => resolve(false);
        });
    }
}

/**
 * Migrate documents from a PouchDB instance to a DexieStore.
 *
 * @param pouchDb - An opened PouchDB instance (caller is responsible for
 *   constructing and closing it).
 * @param dexieStore - The target DexieStore.
 * @param onProgress - Optional progress callback.
 * @returns Migration result with counts.
 */
export async function migratePouchToDexie<T extends { _id: string; _rev?: string }>(
    pouchDb: PouchDB.Database,
    dexieStore: DexieStore<T>,
    onProgress?: OnProgress,
): Promise<MigrationResult> {
    onProgress?.({ phase: "checking", current: 0, total: 0 });

    // Check if Dexie already has docs (migration already done)
    const dexieInfo = await dexieStore.info();
    const dexieCount = await dexieStore.getDexie().docs.count();
    if (dexieCount > 0) {
        onProgress?.({ phase: "done", current: 0, total: 0 });
        return { migrated: false, docCount: 0, metaCount: 0 };
    }

    // Get total doc count from PouchDB
    const pouchInfo = await pouchDb.info();
    const totalDocs = pouchInfo.doc_count;

    if (totalDocs === 0) {
        onProgress?.({ phase: "done", current: 0, total: 0 });
        return { migrated: false, docCount: 0, metaCount: 0 };
    }

    // Migrate docs in batches
    let docCount = 0;
    let startkey: string | undefined = undefined;
    onProgress?.({ phase: "migrating", current: 0, total: totalDocs });

    while (true) {
        const opts: Record<string, any> = {
            include_docs: true,
            limit: MIGRATION_BATCH,
        };
        if (startkey) {
            opts.startkey = startkey;
            opts.skip = 1; // skip the doc we already processed
        }

        const result = await pouchDb.allDocs(opts);
        if (result.rows.length === 0) break;

        const docsToWrite: T[] = [];
        for (const row of result.rows) {
            if (!row.doc) continue;
            // Strip PouchDB internal fields
            const { _rev, _conflicts, ...body } = row.doc as any;
            docsToWrite.push(body as T);
        }

        if (docsToWrite.length > 0) {
            await dexieStore.bulkPut(docsToWrite);
            docCount += docsToWrite.length;
        }

        onProgress?.({ phase: "migrating", current: docCount, total: totalDocs });
        startkey = result.rows[result.rows.length - 1].id;

        if (result.rows.length < MIGRATION_BATCH) break;
    }

    // Migrate _local/* metadata docs to meta table
    let metaCount = 0;
    onProgress?.({ phase: "meta", current: 0, total: Object.keys(LOCAL_META_KEYS).length });

    for (const [pouchId, metaKey] of Object.entries(LOCAL_META_KEYS)) {
        try {
            const doc = await pouchDb.get(pouchId);
            if (doc) {
                // Strip PouchDB fields, keep only the data
                const { _id, _rev, ...data } = doc as any;
                await dexieStore.putMeta(metaKey, data);
                metaCount++;
            }
        } catch (e: any) {
            // 404 is expected for missing _local docs
            if (e?.status !== 404) {
                console.warn(`CouchSync migration: failed to read ${pouchId}:`, e);
            }
        }
    }

    onProgress?.({ phase: "done", current: docCount, total: totalDocs });

    return { migrated: true, docCount, metaCount };
}

/**
 * Delete the PouchDB IndexedDB database. Call this one release cycle
 * after migration to free disk space.
 */
export async function cleanupPouchDB(dbName: string): Promise<void> {
    if (typeof indexedDB === "undefined") return;
    return new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase(`_pouch_${dbName}`);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}
