/**
 * UnpushedIds — persistent set of doc ids that the push pipeline could
 * not place on remote in their last attempt.
 *
 * Stored as one meta entry per id (`_sync/unpushed/<docId>`) rather than
 * a single dump, so add/remove are single-key writes that compose with
 * other meta changes inside one `runWriteTx` (atomic with cursor advance).
 * Same shape and access pattern as the per-path `_local/vclock/<path>`
 * lastSynced entries — `getMetaByPrefix` returns the full set.
 *
 * Cursor advance and unpushed-set mutation must commit together: see
 * `Checkpoints.commitPushCycle`. Without that pairing a crash mid-write
 * can leak a "cursor advanced past id X but X never made the set",
 * recreating the very silent-loss the set exists to prevent.
 */

export const UNPUSHED_KEY_PREFIX = "_sync/unpushed/";

export type UnpushedReason =
    /** bulkDocs returned conflict despite vclock pre-classify; race on
     *  remote rev between allDocs and bulkDocs. Auto-retries each cycle. */
    | "race-stale"
    /** vclock comparison flagged concurrent or dominated; needs ConflictOrchestrator
     *  resolution (or a future pull) to converge. */
    | "divergent";

export interface UnpushedEntry {
    addedAt: number;
    reason: UnpushedReason;
    /** How many cycles have re-tried this id without success. Used to
     *  escalate persistent race-stale conflicts to divergent so the
     *  orchestrator can surface them rather than retry forever. */
    attempts: number;
}

export interface UnpushedRow {
    id: string;
    entry: UnpushedEntry;
}

/** Build the meta key for a given doc id. */
export function unpushedKey(docId: string): string {
    return UNPUSHED_KEY_PREFIX + docId;
}

/** Recover the doc id from a meta key, or null if the key is not in the
 *  unpushed namespace. */
export function unpushedIdFromKey(key: string): string | null {
    if (!key.startsWith(UNPUSHED_KEY_PREFIX)) return null;
    return key.slice(UNPUSHED_KEY_PREFIX.length);
}

interface MetaReader {
    getMetaByPrefix<V = unknown>(
        prefix: string,
    ): Promise<Array<{ key: string; value: V }>>;
}

/** Load every unpushed entry from the docs-store meta table. */
export async function loadAllUnpushed(db: MetaReader): Promise<UnpushedRow[]> {
    const rows = await db.getMetaByPrefix<unknown>(UNPUSHED_KEY_PREFIX);
    const out: UnpushedRow[] = [];
    for (const { key, value } of rows) {
        const id = unpushedIdFromKey(key);
        if (id === null) continue;
        const entry = parseEntry(value);
        if (entry) out.push({ id, entry });
    }
    return out;
}

/** Defensive parse — meta values are persisted JSON, so a malformed entry
 *  (manual edit, schema drift) shouldn't crash the load path. */
function parseEntry(raw: unknown): UnpushedEntry | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Partial<UnpushedEntry>;
    const reason = r.reason;
    if (reason !== "race-stale" && reason !== "divergent") return null;
    const addedAt = typeof r.addedAt === "number" ? r.addedAt : 0;
    const attempts = typeof r.attempts === "number" ? r.attempts : 0;
    return { reason, addedAt, attempts };
}
