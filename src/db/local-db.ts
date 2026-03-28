// @ts-ignore - PouchDB is a UMD module
import PouchDB from "pouchdb-browser";
import type { CouchSyncDoc, FileDoc, ChunkDoc } from "../types.ts";

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
        const result = await this.getDb().allDocs({ include_docs: true });
        const files: FileDoc[] = [];
        for (const row of result.rows) {
            if ("doc" in row && row.doc) {
                const doc = row.doc as unknown as CouchSyncDoc;
                if (doc.type === "file") {
                    files.push(doc as FileDoc);
                }
            }
        }
        return files;
    }

    async destroy(): Promise<void> {
        if (this.db) {
            await this.db.destroy();
            this.db = null;
        }
    }
}
