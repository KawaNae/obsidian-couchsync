/**
 * ConfigLocalDB — DexieStore-backed local store dedicated to ConfigDocs.
 *
 * v0.11.0 splits config storage out of the main vault DB. ConfigDocs now
 * live in a separate store (and a separate remote CouchDB), which lets
 * device pools (e.g. mobile vs desktop) maintain independent `.obsidian/`
 * configurations against the same shared vault.
 */

import type { ConfigDoc, CouchSyncDoc } from "../types.ts";
import type { ILocalStore, PutResponse, AllDocsOpts, AllDocsResult, LocalChangesResult } from "./interfaces.ts";
import type { DexieStore } from "./dexie-store.ts";
import type { WriteTransaction, WriteBuilder } from "./write-transaction.ts";
import { ID_RANGE, isConfigDocId } from "../types/doc-id.ts";

export class ConfigLocalDB implements ILocalStore<CouchSyncDoc> {
    constructor(private store: DexieStore<CouchSyncDoc>) {}

    async get(id: string): Promise<ConfigDoc | null> {
        return this.store.get(id) as Promise<ConfigDoc | null>;
    }

    async put(doc: CouchSyncDoc): Promise<PutResponse> {
        return this.store.put(doc);
    }

    async update<T extends CouchSyncDoc>(
        id: string,
        fn: (existing: T | null) => T | null,
        maxRetries = 3,
    ): Promise<PutResponse | null> {
        return this.store.update(id, fn, maxRetries);
    }

    async bulkPut(docs: CouchSyncDoc[]): Promise<PutResponse[]> {
        return this.store.bulkPut(docs);
    }

    /**
     * Atomic compound write. Mirrors `LocalDB.runWrite` overloads so
     * config-sync and remote-couch can target either store uniformly.
     */
    runWrite(
        builder: WriteBuilder<CouchSyncDoc>,
        opts?: { maxAttempts?: number },
    ): Promise<boolean>;
    runWrite(tx: WriteTransaction<CouchSyncDoc>): Promise<void>;
    runWrite(
        arg: WriteBuilder<CouchSyncDoc> | WriteTransaction<CouchSyncDoc>,
        opts?: { maxAttempts?: number },
    ): Promise<void | boolean> {
        return (this.store.runWrite as any)(arg, opts);
    }

    async allDocs(opts?: AllDocsOpts): Promise<AllDocsResult<CouchSyncDoc>> {
        return this.store.allDocs(opts);
    }

    async info(): Promise<{ updateSeq: number | string }> {
        return this.store.info();
    }

    async close(): Promise<void> {
        await this.store.close();
    }

    async destroy(): Promise<void> {
        await this.store.destroy();
    }

    async delete(id: string): Promise<void> {
        return this.store.delete(id);
    }

    async changes(
        since?: number | string,
        opts?: { include_docs?: boolean },
    ): Promise<LocalChangesResult<CouchSyncDoc>> {
        return this.store.changes(since, opts);
    }

    /**
     * Return every ConfigDoc in the store. Uses a `config:` range query.
     */
    async allConfigDocs(): Promise<ConfigDoc[]> {
        const result = await this.store.allDocs({
            startkey: ID_RANGE.config.startkey,
            endkey: ID_RANGE.config.endkey,
            include_docs: true,
        });
        const docs: ConfigDoc[] = [];
        for (const row of result.rows) {
            if (row.doc) {
                const d = row.doc as unknown as CouchSyncDoc;
                if (d.type === "config") docs.push(d as ConfigDoc);
            }
        }
        return docs;
    }

    /**
     * Delete all documents with the given ID prefix. Returns deleted IDs.
     */
    async deleteByPrefix(prefix: string): Promise<string[]> {
        const result = await this.store.allDocs({
            startkey: prefix,
            endkey: prefix + "\ufff0",
        });
        if (result.rows.length === 0) return [];
        const ids = result.rows.map((row) => row.id);
        for (const id of ids) {
            await this.store.delete(id);
        }
        return ids;
    }

    /**
     * Probe for documents that don't conform to the v0.11.0 ConfigDoc
     * schema. Returns the offending `_id`, or null if the store is
     * empty / fully current.
     */
    async findLegacyConfigDoc(): Promise<string | null> {
        const result = await this.store.allDocs({ limit: 200 });
        for (const row of result.rows) {
            if (row.id.startsWith("_")) continue;
            if (!isConfigDocId(row.id)) {
                return row.id;
            }
            const doc = await this.store.get(row.id) as ConfigDoc | null;
            if (!doc) continue;
            if (!doc.vclock || Object.keys(doc.vclock).length === 0) {
                return row.id;
            }
            return null; // first valid → schema is current
        }
        return null;
    }
}
