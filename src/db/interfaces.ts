/**
 * Storage interfaces — decouple all consumers from concrete storage types.
 *
 * Every file outside `src/db/` references these interfaces. Concrete
 * implementations: DexieStore (local), CouchClient (remote).
 *
 * ### API hierarchy (post-Step C refactor)
 *
 * - `IDocStore<T>` is the minimal atomic-write local store: `get` + query +
 *   `runWrite` (builder or fixed tx) + lifecycle. **All** mutations go
 *   through `runWrite`, never a convenience shim.
 * - `IMetaReader` exposes the key/value meta side (checkpoints, vclock
 *   cache, cursors). Writes land via `IDocStore.runWrite({ meta: [...] })`.
 * - `ILocalStore<T>` is an alias for `IDocStore<T>` retained for
 *   incremental migration; prefer `IDocStore` in new code.
 */

import type {
    WriteBuilder,
    WriteTransaction,
} from "./write-transaction.ts";

// ── Response types ───────────────────────────────────────

/** @deprecated Retained for backward compatibility during Step C migration. */
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
 * Abstraction over the local document store (backed by DexieStore).
 * ConflictResolver uses pure vclock comparison via `resolveOnPull()`.
 */
export interface LocalChangesResult<T> {
    results: Array<{ id: string; seq: number | string; doc?: T; deleted?: boolean }>;
    last_seq: number | string;
}

/**
 * Minimal atomic-write local store. Every mutation goes through
 * `runWrite` — either a pre-built tx (one write, no CAS retry) or a
 * builder that receives a fresh snapshot and returns the tx to commit
 * (CAS retry on conflict happens inside the store).
 */
export interface IDocStore<T = any> {
    get(id: string): Promise<T | null>;
    allDocs(opts?: AllDocsOpts): Promise<AllDocsResult<T>>;
    info(): Promise<{ updateSeq: number | string }>;
    /**
     * Return documents that changed since `since`. Used by SyncEngine's
     * push loop to detect local writes that need uploading to the remote.
     */
    changes(since?: number | string, opts?: { include_docs?: boolean }): Promise<LocalChangesResult<T>>;
    /** Builder form: CAS retry on `DbError(kind:"conflict")` up to `maxAttempts`. */
    runWrite(
        builder: WriteBuilder<T>,
        opts?: { maxAttempts?: number },
    ): Promise<boolean>;
    /** Fixed-tx form: a single commit, no retry. */
    runWrite(tx: WriteTransaction<T>): Promise<void>;
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

/**
 * @deprecated Alias for `IDocStore<T>` retained during Step C migration.
 * New code should import `IDocStore` directly.
 */
export type ILocalStore<T = any> = IDocStore<T>;

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
