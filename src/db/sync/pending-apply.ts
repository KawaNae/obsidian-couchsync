/**
 * PendingApply — persistent set of file-doc ids that were pulled and
 * committed to LocalDB (and whose remoteSeq has advanced) but could NOT
 * yet be applied to the vault, because one or more of their chunks were
 * missing on the remote at apply time.
 *
 * This is the pull-side mirror of `unpushed-ids.ts` (Invariant B — pull
 * durability). The push pipeline never advances `lastPushedSeq` past an
 * id without either placing it on remote or recording it in the unpushed
 * set; symmetrically, the pull pipeline must never advance `remoteSeq`
 * past a file doc without either applying it to the vault or recording it
 * here for retry. Without this set a file whose chunks land slightly
 * after its doc (the race Invariant A prevents at the source, but cannot
 * cover for cross-device / cross-cycle / expired-attachment cases) would
 * be checkpointed-past and never re-attempted — a permanent ghost.
 *
 * Stored as one meta entry per id (`_sync/pending-apply/<fileDocId>`)
 * rather than a single dump, so add/remove are single-key writes that
 * compose with other meta changes inside one `runWriteTx` (atomic with
 * the `remoteSeq` advance — see `Checkpoints.commitPullBatch`).
 *
 * The set is drained every pull cycle (`PullWriter.drainPendingApply`):
 * each id's chunks are re-fetched and the file re-applied; on success the
 * id leaves the set. Chunks do NOT flow through `_changes`, so a freshly-
 * durable chunk never wakes the longpoll on its own — the drain on the
 * empty-longpoll branch is what recovers a ghost within one poll window.
 */

export const PENDING_APPLY_KEY_PREFIX = "_sync/pending-apply/";

export type PendingApplyReason =
    /** Apply failed because a referenced chunk was not yet on remote.
     *  Auto-retries every pull cycle until the chunk becomes durable. */
    | "missing-chunks";

export interface PendingApplyEntry {
    addedAt: number;
    reason: PendingApplyReason;
    /** Pull cycles this id has stayed unapplied. Bumped on each failed
     *  drain — surfaced for observability (a persistently stuck file
     *  points at a genuinely lost chunk that needs manual chunk-repair). */
    attempts: number;
}

export interface PendingApplyRow {
    id: string;
    entry: PendingApplyEntry;
}

/** Build the meta key for a given file-doc id. */
export function pendingApplyKey(docId: string): string {
    return PENDING_APPLY_KEY_PREFIX + docId;
}

/** Recover the file-doc id from a meta key, or null if the key is not in
 *  the pending-apply namespace. */
export function pendingApplyIdFromKey(key: string): string | null {
    if (!key.startsWith(PENDING_APPLY_KEY_PREFIX)) return null;
    return key.slice(PENDING_APPLY_KEY_PREFIX.length);
}

interface MetaReader {
    getMetaByPrefix<V = unknown>(
        prefix: string,
    ): Promise<Array<{ key: string; value: V }>>;
}

/** Load every pending-apply entry from the docs-store meta table. */
export async function loadAllPendingApply(db: MetaReader): Promise<PendingApplyRow[]> {
    const rows = await db.getMetaByPrefix<unknown>(PENDING_APPLY_KEY_PREFIX);
    const out: PendingApplyRow[] = [];
    for (const { key, value } of rows) {
        const id = pendingApplyIdFromKey(key);
        if (id === null) continue;
        const entry = parseEntry(value);
        if (entry) out.push({ id, entry });
    }
    return out;
}

/** Defensive parse — meta values are persisted JSON, so a malformed entry
 *  (manual edit, schema drift) shouldn't crash the load path. */
function parseEntry(raw: unknown): PendingApplyEntry | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Partial<PendingApplyEntry>;
    if (r.reason !== "missing-chunks") return null;
    const addedAt = typeof r.addedAt === "number" ? r.addedAt : 0;
    const attempts = typeof r.attempts === "number" ? r.attempts : 0;
    return { reason: r.reason, addedAt, attempts };
}
