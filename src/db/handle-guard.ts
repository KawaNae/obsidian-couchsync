/**
 * HandleGuard — self-healing wrapper around a resource that can be
 * silently invalidated by the environment (IndexedDB handle killed on
 * browser sleep, socket severed after OS suspend, etc.).
 *
 * Every operation runs through `runOp(op)`. If the wrapped resource
 * throws an "handle expired" error (`InvalidStateError`,
 * `DatabaseClosedError`, or a matching Dexie inner error), the guard:
 *   1. attempts `cleanup()` on the dead handle (swallowing cleanup errors),
 *   2. rebuilds a fresh instance via `factory()`,
 *   3. re-runs the op.
 *
 * After `maxReopen` consecutive reopen-then-fail cycles, the guard gives
 * up and throws `DbError("degraded", { recovery: "halt" })` so the
 * surrounding sync supervisor can stop and notify the user.
 *
 * This is the only place in the DB layer that knows how to recover from
 * a dead IndexedDB connection. Everything above — LocalDB, DexieStore,
 * Checkpoints, the sync pipelines — sees a handle that appears to be
 * always alive.
 */

import { classifyDexieError, DbError, debugDescribeError } from "./write-transaction.ts";
import { logDebug, logWarn } from "../ui/log.ts";

export interface HandleGuardOptions<T> {
    /** Build a fresh instance of the wrapped resource. Called lazily on
     *  first `runOp` / `ensureHealthy`, and again after each failed op
     *  that triggers a reopen. */
    factory: () => T;
    /** Best-effort cleanup on the dead handle before reopening. Errors
     *  are swallowed (the handle is already dead). */
    cleanup: (inner: T) => Promise<void>;
    /** Optional probe used by `ensureHealthy()`. If omitted, the probe
     *  only asserts that the handle exists. */
    probe?: (inner: T) => Promise<void>;
    /** Maximum consecutive reopen attempts before giving up. Default 3. */
    maxReopen?: number;
}

export class HandleGuard<T> {
    private current: T | null = null;
    private readonly factory: () => T;
    private readonly cleanup: (inner: T) => Promise<void>;
    private readonly probe?: (inner: T) => Promise<void>;
    private readonly maxReopen: number;
    /** Per-guard latch: capture stack trace of the first unclassified
     *  ("unknown" kind) failure so the call site can be pinpointed in
     *  production logs. Repeated occurrences log only one summary line. */
    private unknownKindCaptured = false;

    constructor(opts: HandleGuardOptions<T>) {
        this.factory = opts.factory;
        this.cleanup = opts.cleanup;
        this.probe = opts.probe;
        this.maxReopen = opts.maxReopen ?? 3;
    }

    /** Run an operation on the wrapped resource. Transparently reopens
     *  on handle-expired errors. Throws DbError(degraded, halt) after
     *  `maxReopen` consecutive failures. */
    async runOp<R>(op: (inner: T) => Promise<R>, context: string): Promise<R> {
        let reopenAttempts = 0;
        // Allow one initial attempt plus `maxReopen` retries.
        while (true) {
            const inner = this.get();
            try {
                return await op(inner);
            } catch (e: unknown) {
                if (!isHandleExpired(e)) {
                    // First unclassified error is logged with full shape so
                    // we can see whether it *should* have been classified
                    // as handle-expired (e.g. TransactionInactiveError
                    // under a different Dexie version).
                    if (classifyDexieError(e) === "unknown" && !this.unknownKindCaptured) {
                        this.unknownKindCaptured = true;
                        logWarn(
                            `CouchSync: [handle-guard] unclassified DB error in ${context} — ${debugDescribeError(e)}`,
                        );
                    }
                    throw e;
                }
                if (reopenAttempts >= this.maxReopen) {
                    logWarn(
                        `CouchSync: [handle-guard] giving up after ${this.maxReopen} reopen attempts in ${context} — last trigger: ${debugDescribeError(e)}`,
                    );
                    throw new DbError(
                        "degraded",
                        e,
                        `local DB handle degraded after ${this.maxReopen} reopen attempts (${context})`,
                    );
                }
                reopenAttempts++;
                logDebug(
                    `[handle-guard] reopen attempt ${reopenAttempts}/${this.maxReopen} in ${context} — trigger: ${debugDescribeError(e)}`,
                );
                await this.resetHandle();
            }
        }
    }

    /** Probe the handle and transparently reopen on handle-expired
     *  errors, sharing `runOp`'s `maxReopen` budget. After exhaustion
     *  throws `DbError("degraded", { recovery: "halt" })` — same contract
     *  as `runOp`, so SyncEngine's openSession path always sees the
     *  degraded signal (instead of a raw IDB error that would be routed
     *  through `enterError` into an infinite retry-backoff loop, as on
     *  iOS WebKit after IDB-process death). */
    async ensureHealthy(): Promise<void> {
        if (!this.probe) {
            // No probe configured — just ensure a handle is materialised.
            this.get();
            return;
        }
        const probe = this.probe;
        await this.runOp(async (inner) => { await probe(inner); }, "ensureHealthy");
    }

    /** Release the current handle (if any). The next runOp will build a
     *  fresh one. */
    async close(): Promise<void> {
        if (!this.current) return;
        const old = this.current;
        this.current = null;
        try { await this.cleanup(old); } catch { /* ignore */ }
    }

    /** @internal test hook */
    hasLiveHandle(): boolean {
        return this.current !== null;
    }

    // ── Internal ─────────────────────────────────────────

    private get(): T {
        if (!this.current) this.current = this.factory();
        return this.current;
    }

    private async resetHandle(): Promise<void> {
        const dead = this.current;
        this.current = null;
        if (dead) {
            try { await this.cleanup(dead); } catch { /* handle is already dead */ }
        }
    }
}

function isHandleExpired(e: unknown): boolean {
    // Classify via the shared Dexie error mapper first — this covers
    // DbError(invalid-state) re-throws and most Dexie inner-wrapped cases.
    if (classifyDexieError(e) === "invalid-state") return true;

    const err: any = e;
    const name: string = err?.name ?? err?.inner?.name ?? "";
    if (name === "DatabaseClosedError") return true;
    const msg: string = (err?.message ?? "").toString().toLowerCase();
    if (msg.includes("database is closed") || msg.includes("connection to indexed")) return true;
    return false;
}
