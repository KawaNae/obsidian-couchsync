/**
 * DexieStore — Dexie-based ILocalStore implementation.
 *
 * Phase 1 of the PouchDB removal plan. This module is a complete,
 * standalone ILocalStore that stores documents in Dexie (IndexedDB).
 * It will replace PouchDB as the local storage backend in Phase 3
 * when the sync engine is also replaced.
 *
 * Key differences from the PouchDB-based LocalDB:
 *   - `_rev` is replaced by `_version` (integer CAS counter).
 *     PutResponse.rev is synthesized as `"${_version}-dexie"`.
 *   - No revision tree, no conflict tree. CAS via _version check.
 *   - No `getByRev` / `removeRev` — removed in Phase 2.
 */

import Dexie, { type Table } from "dexie";
import type {
    ILocalStore,
    PutResponse,
    AllDocsOpts,
    AllDocsResult,
    AllDocsRow,
    LocalChangesResult,
} from "./interfaces.ts";

// ── Stored document shape ───────────────────────────────

/** Internal wrapper: the raw doc plus a CAS version counter. */
export interface StoredDoc {
    /** Document ID — Dexie primary key. */
    _id: string;
    /** CAS version counter. Incremented on every write. */
    _version: number;
    /** Monotonic local sequence number for change tracking. Set on every
     *  write via `_bumpSeq()`. SyncEngine's push loop queries docs with
     *  `_localSeq > lastPushedSeq` to find unpushed changes. */
    _localSeq?: number;
    /** The document body (everything except _id/_rev/_version). */
    [key: string]: any;
}

/** Key-value metadata row (scan cursor, vault manifest, etc.). */
export interface LocalMeta {
    key: string;
    value: any;
}

// ── Dexie database schema ───────────────────────────────

export class SyncDB extends Dexie {
    docs!: Table<StoredDoc, string>;
    meta!: Table<LocalMeta, string>;

    constructor(name: string) {
        super(name);
        this.version(1).stores({
            docs: "_id, type",
            meta: "key",
        });
        // v2: add _localSeq index for change tracking (SyncEngine push loop).
        this.version(2).stores({
            docs: "_id, type, _localSeq",
            meta: "key",
        });
    }
}

// ── Helpers ─────────────────────────────────────────────

function makeRev(version: number): string {
    return `${version}-dexie`;
}

function stripInternal<T>(stored: StoredDoc): T {
    const { _version, ...doc } = stored;
    // Synthesize _rev from _version for consumers that expect it
    return { ...doc, _rev: makeRev(_version) } as unknown as T;
}

/** Conflict error matching PouchDB's 409 shape. */
function conflict409(id: string): Error {
    const err = new Error(`Document update conflict: ${id}`) as any;
    err.status = 409;
    err.name = "conflict";
    return err;
}

// ── DexieStore ──────────────────────────────────────────

export class DexieStore<T extends { _id: string; _rev?: string } = any>
    implements ILocalStore<T>
{
    private db: SyncDB;
    private _closed = false;

    constructor(dbName: string);
    constructor(db: SyncDB);
    constructor(arg: string | SyncDB) {
        if (typeof arg === "string") {
            this.db = new SyncDB(arg);
        } else {
            this.db = arg;
        }
    }

    /** Expose the underlying Dexie instance (for migration, testing). */
    getDexie(): SyncDB {
        return this.db;
    }

    // ── ILocalStore implementation ──────────────────────

    async get(id: string): Promise<T | null> {
        const stored = await this.db.docs.get(id);
        if (!stored) return null;
        return stripInternal<T>(stored);
    }

async put(doc: T): Promise<PutResponse> {
        const { _rev, ...body } = doc as any;
        const id: string = body._id;
        if (!id) throw new Error("Document must have an _id");

        const existing = await this.db.docs.get(id);
        const seq = await this._bumpSeq();
        if (existing) {
            // CAS: caller must provide _rev matching current version.
            // Missing _rev on an existing doc is a conflict (matches PouchDB).
            if (!_rev || makeRev(existing._version) !== _rev) {
                throw conflict409(id);
            }
            const newVersion = existing._version + 1;
            await this.db.docs.put({ ...body, _id: id, _version: newVersion, _localSeq: seq });
            return { ok: true, id, rev: makeRev(newVersion) };
        } else {
            await this.db.docs.put({ ...body, _id: id, _version: 1, _localSeq: seq });
            return { ok: true, id, rev: makeRev(1) };
        }
    }

    async bulkPut(docs: T[]): Promise<PutResponse[]> {
        if (docs.length === 0) return [];

        const ids = docs.map((d) => (d as any)._id as string);
        const existingDocs = await this.db.docs.bulkGet(ids);
        const existingMap = new Map<string, StoredDoc>();
        for (const doc of existingDocs) {
            if (doc) existingMap.set(doc._id, doc);
        }

        const toWrite: StoredDoc[] = [];
        const responses: PutResponse[] = [];
        const errors: Array<{ id: string; message: string }> = [];
        const seq = await this._bumpSeq();

        for (let i = 0; i < docs.length; i++) {
            const { _rev, ...body } = docs[i] as any;
            const id: string = body._id;
            const existing = existingMap.get(id);

            if (existing) {
                // Content-addressed chunks: tolerate 409 silently
                if ((docs[i] as any).type === "chunk") {
                    responses.push({
                        ok: true,
                        id,
                        rev: makeRev(existing._version),
                    });
                    continue;
                }
                const newVersion = existing._version + 1;
                toWrite.push({ ...body, _id: id, _version: newVersion, _localSeq: seq });
                responses.push({ ok: true, id, rev: makeRev(newVersion) });
            } else {
                toWrite.push({ ...body, _id: id, _version: 1, _localSeq: seq });
                responses.push({ ok: true, id, rev: makeRev(1) });
            }
        }

        if (toWrite.length > 0) {
            await this.db.docs.bulkPut(toWrite);
        }

        if (errors.length > 0) {
            const summary = errors
                .map((e) => `${e.id}: ${e.message}`)
                .join("; ");
            throw new Error(
                `bulkPut partial failure (${errors.length}/${docs.length}): ${summary}`,
            );
        }

        return responses;
    }

    async update<D extends T>(
        id: string,
        fn: (existing: D | null) => D | null,
        maxRetries = 3,
    ): Promise<PutResponse | null> {
        let lastErr: any;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const stored = await this.db.docs.get(id);
            const existing = stored ? (stripInternal<D>(stored)) : null;
            const updated = fn(existing);
            if (!updated) return null;

            const { _rev, ...body } = updated as any;
            const expectedVersion = stored?._version ?? 0;
            const newVersion = expectedVersion + 1;

            try {
                let success = false;
                const seq = await this._bumpSeq();
                await this.db.transaction("rw", this.db.docs, async () => {
                    const current = await this.db.docs.get(id);
                    const currentVersion = current?._version ?? 0;
                    if (currentVersion !== expectedVersion) {
                        throw conflict409(id);
                    }
                    await this.db.docs.put({
                        ...body,
                        _id: id,
                        _version: newVersion,
                        _localSeq: seq,
                    });
                    success = true;
                });
                if (success) {
                    return { ok: true, id, rev: makeRev(newVersion) };
                }
            } catch (e: any) {
                lastErr = e;
                if (e?.status === 409 && attempt < maxRetries) continue;
                throw e;
            }
        }
        throw new Error(
            `update failed after ${maxRetries} retries for ${id}: status=${lastErr?.status}`,
        );
    }

    async delete(id: string): Promise<void> {
        await this.db.docs.delete(id);
    }

    async changes(
        since?: number | string,
        opts?: { include_docs?: boolean },
    ): Promise<LocalChangesResult<T>> {
        const sinceNum = typeof since === "string" ? parseInt(since, 10) || 0 : (since ?? 0);
        const rows = await this.db.docs
            .where("_localSeq")
            .above(sinceNum)
            .toArray();
        // Sort by _localSeq ascending for deterministic order
        rows.sort((a, b) => (a._localSeq ?? 0) - (b._localSeq ?? 0));
        const results = rows.map((stored) => ({
            id: stored._id,
            seq: stored._localSeq ?? 0,
            doc: opts?.include_docs ? stripInternal<T>(stored) : undefined,
        }));
        const seqMeta = await this.db.meta.get("_update_seq");
        const lastSeq = (seqMeta?.value as number) ?? 0;
        return { results, last_seq: lastSeq };
    }

async allDocs(opts?: AllDocsOpts): Promise<AllDocsResult<T>> {
        let collection: StoredDoc[];

        if (opts?.keys) {
            // Fetch specific keys
            const results = await this.db.docs.bulkGet(opts.keys);
            collection = results.filter(
                (d): d is StoredDoc => d !== undefined,
            );
        } else if (opts?.startkey && opts?.endkey) {
            // Range query
            let query = this.db.docs
                .where("_id")
                .between(opts.startkey, opts.endkey, true, true);
            if (opts.limit) {
                collection = await query.limit(opts.limit).toArray();
            } else {
                collection = await query.toArray();
            }
        } else if (opts?.limit) {
            collection = await this.db.docs
                .orderBy("_id")
                .limit(opts.limit)
                .toArray();
        } else {
            collection = await this.db.docs.orderBy("_id").toArray();
        }

        const rows: AllDocsRow<T>[] = collection.map((stored) => {
            const row: AllDocsRow<T> = {
                id: stored._id,
                key: stored._id,
                value: { rev: makeRev(stored._version) },
            };
            if (opts?.include_docs) {
                row.doc = stripInternal<T>(stored);
            }
            return row;
        });

        return {
            rows,
            total_rows: rows.length,
        };
    }

    async info(): Promise<{ updateSeq: number | string }> {
        // Use the doc count as a rough proxy for update sequence.
        // A more accurate approach would maintain a monotonic counter
        // in the meta table, but doc count is sufficient for the
        // reconciler's "has anything changed?" check.
        const count = await this.db.docs.count();
        // Read the actual sequence counter from meta if available
        const seqMeta = await this.db.meta.get("_update_seq");
        return { updateSeq: seqMeta?.value ?? count };
    }

    /**
     * Increment and return the update sequence counter. Called after
     * every write operation that changes doc state.
     */
    async _bumpSeq(): Promise<number> {
        const existing = await this.db.meta.get("_update_seq");
        const next = ((existing?.value as number) ?? 0) + 1;
        await this.db.meta.put({ key: "_update_seq", value: next });
        return next;
    }

    async close(): Promise<void> {
        if (!this._closed) {
            this.db.close();
            this._closed = true;
        }
    }

    async destroy(): Promise<void> {
        await this.db.delete();
        this._closed = true;
    }

    // ── Meta table helpers ──────────────────────────────

    async getMeta<V = any>(key: string): Promise<V | null> {
        const row = await this.db.meta.get(key);
        return row ? (row.value as V) : null;
    }

    async putMeta<V = any>(key: string, value: V): Promise<void> {
        await this.db.meta.put({ key, value });
    }

    async deleteMeta(key: string): Promise<void> {
        await this.db.meta.delete(key);
    }
}
