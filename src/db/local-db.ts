// Use CJS entry directly — ESM entry's `export default` breaks in esbuild CJS output
import PouchDB from "pouchdb-browser/lib/index.js";
import type { CouchSyncDoc, FileDoc, ChunkDoc } from "../types.ts";
import { DOC_PREFIX } from "../types.ts";

/** Local-only catch-up scan cursor (not replicated). */
export interface ScanCursor {
    lastScanStartedAt: number;
    lastScanCompletedAt: number;
}

const SCAN_CURSOR_ID = "_local/scan-cursor";

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
        return this.get<FileDoc>(path);
    }

    /** Bulk fetch FileDocs by path. Missing paths are absent from the map. */
    async getFileDocs(paths: string[]): Promise<Map<string, FileDoc>> {
        const result = new Map<string, FileDoc>();
        if (paths.length === 0) return result;
        const rows = await this.getDb().allDocs({ keys: paths, include_docs: true });
        for (const row of rows.rows) {
            if ("doc" in row && row.doc) {
                const doc = row.doc as unknown as CouchSyncDoc;
                if (doc.type === "file") result.set(doc._id, doc as FileDoc);
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
        // Phase 1: fetch IDs only (no doc bodies) — avoids loading chunk data
        const idResult = await this.getDb().allDocs();
        const fileIds = idResult.rows
            .filter((r) =>
                !r.id.startsWith(DOC_PREFIX.CHUNK) &&
                !r.id.startsWith(DOC_PREFIX.CONFIG) &&
                !r.id.startsWith("_"),
            )
            .map((r) => r.id);
        if (fileIds.length === 0) return [];

        // Phase 2: load only the file docs by key
        const docResult = await this.getDb().allDocs({ keys: fileIds, include_docs: true });
        const files: FileDoc[] = [];
        for (const row of docResult.rows) {
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
        };
    }

    async putScanCursor(cursor: ScanCursor): Promise<void> {
        await this.localPut(SCAN_CURSOR_ID, cursor);
    }

    async destroy(): Promise<void> {
        if (this.db) {
            await this.db.destroy();
            this.db = null;
        }
    }
}
