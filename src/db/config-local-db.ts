/**
 * ConfigLocalDB — local PouchDB store dedicated to ConfigDocs.
 *
 * v0.11.0 splits config storage out of the main vault DB. ConfigDocs now
 * live in a separate PouchDB instance (and a separate remote CouchDB),
 * which lets device pools (e.g. mobile vs desktop) maintain independent
 * `.obsidian/` configurations against the same shared vault.
 *
 * ## Why a thin wrapper instead of subclassing LocalDB?
 *
 * The two stores have very different surfaces:
 *   - LocalDB owns vault-specific things (allFileDocs, scanCursor,
 *     vaultManifest, skippedFiles, getChunks).
 *   - ConfigLocalDB needs only generic CRUD + range query for `config:`.
 *
 * Inheritance would force ConfigLocalDB to either inherit irrelevant
 * methods (vault manifest, etc.) or to override them as no-ops. A
 * brand-new class with a focused interface is cleaner.
 *
 * ## Lifecycle
 *
 * Unlike LocalDB which constructs its own PouchDB internally,
 * ConfigLocalDB receives a fully-constructed PouchDB instance via the
 * constructor. This makes it trivially testable (memory adapter in tests,
 * pouchdb-browser in production) and avoids dragging the
 * `pouchdb-browser` module-level import into this file. The owner
 * (typically `main.ts`) is responsible for `open / close / destroy`
 * on the underlying PouchDB instance.
 */

/// <reference types="pouchdb-browser" />
import type { ConfigDoc, CouchSyncDoc } from "../types.ts";
import type { ILocalStore, PutResponse, AllDocsOpts, AllDocsResult, LocalChangesResult } from "./interfaces.ts";
import { ID_RANGE, isConfigDocId } from "../types/doc-id.ts";

export class ConfigLocalDB implements ILocalStore<CouchSyncDoc> {
    constructor(private db: PouchDB.Database<CouchSyncDoc>) {}

    getDb(): PouchDB.Database<CouchSyncDoc> {
        return this.db;
    }

    async get(id: string): Promise<ConfigDoc | null> {
        try {
            return (await this.db.get(id)) as unknown as ConfigDoc;
        } catch (e: any) {
            if (e?.status === 404) return null;
            throw e;
        }
    }

    /**
     * Put a single ConfigDoc, transparently fetching the current rev so
     * the caller doesn't have to thread `_rev` through. Mirrors
     * `LocalDB.put` semantics.
     */
    async put(doc: CouchSyncDoc): Promise<PutResponse> {
        return this.db.put(doc);
    }

    async update<T extends CouchSyncDoc>(
        id: string,
        fn: (existing: T | null) => T | null,
        maxRetries = 3,
    ): Promise<PutResponse | null> {
        let lastErr: any;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const existing = await this.get(id) as T | null;
            const updated = fn(existing);
            if (!updated) return null;
            if (existing?._rev) updated._rev = existing._rev;
            try {
                return await this.db.put(updated as unknown as CouchSyncDoc);
            } catch (e: any) {
                lastErr = e;
                if (e?.status === 409 && attempt < maxRetries) continue;
                throw e;
            }
        }
        throw new Error(`update failed after ${maxRetries} retries for ${id}: status=${lastErr?.status}`);
    }

    /**
     * Bulk write of ConfigDocs. Fetches existing revs in one round-trip
     * via allDocs and threads them onto the input docs before bulkDocs.
     */
    async bulkPut(
        docs: CouchSyncDoc[],
    ): Promise<PutResponse[]> {
        if (docs.length === 0) return [];
        const ids = docs.map((d) => d._id);
        const existing = await this.db.allDocs({ keys: ids });
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
        const results = await this.db.bulkDocs(docs as unknown as CouchSyncDoc[]);
        const errors = results.filter(
            (r): r is { error: true; id: string; message: string } => "error" in r && !!(r as any).error
        );
        if (errors.length > 0) {
            const summary = errors
                .map((e) => `${(e as any).id ?? "?"}: ${e.message}`)
                .join("; ");
            throw new Error(`bulkPut partial failure (${errors.length}/${docs.length}): ${summary}`);
        }
        return results as PutResponse[];
    }

async allDocs(opts?: AllDocsOpts): Promise<AllDocsResult<CouchSyncDoc>> {
        const result = await this.db.allDocs(opts as any);
        return result as unknown as AllDocsResult<CouchSyncDoc>;
    }

    async info(): Promise<{ updateSeq: number | string }> {
        const dbInfo = await this.db.info();
        return { updateSeq: dbInfo.update_seq };
    }

    async close(): Promise<void> {
        await this.db.close();
    }

    async destroy(): Promise<void> {
        await this.db.destroy();
    }

    async delete(id: string): Promise<void> {
        try {
            const doc = await this.db.get(id);
            if (doc?._rev) await this.db.remove(id, doc._rev);
        } catch (e: any) {
            if (e?.status === 404) return;
            throw e;
        }
    }

    async changes(
        since?: number | string,
        opts?: { include_docs?: boolean },
    ): Promise<LocalChangesResult<CouchSyncDoc>> {
        const pouchOpts: PouchDB.Core.ChangesOptions = {
            since: since ?? 0,
            include_docs: opts?.include_docs ?? false,
        };
        const result = await this.db.changes(pouchOpts);
        return {
            results: result.results.map((r) => ({
                id: r.id,
                seq: r.seq,
                doc: opts?.include_docs ? (r.doc as unknown as CouchSyncDoc) : undefined,
                deleted: r.deleted,
            })),
            last_seq: result.last_seq,
        };
    }

    /**
     * Return every ConfigDoc in the store. Uses a `config:` range query
     * so we never touch any other id space (defence in depth — the DB
     * shouldn't contain non-config docs anyway, but if it does they're
     * filtered out here).
     */
    async allConfigDocs(): Promise<ConfigDoc[]> {
        const result = await this.db.allDocs({
            startkey: ID_RANGE.config.startkey,
            endkey: ID_RANGE.config.endkey,
            include_docs: true,
        });
        const docs: ConfigDoc[] = [];
        for (const row of result.rows) {
            if ("doc" in row && row.doc) {
                const d = row.doc as unknown as CouchSyncDoc;
                if (d.type === "config") docs.push(d as ConfigDoc);
            }
        }
        return docs;
    }

    /**
     * Mark all documents with the given ID prefix as deleted. Returns
     * the IDs of the deleted documents. Used by ConfigSync.init() to
     * clear the store before re-scanning.
     */
    async deleteByPrefix(prefix: string): Promise<string[]> {
        const result = await this.db.allDocs({
            startkey: prefix,
            endkey: prefix + "\ufff0",
        });
        if (result.rows.length === 0) return [];
        const deletions = result.rows.map((row) => ({
            _id: row.id,
            _rev: row.value.rev,
            _deleted: true,
        }));
        await this.db.bulkDocs(deletions as any);
        return result.rows.map((row) => row.id);
    }

    /**
     * Probe for documents that don't conform to the v0.11.0 ConfigDoc
     * schema. Returns the offending `_id`, or null if the store is
     * empty / fully current. Used by the startup schema guard to block
     * sync when migration is required.
     *
     * Detection covers:
     *   - Any non-`config:` doc accidentally living in this store
     *     (a config DB must contain ONLY config docs)
     *   - Any ConfigDoc whose `vclock` is missing or empty
     */
    async findLegacyConfigDoc(): Promise<string | null> {
        const result = await this.db.allDocs({ limit: 200 });
        for (const row of result.rows) {
            if (row.id.startsWith("_")) continue;
            if (!isConfigDocId(row.id)) {
                return row.id; // wrong-kind doc in config DB
            }
            try {
                const doc = (await this.db.get(row.id)) as unknown as ConfigDoc;
                if (!doc.vclock || Object.keys(doc.vclock).length === 0) {
                    return row.id;
                }
                return null; // first valid → schema is current
            } catch {
                continue;
            }
        }
        return null;
    }
}
