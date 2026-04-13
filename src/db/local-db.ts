import type { CouchSyncDoc, FileDoc, ChunkDoc } from "../types.ts";
import type { ILocalStore, PutResponse, AllDocsOpts, AllDocsResult, LocalChangesResult } from "./interfaces.ts";
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
    /** Update seq seen at the end of the last scan. Reconciler uses
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
    private store: DexieStore<CouchSyncDoc> | null = null;
    private dbName: string;
    /** Dexie store for local metadata (scan cursor, vault manifest, etc.). */
    private metaStore: DexieStore<CouchSyncDoc> | null = null;

    constructor(dbName: string) {
        this.dbName = dbName;
    }

    open(): void {
        if (this.store) return;
        this.store = new DexieStore<CouchSyncDoc>(this.dbName);
        this.metaStore = new DexieStore<CouchSyncDoc>(`${this.dbName}-meta`);
    }

    async close(): Promise<void> {
        if (this.store) {
            await this.store.close();
            this.store = null;
        }
        if (this.metaStore) {
            await this.metaStore.close();
            this.metaStore = null;
        }
    }

    private getStore(): DexieStore<CouchSyncDoc> {
        if (!this.store) throw new Error("Database not opened");
        return this.store;
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
     */
    async findLegacyVaultDoc(): Promise<string | null> {
        const idResult = await this.getStore().allDocs({ limit: 200 });
        for (const row of idResult.rows) {
            if (row.id.startsWith("_")) continue;
            if (!isReplicatedDocId(row.id)) return row.id;
            if (isConfigDocId(row.id)) return row.id;
            if (isFileDocId(row.id)) {
                const doc = await this.getStore().get(row.id) as FileDoc | null;
                if (!doc || doc.type !== "file") continue;
                if (!doc.vclock || Object.keys(doc.vclock).length === 0) {
                    return row.id;
                }
                return null; // first valid FileDoc → schema is current
            }
            if (isChunkDocId(row.id)) continue;
        }
        return null;
    }

    /** @deprecated Use {@link findLegacyVaultDoc} instead. */
    async findLegacyFileDoc(): Promise<string | null> {
        return this.findLegacyVaultDoc();
    }

    /**
     * Delete every document with a given `_id` prefix from the vault DB.
     * Returns the IDs of the deleted documents.
     */
    async deleteAllByPrefix(prefix: string): Promise<string[]> {
        const result = await this.getStore().allDocs({
            startkey: prefix,
            endkey: prefix + "\ufff0",
        });
        if (result.rows.length === 0) return [];
        const ids = result.rows.map((row) => row.id);
        for (const id of ids) {
            await this.getStore().delete(id);
        }
        return ids;
    }

    async get<T extends CouchSyncDoc>(id: string): Promise<T | null> {
        return this.getStore().get(id) as Promise<T | null>;
    }

    async put(doc: CouchSyncDoc): Promise<PutResponse> {
        return this.getStore().put(doc);
    }

    async update<T extends CouchSyncDoc>(
        id: string,
        fn: (existing: T | null) => T | null,
        maxRetries = 3,
    ): Promise<PutResponse | null> {
        return this.getStore().update(id, fn, maxRetries);
    }

    async bulkPut(docs: CouchSyncDoc[]): Promise<PutResponse[]> {
        return this.getStore().bulkPut(docs);
    }

    /**
     * Atomically write chunks + a FileDoc in a single transaction.
     * See {@link DexieStore.atomicFileWrite} for details.
     */
    async atomicFileWrite(
        fileId: string,
        chunks: ChunkDoc[],
        buildDoc: (existing: FileDoc | null) => FileDoc | null,
    ): Promise<PutResponse | null> {
        return this.getStore().atomicFileWrite(fileId, chunks, buildDoc);
    }

    async delete(id: string): Promise<void> {
        return this.getStore().delete(id);
    }

    async allDocs(opts?: AllDocsOpts): Promise<AllDocsResult<CouchSyncDoc>> {
        return this.getStore().allDocs(opts);
    }

    async info(): Promise<{ updateSeq: number | string }> {
        return this.getStore().info();
    }

    async changes(
        since?: number | string,
        opts?: { include_docs?: boolean },
    ): Promise<LocalChangesResult<CouchSyncDoc>> {
        return this.getStore().changes(since, opts);
    }

    async getFileDoc(path: string): Promise<FileDoc | null> {
        return this.get<FileDoc>(makeFileId(path));
    }

    async getFileDocs(paths: string[]): Promise<Map<string, FileDoc>> {
        const result = new Map<string, FileDoc>();
        if (paths.length === 0) return result;
        const ids = paths.map((p) => makeFileId(p));
        const rows = await this.getStore().allDocs({
            keys: ids,
            include_docs: true,
        });
        for (let i = 0; i < rows.rows.length; i++) {
            const row = rows.rows[i];
            if (row.doc) {
                const doc = row.doc as unknown as CouchSyncDoc;
                if (doc.type === "file") result.set(paths[i], doc as FileDoc);
            }
        }
        return result;
    }

    async getChunks(chunkIds: string[]): Promise<ChunkDoc[]> {
        const result = await this.getStore().allDocs({
            keys: chunkIds,
            include_docs: true,
        });
        const chunks: ChunkDoc[] = [];
        for (const row of result.rows) {
            if (row.doc) {
                chunks.push(row.doc as unknown as ChunkDoc);
            }
        }
        return chunks;
    }

    async allFileDocs(): Promise<FileDoc[]> {
        const result = await this.getStore().allDocs({
            startkey: ID_RANGE.file.startkey,
            endkey: ID_RANGE.file.endkey,
            include_docs: true,
        });
        const files: FileDoc[] = [];
        for (const row of result.rows) {
            if (row.doc) {
                const doc = row.doc as unknown as CouchSyncDoc;
                if (doc.type === "file") files.push(doc as FileDoc);
            }
        }
        return files;
    }

    /** Delete all documents with given ID prefix. Returns deleted doc IDs. */
    async deleteByPrefix(prefix: string): Promise<string[]> {
        return this.deleteAllByPrefix(prefix);
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
        if (this.store) {
            await this.store.destroy();
            this.store = null;
        }
        if (this.metaStore) {
            await this.metaStore.destroy();
            this.metaStore = null;
        }
    }
}
