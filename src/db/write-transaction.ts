/**
 * WriteTransaction — single value type expressing a complete local DB write.
 *
 * Every DexieStore mutation flows through `runWrite(tx)`. The shape below
 * captures all write intents (docs, chunks, deletions, vclock updates,
 * arbitrary meta) so they can be committed atomically in one IDB tx and
 * one `_update_seq` bump.
 *
 * Errors are normalised to `DbError` with a `kind` discriminator so callers
 * (SyncEngine, VaultSync) can react without sniffing Dexie internals.
 */

import type { VectorClock } from "../sync/vector-clock.ts";

export type DbErrorKind =
    | "quota"          // QuotaExceededError — IndexedDB out of space
    | "abort"          // AbortError — transient (concurrent tx, lock)
    | "invalid-state"  // InvalidStateError — DB closed mid-op
    | "degraded"       // HandleGuard exhausted reopen attempts — unrecoverable
    | "conflict"       // CAS version mismatch (expectedVclock failed)
    | "constraint"     // ConstraintError — schema/PK violation
    | "unknown";

/**
 * Recovery intent for callers: "halt" means stop the sync loop entirely
 * (surfaced to the user, usually quota); "fail" means a genuine failure
 * that bubbles up. Transient classes (abort/conflict) are already handled
 * inside `runWrite` — a `DbError` reaching the caller with those kinds
 * means internal retries were exhausted.
 */
export type DbErrorRecovery = "halt" | "fail";

/** Normalised local-DB error. `kind` drives caller behaviour. */
export class DbError extends Error {
    /** Recovery intent for the caller. Inferred from `kind` if omitted. */
    readonly recovery: DbErrorRecovery;
    /** Human-readable message for Notice display. Set for `quota`. */
    readonly userMessage?: string;

    constructor(
        readonly kind: DbErrorKind,
        readonly cause: unknown,
        message?: string,
        opts?: { recovery?: DbErrorRecovery; userMessage?: string },
    ) {
        super(message ?? `DbError(${kind}): ${(cause as any)?.message ?? cause}`);
        this.name = "DbError";
        this.recovery = opts?.recovery ?? ((kind === "quota" || kind === "degraded") ? "halt" : "fail");
        this.userMessage = opts?.userMessage ?? (
            kind === "quota"
                ? "CouchSync: Local DB storage is full — run chunk GC from Settings → Maintenance."
                : kind === "degraded"
                    ? "CouchSync: Please restart Obsidian — the local DB handle is no longer usable."
                    : undefined
        );
    }

    /** True if a transient retry is reasonable. */
    isTransient(): boolean {
        return this.kind === "abort";
    }
}

// ── Write transaction shape ─────────────────────────────

export type MetaWrite =
    | { op: "put"; key: string; value: unknown }
    | { op: "delete"; key: string };

export type VclockUpdate =
    | { path: string; op: "set"; clock: VectorClock }
    | { path: string; op: "delete" };

/**
 * A single atomic write batch. All listed mutations land in one Dexie
 * transaction with one `_update_seq` bump. Empty arrays are no-ops.
 *
 *  - `docs`: upsert with optional CAS via `expectedVclock`
 *  - `chunks`: content-addressed put-if-absent
 *  - `deletes`: physical delete (chunk GC) or tombstone (handled by caller)
 *  - `vclocks`: per-path lastSyncedVclock updates (meta.set/delete)
 *  - `meta`: arbitrary meta key writes (checkpoint, cursor, manifest…)
 *  - `onCommit`: fired after the tx commits successfully. Never fires on
 *     rollback or retry-and-give-up. Used for in-memory cache updates.
 */
export interface WriteTransaction<T = any> {
    docs?: Array<{ doc: T; expectedVclock?: VectorClock }>;
    chunks?: T[];
    deletes?: string[];
    vclocks?: VclockUpdate[];
    meta?: MetaWrite[];
    onCommit?: () => void | Promise<void>;
}

// ── Builder API (read snapshot → tx) ────────────────────

/**
 * Read-only view of the local store passed into a `runWrite` builder.
 * Supplies just enough for the builder to compute the tx it wants to
 * commit. Reads happen outside the write tx — CAS (via `expectedVclock`)
 * catches any drift between read and commit.
 */
export interface WriteSnapshot<T = any> {
    get(id: string): Promise<T | null>;
    getMeta<V = any>(key: string): Promise<V | null>;
    getMetaByPrefix<V = any>(
        prefix: string,
    ): Promise<Array<{ key: string; value: V }>>;
}

/**
 * Builder supplied to `runWrite(builder)`. Receives a snapshot, returns
 * the `WriteTransaction` to commit (or `null` for a guaranteed no-op).
 * May be invoked more than once: on CAS conflict the tx is aborted and
 * the builder is re-run with a fresh snapshot.
 */
export type WriteBuilder<T = any> = (
    snap: WriteSnapshot<T>,
) => Promise<WriteTransaction<T> | null> | WriteTransaction<T> | null;

// ── Error classification ────────────────────────────────

/** Map a raw exception (Dexie, IDB, custom) to a DbErrorKind. */
export function classifyDexieError(e: unknown): DbErrorKind {
    if (e instanceof DbError) return e.kind;
    const err: any = e;
    // CouchDB-style 409 from the legacy conflict409() helper.
    if (err?.status === 409 || err?.name === "conflict") return "conflict";
    const name: string = err?.name ?? err?.inner?.name ?? "";
    if (name === "QuotaExceededError") return "quota";
    if (name === "AbortError") return "abort";
    // `TransactionInactiveError` is the spec-correct name for an aborted
    // transaction; Safari sometimes reports the same condition as a
    // generic `UnknownError` carrying the "without an in-progress
    // transaction" message (handled in the message fallback below).
    if (name === "InvalidStateError" || name === "TransactionInactiveError") return "invalid-state";
    if (name === "ConstraintError") return "constraint";
    // Some Dexie errors wrap the underlying IDB error in `.inner`.
    const inner: any = err?.inner;
    if (inner) {
        const iname: string = inner.name ?? "";
        if (iname === "QuotaExceededError") return "quota";
        if (iname === "AbortError") return "abort";
        if (iname === "InvalidStateError" || iname === "TransactionInactiveError") return "invalid-state";
        if (iname === "ConstraintError") return "constraint";
    }
    // Fallback: heuristics on message text.
    const msg: string = (err?.message ?? "").toString().toLowerCase();
    const innerMsg: string = (err?.inner?.message ?? "").toString().toLowerCase();
    if (msg.includes("quota")) return "quota";
    if (msg.includes("invalidstate")) return "invalid-state";
    // iOS Safari kills in-flight IndexedDB transactions on visibilitychange→hidden.
    // Subsequent ops on the dead handle throw `UnknownError: Attempt to ...
    // without an in-progress transaction`. Treat as invalid-state so HandleGuard
    // reopens the connection rather than letting the push loop spin on a dead tx.
    if (
        msg.includes("without an in-progress transaction") ||
        innerMsg.includes("without an in-progress transaction")
    ) {
        return "invalid-state";
    }
    return "unknown";
}

/**
 * Debug helper — returns a compact description of an unclassified error
 * (outer name, inner name, first line of stack, first 200 chars of
 * message). Used by diagnostic log points to capture the precise shape
 * of errors that fall through to `"unknown"`, so later releases can
 * extend the classifier accurately.
 */
export function debugDescribeError(e: unknown): string {
    const err: any = e;
    const name = err?.name ?? "<no-name>";
    const innerName = err?.inner?.name ?? "-";
    const message = ((err?.message ?? String(e)) as string).slice(0, 200);
    const stack0 =
        err instanceof Error && err.stack
            ? err.stack.split("\n").slice(0, 3).join(" | ")
            : "-";
    return `name=${name} innerName=${innerName} message="${message}" stack=${stack0}`;
}

/** Wrap any thrown value as a typed DbError (idempotent if already one). */
export function toDbError(e: unknown): DbError {
    if (e instanceof DbError) return e;
    return new DbError(classifyDexieError(e), e);
}
