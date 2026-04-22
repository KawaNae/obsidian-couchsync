/**
 * Storage interfaces — decouple all consumers from concrete storage types.
 *
 * Every file outside `src/db/` references these interfaces. Concrete
 * implementations: DexieStore (local), CouchClient (remote).
 *
 * ### API hierarchy
 *
 * - `IDocStore<T>` is the minimal atomic-write local store: `get` + query +
 *   `runWriteBuilder` / `runWriteTx` + lifecycle. **All** mutations go
 *   through these two methods, never a convenience shim.
 * - `IMetaReader` exposes the key/value meta side (checkpoints, vclock
 *   cache, cursors). Writes land via `IDocStore.runWriteTx({ meta: [...] })`.
 */

import type {
    WriteBuilder,
    WriteTransaction,
} from "./write-transaction.ts";

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

// ── IDocStore ────────────────────────────────────────────

/**
 * Abstraction over the local document store (backed by DexieStore).
 * ConflictResolver uses pure vclock comparison via `resolveOnPull()`.
 */
export interface LocalChangesResult<T> {
    results: Array<{ id: string; seq: number | string; doc?: T; deleted?: boolean }>;
    last_seq: number | string;
}

/** Range query for id-only listings. */
export interface ListIdsRange {
    startkey: string;
    endkey: string;
    /** Maximum number of ids to return. */
    limit?: number;
}

/**
 * Minimal atomic-write local store. Every mutation goes through
 * `runWriteBuilder` (CAS retry on conflict) or `runWriteTx` (single
 * commit, no retry).
 */
export interface IDocStore<T = any> {
    get(id: string): Promise<T | null>;
    allDocs(opts?: AllDocsOpts): Promise<AllDocsResult<T>>;
    /**
     * Return only the primary keys (document `_id`s) in `[startkey,
     * endkey]` (inclusive), sorted lexicographically. Document bodies
     * are never loaded — for large content-addressed stores this is the
     * only scalable way to enumerate ids.
     */
    listIds(range: ListIdsRange): Promise<string[]>;
    info(): Promise<{ updateSeq: number | string }>;
    /**
     * Return documents that changed since `since`. Used by SyncEngine's
     * push loop to detect local writes that need uploading to the remote.
     */
    changes(since?: number | string, opts?: { include_docs?: boolean }): Promise<LocalChangesResult<T>>;
    /** Builder form: CAS retry on `DbError(kind:"conflict")` up to `maxAttempts`. */
    runWriteBuilder(
        builder: WriteBuilder<T>,
        opts?: { maxAttempts?: number },
    ): Promise<boolean>;
    /** Simple atomic batch write — a single commit, no CAS retry. */
    runWriteTx(tx: WriteTransaction<T>): Promise<void>;
    close(): Promise<void>;
    destroy(): Promise<void>;
}

/**
 * Read side of the key/value meta table. Writes go through the host's
 * `runWrite({ meta: [...] })`.
 */
export interface IMetaReader {
    getMeta<V = any>(key: string): Promise<V | null>;
    getMetaByPrefix<V = any>(
        prefix: string,
    ): Promise<Array<{ key: string; value: V }>>;
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
 * Abstraction over the remote CouchDB HTTP API (backed by CouchClient).
 *
 * All methods accept an optional `AbortSignal`. When the signal is
 * aborted (before the call or mid-flight), the promise rejects with an
 * `AbortError` and any in-flight HTTP request is cancelled. Callers in
 * the sync pipeline pass the session signal so `SyncSession.dispose()`
 * tears down all outstanding requests in one shot.
 */
export interface ICouchClient {
    info(signal?: AbortSignal): Promise<DbInfo>;
    getDoc<T>(id: string, opts?: { conflicts?: boolean }, signal?: AbortSignal): Promise<T | null>;
    bulkGet<T>(ids: string[], signal?: AbortSignal): Promise<T[]>;
    bulkDocs(docs: any[], signal?: AbortSignal): Promise<BulkDocsResult[]>;
    allDocs<T>(opts: AllDocsOpts, signal?: AbortSignal): Promise<AllDocsResult<T>>;
    changes<T>(opts: ChangesOpts, signal?: AbortSignal): Promise<ChangesResult<T>>;
    changesLongpoll<T>(opts: ChangesOpts, signal?: AbortSignal): Promise<ChangesResult<T>>;
    /** Create the database if it doesn't exist. Idempotent (412 ignored). */
    ensureDb(signal?: AbortSignal): Promise<void>;
    destroy(signal?: AbortSignal): Promise<void>;
}
