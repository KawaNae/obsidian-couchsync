/**
 * Storage interfaces — decouple all consumers from PouchDB types.
 *
 * Phase 0 of the PouchDB removal plan: every file outside `src/db/` should
 * reference these interfaces instead of `PouchDB.Database` or
 * `PouchDB.Core.Response`. The concrete implementations (LocalDB,
 * ConfigLocalDB) continue to use PouchDB internally until Phase 1 swaps
 * them to Dexie.
 */

// ── Response types ───────────────────────────────────────

export interface PutResponse {
    ok: boolean;
    id: string;
    rev: string;
}

// ── AllDocs types ────────────────────────────────────────

export interface AllDocsOpts {
    startkey?: string;
    endkey?: string;
    keys?: string[];
    include_docs?: boolean;
    conflicts?: boolean;
    limit?: number;
}

export interface AllDocsRow<T> {
    id: string;
    key?: string;
    value: { rev: string; deleted?: boolean };
    doc?: T;
}

export interface AllDocsResult<T> {
    rows: AllDocsRow<T>[];
    total_rows?: number;
}

// ── ILocalStore ──────────────────────────────────────────

/**
 * Abstraction over the local document store. Phase 0 implementation is
 * PouchDB; Phase 1 replaces it with Dexie.
 *
 * Phase 2: `getByRev` and `removeRev` removed — ConflictResolver no
 * longer walks PouchDB conflict trees; resolution is pure vclock
 * comparison via `resolveOnPull()`.
 */
export interface LocalChangesResult<T> {
    results: Array<{ id: string; seq: number | string; doc?: T; deleted?: boolean }>;
    last_seq: number | string;
}

export interface ILocalStore<T = any> {
    get(id: string): Promise<T | null>;
    put(doc: T): Promise<PutResponse>;
    bulkPut(docs: T[]): Promise<PutResponse[]>;
    update<D extends T>(
        id: string,
        fn: (existing: D | null) => D | null,
        maxRetries?: number,
    ): Promise<PutResponse | null>;
    delete(id: string): Promise<void>;
    allDocs(opts?: AllDocsOpts): Promise<AllDocsResult<T>>;
    info(): Promise<{ updateSeq: number | string }>;
    /**
     * Return documents that changed since `since`. Used by SyncEngine's
     * push loop to detect local writes that need uploading to the remote.
     */
    changes(since?: number | string, opts?: { include_docs?: boolean }): Promise<LocalChangesResult<T>>;
    close(): Promise<void>;
    destroy(): Promise<void>;
}

// ── ICouchClient ─────────────────────────────────────────

/** CouchDB database metadata. */
export interface DbInfo {
    db_name: string;
    doc_count: number;
    update_seq: number | string;
}

export interface ChangesOpts {
    since?: number | string;
    limit?: number;
    include_docs?: boolean;
}

export interface ChangeRow<T> {
    id: string;
    seq: number | string;
    doc?: T;
    deleted?: boolean;
}

export interface ChangesResult<T> {
    results: ChangeRow<T>[];
    last_seq: number | string;
}

export interface BulkDocsResult {
    ok?: boolean;
    id: string;
    rev?: string;
    error?: string;
    reason?: string;
}

/**
 * Abstraction over the remote CouchDB HTTP API. Implemented in Phase 2
 * with a fetch-based client; until then, callers inside `src/db/` still
 * use PouchDB's remote instance directly.
 */
export interface ICouchClient {
    info(): Promise<DbInfo>;
    getDoc<T>(id: string, opts?: { conflicts?: boolean }): Promise<T | null>;
    bulkGet<T>(ids: string[]): Promise<T[]>;
    bulkDocs(docs: any[]): Promise<BulkDocsResult[]>;
    allDocs<T>(opts: AllDocsOpts): Promise<AllDocsResult<T>>;
    changes<T>(opts: ChangesOpts): Promise<ChangesResult<T>>;
    changesLongpoll<T>(opts: ChangesOpts): Promise<ChangesResult<T>>;
    /** Create the database if it doesn't exist. Idempotent (412 ignored). */
    ensureDb(): Promise<void>;
    destroy(): Promise<void>;
}
