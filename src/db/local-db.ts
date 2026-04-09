// Use CJS entry directly — ESM entry's `export default` breaks in esbuild CJS output
import PouchDB from "pouchdb-browser/lib/index.js";
import type { CouchSyncDoc, FileDoc, ChunkDoc } from "../types.ts";
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

/**
 * Files that fileToDb() refused to push because they exceeded
 * `maxFileSizeMB`. Persisted so the settings tab can surface them and the
 * user can decide whether to raise the limit.
 */
export interface SkippedFilesDoc {
    files: Record<string, { sizeMB: number; skippedAt: number }>;
}

export class LocalDB {
    private db: PouchDB.Database<CouchSyncDoc> | null = null;
    private dbName: string;

    constructor(dbName: string) {
        this.dbName = dbName;
    }

    open(): PouchDB.Database<CouchSyncDoc> {
        if (this.db) return this.db;
        this.db = new PouchDB<CouchSyncDoc>(this.dbName, {
            auto_compaction: true,
            revs_limit: 20,
        });
        return this.db;
    }

    async close(): Promise<void> {
        if (this.db) {
            await this.db.close();
            this.db = null;
        }
    }

    getDb(): PouchDB.Database<CouchSyncDoc> {
        if (!this.db) throw new Error("Database not opened");
        return this.db;
    }

    /**
     * Probe for documents that don't conform to the current schema.
     * Returns the `_id` of the first offender, or null if the database
     * is empty / fully current. Used by plugin startup to gate the
     * replicator until the user rebuilds via Maintenance.
     *
     * Detection covers three schema breaks that were shipped together:
     *   - **Bare-path FileDoc** (pre ID-redesign): `_id` lacks the
     *     `file:` / `chunk:` / `config:` / `_` prefix entirely.
     *   - **Missing vclock** (pre Vector Clock): any FileDoc whose
     *     `vclock` is absent or empty.
     *   - **Legacy `binary` field** (pre all-binary ConfigDoc): any
     *     ConfigDoc still carrying the deprecated `binary` boolean.
     *
     * Cost: one allDocs() page; doc bodies only loaded when a
     * candidate id needs verification.
     */
    async findLegacyFileDoc(): Promise<string | null> {
        const idResult = await this.getDb().allDocs({ limit: 200 });
        for (const row of idResult.rows) {
            // PouchDB-reserved (_local, _design) — never legacy.
            if (row.id.startsWith("_")) continue;

            // Any replicated-space id without a known prefix is legacy.
            if (!isReplicatedDocId(row.id)) return row.id;

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

            if (isConfigDocId(row.id)) {
                try {
                    const doc = (await this.getDb().get(row.id)) as unknown as Record<string, unknown>;
                    if ("binary" in doc) return row.id;
                    return null;
                } catch {
                    continue;
                }
            }

            // Chunks don't carry schema-breaking fields today; skip.
            if (isChunkDocId(row.id)) continue;
        }
        return null;
    }

    async get<T extends CouchSyncDoc>(id: string): Promise<T | null> {
        try {
            return (await this.getDb().get(id)) as T;
        } catch (e: any) {
            if (e.status === 404) return null;
            throw e;
        }
    }

    async put(doc: CouchSyncDoc): Promise<PouchDB.Core.Response> {
        const existing = await this.get(doc._id);
        if (existing) {
            doc._rev = existing._rev;
        }
        return this.getDb().put(doc);
    }

    async bulkPut(docs: CouchSyncDoc[]): Promise<Array<PouchDB.Core.Response | PouchDB.Core.Error>> {
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
        return this.getDb().bulkDocs(docs);
    }

    async delete(id: string): Promise<void> {
        const doc = await this.get(id);
        if (doc && doc._rev) {
            await this.getDb().remove(id, doc._rev);
        }
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

    /**
     * Get a `_local/` doc. PouchDB's typed Database<CouchSyncDoc> rejects
     * local doc IDs that aren't in the union, so we route through the
     * untyped surface in one place.
     */
    private async localGet<T extends object>(id: string): Promise<(T & { _rev?: string }) | null> {
        try {
            return await (this.getDb() as PouchDB.Database<any>).get(id) as T & { _rev?: string };
        } catch (e: any) {
            if (e.status === 404) return null;
            throw e;
        }
    }

    private async localPut<T extends object>(id: string, body: T): Promise<void> {
        const existing = await this.localGet<T>(id);
        await (this.getDb() as PouchDB.Database<any>).put({
            ...body,
            _id: id,
            _rev: existing?._rev,
        });
    }

    async getScanCursor(): Promise<ScanCursor | null> {
        const doc = await this.localGet<ScanCursor>(SCAN_CURSOR_ID);
        if (!doc) return null;
        return {
            lastScanStartedAt: doc.lastScanStartedAt ?? 0,
            lastScanCompletedAt: doc.lastScanCompletedAt ?? 0,
            lastSeenUpdateSeq: doc.lastSeenUpdateSeq,
        };
    }

    async putScanCursor(cursor: ScanCursor): Promise<void> {
        await this.localPut(SCAN_CURSOR_ID, cursor);
    }

    async getVaultManifest(): Promise<VaultManifest | null> {
        const doc = await this.localGet<VaultManifest>(VAULT_MANIFEST_ID);
        if (!doc) return null;
        return {
            paths: doc.paths ?? [],
            updatedAt: doc.updatedAt ?? 0,
        };
    }

    async putVaultManifest(manifest: VaultManifest): Promise<void> {
        await this.localPut(VAULT_MANIFEST_ID, manifest);
    }

    async getSkippedFiles(): Promise<SkippedFilesDoc> {
        const doc = await this.localGet<SkippedFilesDoc>(SKIPPED_FILES_ID);
        return { files: doc?.files ?? {} };
    }

    async putSkippedFiles(doc: SkippedFilesDoc): Promise<void> {
        await this.localPut(SKIPPED_FILES_ID, doc);
    }

    async destroy(): Promise<void> {
        if (this.db) {
            await this.db.destroy();
            this.db = null;
        }
    }
}
