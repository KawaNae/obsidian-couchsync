/**
 * In-memory ICouchClient for integration tests. Simulates CouchDB
 * semantics: bulkDocs stores documents, changes() returns them in order.
 *
 * `changesLongpoll()` honours the longpoll contract: it parks the caller
 * until either (a) new docs land via `bulkDocs`, or (b) the client is
 * destroyed. Without this, the SyncEngine pull loop would busy-spin
 * against an instantly-resolving longpoll and starve the test runner.
 */

import type {
    ICouchClient,
    DbInfo,
    ChangesOpts,
    ChangesResult,
    ChangeRow,
    BulkDocsResult,
    AllDocsOpts,
    AllDocsResult,
} from "../../src/db/interfaces.ts";

interface StoredDoc {
    doc: any;
    rev: string;
    seq: number;
    deleted?: boolean;
}

interface Tick {
    promise: Promise<void>;
    resolve: () => void;
}
function makeTick(): Tick {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
}

export class FakeCouchClient implements ICouchClient {
    private docs = new Map<string, StoredDoc>();
    private revCounter = 0;
    private seqCounter = 0;
    /** Bumped on every bulkDocs (+ destroy) to wake parked longpoll callers. */
    private tick: Tick = makeTick();
    private destroyed = false;

    async info(signal?: AbortSignal): Promise<DbInfo> {
        throwIfAborted(signal);
        return {
            db_name: "fake-remote",
            doc_count: this.docs.size,
            update_seq: this.seqCounter,
        };
    }

    async getDoc<T>(id: string, _opts?: { conflicts?: boolean }, signal?: AbortSignal): Promise<T | null> {
        throwIfAborted(signal);
        const stored = this.docs.get(id);
        if (!stored || stored.deleted) return null;
        return { ...stored.doc, _rev: stored.rev } as T;
    }

    async bulkGet<T>(ids: string[], signal?: AbortSignal): Promise<T[]> {
        throwIfAborted(signal);
        const result: T[] = [];
        for (const id of ids) {
            const stored = this.docs.get(id);
            if (stored && !stored.deleted) {
                result.push({ ...stored.doc, _rev: stored.rev } as T);
            }
        }
        return result;
    }

    async bulkDocs(docs: any[], signal?: AbortSignal): Promise<BulkDocsResult[]> {
        throwIfAborted(signal);
        const results: BulkDocsResult[] = [];
        for (const doc of docs) {
            const id = doc._id;
            this.revCounter++;
            this.seqCounter++;
            const rev = `${this.revCounter}-fake`;
            this.docs.set(id, {
                doc: { ...doc, _rev: undefined },
                rev,
                seq: this.seqCounter,
                deleted: doc._deleted,
            });
            results.push({ ok: true, id, rev });
        }
        // Wake any longpoll caller waiting for docs.
        if (docs.length > 0) this.bumpTick();
        return results;
    }

    private bumpTick(): void {
        const old = this.tick;
        this.tick = makeTick();
        old.resolve();
    }

    async allDocs<T>(opts: AllDocsOpts, signal?: AbortSignal): Promise<AllDocsResult<T>> {
        throwIfAborted(signal);
        const rows: any[] = [];

        if (opts.keys) {
            for (const key of opts.keys) {
                const stored = this.docs.get(key);
                if (stored) {
                    rows.push({
                        id: key,
                        key,
                        value: { rev: stored.rev, deleted: stored.deleted },
                        doc: opts.include_docs ? { ...stored.doc, _rev: stored.rev } : undefined,
                    });
                }
            }
        } else {
            // Real CouchDB `_all_docs` returns rows sorted by id (lex).
            // Sort first, then apply range+limit so paging via
            // `startkey = lastId + "\x00"` behaves like production.
            const sortedIds = Array.from(this.docs.keys()).sort();
            for (const id of sortedIds) {
                if (opts.startkey && id < opts.startkey) continue;
                if (opts.endkey && id > opts.endkey) continue;
                const stored = this.docs.get(id)!;
                rows.push({
                    id,
                    key: id,
                    value: { rev: stored.rev, deleted: stored.deleted },
                    doc: opts.include_docs ? { ...stored.doc, _rev: stored.rev } : undefined,
                });
                if (opts.limit && rows.length >= opts.limit) break;
            }
        }

        return { rows, total_rows: this.docs.size };
    }

    async changes<T>(opts: ChangesOpts, signal?: AbortSignal): Promise<ChangesResult<T>> {
        throwIfAborted(signal);
        const since = typeof opts.since === "number" ? opts.since : 0;
        const results: ChangeRow<T>[] = [];
        for (const [id, stored] of this.docs) {
            if (stored.seq <= since) continue;
            results.push({
                id,
                seq: stored.seq,
                doc: opts.include_docs ? ({ ...stored.doc, _rev: stored.rev } as T) : undefined,
                deleted: stored.deleted,
            });
            if (opts.limit && results.length >= opts.limit) break;
        }
        return { results, last_seq: this.seqCounter };
    }

    /**
     * Longpoll: drains immediately if changes exist past `since`; otherwise
     * parks the caller until `bulkDocs` produces something, the client is
     * destroyed, or the caller's AbortSignal fires. Avoids calling
     * `changes()` on the empty-and-quiet path so tests that spy on
     * `changes` see only intentional polls.
     */
    async changesLongpoll<T>(opts: ChangesOpts, signal?: AbortSignal): Promise<ChangesResult<T>> {
        throwIfAborted(signal);
        while (!this.destroyed) {
            const sinceNum = typeof opts.since === "number"
                ? opts.since
                : parseInt(String(opts.since ?? 0), 10) || 0;
            if (this.seqCounter > sinceNum) {
                return this.changes<T>(opts);
            }
            // Race the tick wake against the abort signal so parked
            // callers exit immediately when the session is torn down.
            await raceTickAgainstSignal(this.tick.promise, signal);
            throwIfAborted(signal);
        }
        return { results: [], last_seq: this.seqCounter };
    }

    async ensureDb(_signal?: AbortSignal): Promise<void> {
        // no-op
    }

    async destroy(_signal?: AbortSignal): Promise<void> {
        this.destroyed = true;
        // Wake every parked longpoll caller so their loops can exit.
        this.bumpTick();
        this.docs.clear();
        this.seqCounter = 0;
        this.revCounter = 0;
    }
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        const e: any = new Error("The operation was aborted.");
        e.name = "AbortError";
        throw e;
    }
}

function raceTickAgainstSignal(tick: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return tick;
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        const onAbort = () => resolve();
        signal.addEventListener("abort", onAbort, { once: true });
        tick.then(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        });
    });
}
