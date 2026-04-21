/**
 * DexieStore — Dexie-based `IDocStore` implementation.
 *
 * Post-Step C refactor: the write entry points are `runWriteBuilder` and
 * `runWriteTx`. They
 *   - opens a single rw transaction over `docs` and `meta`
 *   - bumps `_update_seq` exactly once per call (atomic batch = one seq)
 *   - normalises Dexie/IDB exceptions into typed `DbError`
 *   - retries `AbortError` with short exponential backoff
 *   - escalates `QuotaExceededError` to the caller immediately
 *
 * Two named methods:
 *
 *  - `runWriteTx(tx)` — pre-built `WriteTransaction`. Single commit, no
 *    CAS retry. Suitable when the caller already has every value needed.
 *  - `runWriteBuilder(builder, opts?)` — builder receives a fresh
 *    `WriteSnapshot` and returns the tx to commit. On
 *    `DbError(kind:"conflict")` (vclock CAS failure) the store
 *    re-snapshots and calls the builder again up to `maxAttempts` times,
 *    so callers never hand-roll a retry loop.
 */

import Dexie, { type Table } from "dexie";
import type {
    IDocStore,
    AllDocsOpts,
    AllDocsResult,
    AllDocsRow,
    LocalChangesResult,
    ListIdsRange,
} from "./interfaces.ts";
import { stripRev } from "../utils/doc.ts";
import { toPathKey } from "../utils/path.ts";
import {
    DbError,
    classifyDexieError,
    debugDescribeError,
    toDbError,
    type WriteTransaction,
    type WriteBuilder,
    type WriteSnapshot,
} from "./write-transaction.ts";
import type { VectorClock } from "../sync/vector-clock.ts";
import { logWarn } from "../ui/log.ts";

// ── Stored document shape ───────────────────────────────

/** Internal wrapper: the raw doc plus a CAS version counter. */
export interface StoredDoc {
    /** Document ID — Dexie primary key. */
    _id: string;
    /** CAS version counter. Incremented on every write. */
    _version: number;
    /** Monotonic local sequence number for change tracking. Set on every
     *  write to the seq allocated by the enclosing `runTx`. SyncEngine's
     *  push loop queries docs with `_localSeq > lastPushedSeq` to find
     *  unpushed changes. */
    _localSeq?: number;
    /** The document body. */
    [key: string]: any;
}

/** Key-value metadata row (scan cursor, vault manifest, vclocks…). */
export interface LocalMeta {
    key: string;
    value: any;
}

// ── Per-path vclock meta key convention ─────────────────

/** Prefix for `_local/vclock/<path>` entries written by `runWrite`. */
export const VCLOCK_KEY_PREFIX = "_local/vclock/";
export function vclockMetaKey(path: string): string {
    return VCLOCK_KEY_PREFIX + toPathKey(path);
}

// ── Retry policy for transient AbortError ───────────────

const ABORT_RETRY_DELAYS_MS: readonly number[] = [100, 200, 400];

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
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
    const { _version, _localSeq, ...doc } = stored;
    return { ...doc, _rev: makeRev(_version) } as unknown as T;
}

function vclocksEqual(a: VectorClock | undefined, b: VectorClock): boolean {
    if (!a) return Object.keys(b).length === 0;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
        if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
    }
    return true;
}

// ── DexieStore ──────────────────────────────────────────

export class DexieStore<T extends { _id: string; _rev?: string } = any>
    implements IDocStore<T>
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

    // ── Core: single-tx + single-seq + retry/normalise ──

    /**
     * Run `work` inside one rw transaction across `docs` and `meta`.
     * Allocates exactly one `_update_seq` value (passed as `seq`) so every
     * write inside the tx shares it. Catches Dexie/IDB exceptions, maps
     * them to `DbError`, and retries transient `AbortError` with a short
     * exponential backoff.
     */
    private async runTx<R>(
        work: (ctx: { seq: number }) => Promise<R>,
    ): Promise<R> {
        let attempt = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            try {
                let result!: R;
                await this.db.transaction(
                    "rw",
                    this.db.docs,
                    this.db.meta,
                    async () => {
                        const existing = await this.db.meta.get("_update_seq");
                        const seq = ((existing?.value as number) ?? 0) + 1;
                        await this.db.meta.put({ key: "_update_seq", value: seq });
                        result = await work({ seq });
                    },
                );
                return result;
            } catch (e) {
                const kind = classifyDexieError(e);
                if (kind === "abort" && attempt < ABORT_RETRY_DELAYS_MS.length) {
                    await sleep(ABORT_RETRY_DELAYS_MS[attempt]);
                    attempt++;
                    continue;
                }
                // Diagnostic: unclassified failures inside a Dexie
                // transaction are the exact shape we want to study for the
                // "no in-progress transaction" race. Log each occurrence
                // with full descriptor — this path is rare, not a hot loop.
                if (kind === "unknown") {
                    logWarn(
                        `CouchSync: [dexie-store] runTx failed unclassified — ${debugDescribeError(e)}`,
                    );
                }
                throw toDbError(e);
            }
        }
    }

    /**
     * Builder-style atomic write. Reads a snapshot (outside any tx), passes
     * it to `builder` to compute a `WriteTransaction`, then commits that tx.
     * On CAS conflict (`expectedVclock` mismatch) re-snapshots and re-runs
     * `builder` up to `maxAttempts` times.
     *
     * Returns `true` on commit, `false` when the builder returned `null`
     * (explicit no-op) or every attempt hit a conflict.
     */

    /** Snapshot view used by builders. Reads go straight to Dexie. */
    private snapshot(): WriteSnapshot<T> {
        return {
            get: async (id: string) => {
                const stored = await this.db.docs.get(id);
                return stored ? stripInternal<T>(stored) : null;
            },
            getMeta: async <V = any,>(key: string) => {
                const row = await this.db.meta.get(key);
                return row ? (row.value as V) : null;
            },
            getMetaByPrefix: <V = any,>(prefix: string) =>
                this.getMetaByPrefix<V>(prefix),
        };
    }

    async runWriteBuilder(
        builder: WriteBuilder<T>,
        opts?: { maxAttempts?: number },
    ): Promise<boolean> {
        const maxAttempts = opts?.maxAttempts ?? 5;
        let lastConflict: DbError | null = null;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const snap = this.snapshot();
            const built = await builder(snap);
            if (!built) return false;
            try {
                await this.runWriteTx(built);
            } catch (e) {
                if (e instanceof DbError && e.kind === "conflict") {
                    lastConflict = e;
                    continue;
                }
                throw e;
            }
            // onCommit is already called by runWriteTx.
            return true;
        }
        throw (
            lastConflict ??
            new DbError(
                "conflict",
                null,
                `runWrite gave up after ${maxAttempts} CAS conflicts`,
            )
        );
    }

    /**
     * Simple atomic batch write. All listed mutations land in a single
     * rw transaction with one `_update_seq`. No CAS retry — the caller
     * already has every value needed. Used for meta-only writes, deletes,
     * and unconditional upserts (e.g. pull-accepted docs).
     */
    async runWriteTx(tx: WriteTransaction<T>): Promise<void> {
        await this.runTx(async ({ seq }) => {
            // 1. chunks: content-addressed put-if-absent.
            if (tx.chunks && tx.chunks.length > 0) {
                const ids = tx.chunks.map((c) => c._id);
                const existing = await this.db.docs.bulkGet(ids);
                const have = new Set(
                    existing.filter((d): d is StoredDoc => !!d).map((d) => d._id),
                );
                const fresh = tx.chunks.filter((c) => !have.has(c._id));
                if (fresh.length > 0) {
                    await this.db.docs.bulkPut(
                        fresh.map((c) => ({
                            ...stripRev(c),
                            _version: 1,
                            _localSeq: seq,
                        })),
                    );
                }
            }

            // 2. docs: upsert with optional vclock-based CAS.
            if (tx.docs && tx.docs.length > 0) {
                const ids = tx.docs.map((d) => d.doc._id);
                const existingDocs = await this.db.docs.bulkGet(ids);
                const existingMap = new Map<string, StoredDoc>();
                for (const d of existingDocs) {
                    if (d) existingMap.set(d._id, d);
                }
                const toWrite: StoredDoc[] = [];
                for (const { doc, expectedVclock } of tx.docs) {
                    const id = doc._id;
                    const stored = existingMap.get(id);
                    if (expectedVclock !== undefined) {
                        const currentVc = stored?.vclock as
                            | VectorClock
                            | undefined;
                        if (!vclocksEqual(currentVc, expectedVclock)) {
                            throw new DbError(
                                "conflict",
                                null,
                                `vclock CAS failed for ${id}`,
                            );
                        }
                    }
                    const newVersion = (stored?._version ?? 0) + 1;
                    toWrite.push({
                        ...stripRev(doc),
                        _id: id,
                        _version: newVersion,
                        _localSeq: seq,
                    });
                }
                if (toWrite.length > 0) {
                    await this.db.docs.bulkPut(toWrite);
                }
            }

            // 3. deletes: physical removal.
            if (tx.deletes && tx.deletes.length > 0) {
                await this.db.docs.bulkDelete(tx.deletes);
            }

            // 4. per-path vclock meta updates.
            if (tx.vclocks && tx.vclocks.length > 0) {
                for (const v of tx.vclocks) {
                    const key = vclockMetaKey(v.path);
                    if (v.op === "set") {
                        await this.db.meta.put({ key, value: v.clock });
                    } else {
                        await this.db.meta.delete(key);
                    }
                }
            }

            // 5. arbitrary meta writes (checkpoints, manifests, cursors…).
            if (tx.meta && tx.meta.length > 0) {
                for (const m of tx.meta) {
                    if (m.op === "put") {
                        await this.db.meta.put({ key: m.key, value: m.value });
                    } else {
                        await this.db.meta.delete(m.key);
                    }
                }
            }
        });

        if (tx.onCommit) await tx.onCommit();
    }

    // ── IDocStore implementation ────────────────────────

    async get(id: string): Promise<T | null> {
        const stored = await this.db.docs.get(id);
        if (!stored) return null;
        return stripInternal<T>(stored);
    }

    async changes(
        since?: number | string,
        opts?: { include_docs?: boolean },
    ): Promise<LocalChangesResult<T>> {
        const sinceNum =
            typeof since === "string" ? parseInt(since, 10) || 0 : (since ?? 0);
        const rows = await this.db.docs
            .where("_localSeq")
            .above(sinceNum)
            .toArray();
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
            const results = await this.db.docs.bulkGet(opts.keys);
            collection = results.filter(
                (d): d is StoredDoc => d !== undefined,
            );
        } else if (opts?.startkey && opts?.endkey) {
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

    async listIds(range: ListIdsRange): Promise<string[]> {
        let query = this.db.docs
            .where("_id")
            .between(range.startkey, range.endkey, true, true);
        if (range.limit !== undefined) query = query.limit(range.limit);
        const ids = await query.primaryKeys();
        // Dexie primary-key range queries already return ids in index order
        // (lex on strings). We don't sort again — trust the index.
        return ids;
    }

    async info(): Promise<{ updateSeq: number | string }> {
        const count = await this.db.docs.count();
        const seqMeta = await this.db.meta.get("_update_seq");
        return { updateSeq: seqMeta?.value ?? count };
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

    // ── Meta table read helpers (IMetaReader) ───────────

    async getMeta<V = any>(key: string): Promise<V | null> {
        const row = await this.db.meta.get(key);
        return row ? (row.value as V) : null;
    }

    /**
     * Return all meta entries whose key starts with `prefix`. Used to read
     * the per-path vclock store (`_local/vclock/...`).
     */
    async getMetaByPrefix<V = any>(
        prefix: string,
    ): Promise<Array<{ key: string; value: V }>> {
        const rows = await this.db.meta
            .where("key")
            .startsWith(prefix)
            .toArray();
        return rows.map((r) => ({ key: r.key, value: r.value as V }));
    }
}
