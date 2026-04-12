// Use CJS entry directly — ESM entry's `export default` breaks in esbuild CJS output
import PouchDB from "pouchdb-browser/lib/index.js";
import type { CouchSyncDoc, FileDoc, ChunkDoc } from "../types.ts";
import type { ILocalStore, PutResponse, AllDocsOpts, AllDocsResult } from "./interfaces.ts";
import { DexieStore, SyncDB } from "./dexie-store.ts";
import {
    ID_RANGE,
    makeFileId,
    isFileDocId,
    isChunkDocId,
    isConfigDocId,
    isReplicatedDocId,
} from "../types/doc-id.ts";

/** Local-only catch-up scan cursor (not replicated). */
export interface ScanCursor {
    lastScanStartedAt: number;
    lastScanCompletedAt: number;
    /** PouchDB update_seq seen at the end of the last scan. Reconciler uses
     *  this for an O(1) "did anything change in the DB?" check. */
    lastSeenUpdateSeq?: string | number;
}

/**
 * Snapshot of vault file paths this device has seen. Compared against the
 * current vault state during reconcile() to distinguish "deleted on this
 * device" from "newly arrived from another device".
 */
export interface VaultManifest {
    paths: string[];
    updatedAt: number;
}

const SCAN_CURSOR_ID = "_local/scan-cursor";
const VAULT_MANIFEST_ID = "_local/vault-manifest";
const SKIPPED_FILES_ID = "_local/skipped-files";
const LAST_SYNCED_VCLOCKS_ID = "_local/last-synced-vclocks";

/**
 * Files that fileToDb() refused to push because they exceeded
 * `maxFileSizeMB`. Persisted so the settings tab can surface them and the
 * user can decide whether to raise the limit.
 */
export interface SkippedFilesDoc {
    files: Record<string, { sizeMB: number; skippedAt: number }>;
}

export class LocalDB implements ILocalStore<CouchSyncDoc> {
    private db: PouchDB.Database<CouchSyncDoc> | null = null;
    private dbName: string;
    /** Dexie store for local metadata (scan cursor, vault manifest, etc.).
     *  Non-replicated `_local/*` docs migrated here in Phase 1. Full doc
     *  storage migrates in Phase 3 when the sync engine is also replaced. */
    private metaStore: DexieStore<CouchSyncDoc> | null = null;

    constructor(dbName: string) {
        this.dbName = dbName;
    }

    open(): PouchDB.Database<CouchSyncDoc> {
        if (this.db) return this.db;
        this.db = new PouchDB<CouchSyncDoc>(this.dbName, {
            auto_compaction: true,
            revs_limit: 20,
        });
        this.metaStore = new DexieStore<CouchSyncDoc>(`${this.dbName}-meta`);
        return this.db;
    }

    async close(): Promise<void> {
        if (this.db) {
            await this.db.close();
            this.db = null;
        }
        if (this.metaStore) {
            await this.metaStore.close();
            this.metaStore = null;
        }
    }

    getDb(): PouchDB.Database<CouchSyncDoc> {
        if (!this.db) throw new Error("Database not opened");
        return this.db;
    }

    /** Expose the Dexie meta store for migration and testing. */
    getMetaStore(): DexieStore<CouchSyncDoc> {
        if (!this.metaStore) throw new Error("Database not opened");
        return this.metaStore;
    }

    /**
     * Probe the **vault** database for non-conforming documents. Returns
     * the `_id` of the first offender, or null if the store is empty /
     * fully current. Used by plugin startup to gate the replicator until
     * the user rebuilds via Maintenance.
     *
     * In v0.11.0+ the vault DB is supposed to contain ONLY file:/chunk:/_
     * documents. ConfigDocs migrated to a separate database. Detection:
     *   - **Bare-path doc** (pre ID-redesign): `_id` lacks any known prefix
     *   - **`config:*` orphan** (pre config-DB-split): any ConfigDoc still
     *     living in the vault DB — these need to be migrated and cleaned
     *     up via the Maintenance "Clean up legacy configs" button
     *   - **FileDoc missing vclock** (pre Vector Clock)
     */
    async findLegacyVaultDoc(): Promise<string | null> {
        const idResult = await this.getDb().allDocs({ limit: 200 });
        for (const row of idResult.rows) {
            // PouchDB-reserved (_local, _design) — never legacy.
            if (row.id.startsWith("_")) continue;

            // Any replicated-space id without a known prefix is legacy.
            if (!isReplicatedDocId(row.id)) return row.id;

            // ConfigDocs do not belong in the vault DB anymore (v0.11.0+).
            if (isConfigDocId(row.id)) return row.id;

            if (isFileDocId(row.id)) {
                try {
                    const doc = (await this.getDb().get(row.id)) as unknown as FileDoc;
                    if (doc.type !== "file") continue;
                    if (!doc.vclock || Object.keys(doc.vclock).length === 0) {
                        return row.id;
                    }
                    return null; // first valid FileDoc → schema is current
                } catch {
                    continue;
                }
            }

            // Chunks don't carry schema-breaking fields today; skip.
            if (isChunkDocId(row.id)) continue;
        }
        return null;
    }

    /**
     * @deprecated Renamed to {@link findLegacyVaultDoc} in v0.11.0 — kept
     * as a thin alias so any external caller (or stale doc) doesn't
     * silently break. New code should call findLegacyVaultDoc directly.
     */
    async findLegacyFileDoc(): Promise<string | null> {
        return this.findLegacyVaultDoc();
    }

    /**
     * Delete every document with a given `_id` prefix from the vault DB.
     * Used by Maintenance "Clean up legacy configs from vault DB" to
     * remove `config:*` orphans after the v0.11.0 migration.
     *
     * Returns the IDs of the deleted documents (handy for telling the
     * user how many were affected). Replication will propagate the
     * tombstones to the remote vault DB on the next sync cycle.
     */
    async deleteAllByPrefix(prefix: string): Promise<string[]> {
        const result = await this.getDb().allDocs({
            startkey: prefix,
            endkey: prefix + "\ufff0",
        });
        if (result.rows.length === 0) return [];
        const tombstones = result.rows.map((row) => ({
            _id: row.id,
            _rev: row.value.rev,
            _deleted: true,
        }));
        await this.getDb().bulkDocs(tombstones as any);
        return result.rows.map((row) => row.id);
    }

    async get<T extends CouchSyncDoc>(id: string): Promise<T | null> {
        try {
            return (await this.getDb().get(id)) as T;
        } catch (e: any) {
            if (e.status === 404) return null;
            throw e;
        }
    }

    async put(doc: CouchSyncDoc): Promise<PutResponse> {
        return this.getDb().put(doc);
    }

    /**
     * CAS read-modify-write: reads the current doc, passes it to `fn`,
     * and writes the result. On 409 (rev conflict from a concurrent
     * replication update), re-reads and retries so the caller's vclock
     * computation always uses a fresh base.
     *
     * `fn` receives `null` for new docs. Return `null` to skip the write.
     */
    async update<T extends CouchSyncDoc>(
        id: string,
        fn: (existing: T | null) => T | null,
        maxRetries = 3,
    ): Promise<PutResponse | null> {
        let lastErr: any;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const existing = await this.get<T>(id);
            const updated = fn(existing);
            if (!updated) return null;
            if (existing?._rev) updated._rev = existing._rev;
            try {
                return await this.getDb().put(updated);
            } catch (e: any) {
                lastErr = e;
                if (e?.status === 409 && attempt < maxRetries) continue;
                throw e;
            }
        }
        throw new Error(`update failed after ${maxRetries} retries for ${id}: status=${lastErr?.status}`);
    }

    async bulkPut(docs: CouchSyncDoc[]): Promise<PutResponse[]> {
        const ids = docs.map((d) => d._id);
        const existing = await this.getDb().allDocs({ keys: ids });
        const revMap = new Map<string, string>();
        for (const row of existing.rows) {
            if ("value" in row && row.value && !("deleted" in row.value)) {
                revMap.set(row.id, row.value.rev);
            }
        }
        for (const doc of docs) {
            const rev = revMap.get(doc._id);
            if (rev) doc._rev = rev;
        }
        const results = await this.getDb().bulkDocs(docs);
        const errors = results.filter(
            (r, i): r is PouchDB.Core.Error => {
                if (!("error" in r && r.error)) return false;
                if ((r as any).status === 409 && docs[i].type === "chunk") return false;
                return true;
            }
        );
        if (errors.length > 0) {
            const summary = errors
                .map((e) => `${(e as any).id ?? "?"}: ${e.message}`)
                .join("; ");
            throw new Error(`bulkPut partial failure (${errors.length}/${docs.length}): ${summary}`);
        }
        return results as PutResponse[];
    }

    async delete(id: string): Promise<void> {
        const doc = await this.get(id);
        if (doc && doc._rev) {
            await this.getDb().remove(id, doc._rev);
        }
    }

    /** Fetch a specific revision. Used by ConflictResolver; removed in Phase 2. */
    async getByRev<T extends CouchSyncDoc>(id: string, rev: string): Promise<T | null> {
        try {
            return (await this.getDb().get(id, { rev })) as unknown as T;
        } catch (e: any) {
            if (e.status === 404) return null;
            throw e;
        }
    }

    /** Remove a specific revision. Used by ConflictResolver; removed in Phase 2. */
    async removeRev(id: string, rev: string): Promise<void> {
        await this.getDb().remove(id, rev);
    }

    async allDocs(opts?: AllDocsOpts): Promise<AllDocsResult<CouchSyncDoc>> {
        const result = await this.getDb().allDocs(opts as any);
        return result as unknown as AllDocsResult<CouchSyncDoc>;
    }

    async info(): Promise<{ updateSeq: number | string }> {
        const dbInfo = await this.getDb().info();
        return { updateSeq: dbInfo.update_seq };
    }

    async getFileDoc(path: string): Promise<FileDoc | null> {
        return this.get<FileDoc>(makeFileId(path));
    }

    /** Bulk fetch FileDocs by path. Missing paths are absent from the map.
     *
     *  Returns a map keyed by **vault path** (not doc `_id`) so callers
     *  can look up by the natural identifier.
     */
    async getFileDocs(paths: string[]): Promise<Map<string, FileDoc>> {
        const result = new Map<string, FileDoc>();
        if (paths.length === 0) return result;
        const ids = paths.map((p) => makeFileId(p));
        const rows = await this.getDb().allDocs({ keys: ids, include_docs: true });
        for (let i = 0; i < rows.rows.length; i++) {
            const row = rows.rows[i];
            if ("doc" in row && row.doc) {
                const doc = row.doc as unknown as CouchSyncDoc;
                if (doc.type === "file") result.set(paths[i], doc as FileDoc);
            }
        }
        return result;
    }

    async getChunks(chunkIds: string[]): Promise<ChunkDoc[]> {
        const result = await this.getDb().allDocs({
            keys: chunkIds,
            include_docs: true,
        });
        const chunks: ChunkDoc[] = [];
        for (const row of result.rows) {
            if ("doc" in row && row.doc) {
                chunks.push(row.doc as unknown as ChunkDoc);
            }
        }
        return chunks;
    }

    async allFileDocs(): Promise<FileDoc[]> {
        // Single range query — no two-phase scan now that FileDoc has
        // a "file:" prefix and is disjoint from chunks/config/_local.
        const result = await this.getDb().allDocs({
            startkey: ID_RANGE.file.startkey,
            endkey: ID_RANGE.file.endkey,
            include_docs: true,
        });
        const files: FileDoc[] = [];
        for (const row of result.rows) {
            if ("doc" in row && row.doc) {
                const doc = row.doc as unknown as CouchSyncDoc;
                if (doc.type === "file") files.push(doc as FileDoc);
            }
        }
        return files;
    }

    /** Mark all documents with given ID prefix as deleted. Returns deleted doc IDs. */
    async deleteByPrefix(prefix: string): Promise<string[]> {
        const result = await this.getDb().allDocs({
            startkey: prefix,
            endkey: prefix + "\ufff0",
        });
        if (result.rows.length === 0) return [];

        const deletions = result.rows.map((row) => ({
            _id: row.id,
            _rev: row.value.rev,
            _deleted: true,
        }));
        await this.getDb().bulkDocs(deletions as any);
        return result.rows.map((row) => row.id);
    }

    // ── Metadata (Dexie meta table) ────────────────────

    async getScanCursor(): Promise<ScanCursor | null> {
        const meta = this.getMetaStore();
        const doc = await meta.getMeta<ScanCursor>(SCAN_CURSOR_ID);
        if (!doc) return null;
        return {
            lastScanStartedAt: doc.lastScanStartedAt ?? 0,
            lastScanCompletedAt: doc.lastScanCompletedAt ?? 0,
            lastSeenUpdateSeq: doc.lastSeenUpdateSeq,
        };
    }

    async putScanCursor(cursor: ScanCursor): Promise<void> {
        await this.getMetaStore().putMeta(SCAN_CURSOR_ID, cursor);
    }

    async getVaultManifest(): Promise<VaultManifest | null> {
        const doc = await this.getMetaStore().getMeta<VaultManifest>(VAULT_MANIFEST_ID);
        if (!doc) return null;
        return {
            paths: doc.paths ?? [],
            updatedAt: doc.updatedAt ?? 0,
        };
    }

    async putVaultManifest(manifest: VaultManifest): Promise<void> {
        await this.getMetaStore().putMeta(VAULT_MANIFEST_ID, manifest);
    }

    async getSkippedFiles(): Promise<SkippedFilesDoc> {
        const doc = await this.getMetaStore().getMeta<SkippedFilesDoc>(SKIPPED_FILES_ID);
        return { files: doc?.files ?? {} };
    }

    async putSkippedFiles(doc: SkippedFilesDoc): Promise<void> {
        await this.getMetaStore().putMeta(SKIPPED_FILES_ID, doc);
    }

    async getLastSyncedVclocks(): Promise<Record<string, Record<string, number>> | null> {
        const doc = await this.getMetaStore().getMeta<{ clocks: Record<string, Record<string, number>> }>(LAST_SYNCED_VCLOCKS_ID);
        return doc?.clocks ?? null;
    }

    async putLastSyncedVclocks(clocks: Record<string, Record<string, number>>): Promise<void> {
        await this.getMetaStore().putMeta(LAST_SYNCED_VCLOCKS_ID, { clocks });
    }

    async destroy(): Promise<void> {
        if (this.db) {
            await this.db.destroy();
            this.db = null;
        }
        if (this.metaStore) {
            await this.metaStore.destroy();
            this.metaStore = null;
        }
    }
}
