/**
 * PendingConflict — persistent set of file-doc ids whose remote-deletion
 * collided with an unpushed local edit and is awaiting the user's choice.
 *
 * This is the pull-side mirror of `pending-apply.ts` for the OTHER class of
 * "the cursor advanced but the work isn't finished" (Invariant B). When a
 * pulled deletion races a local edit, `PullWriter.handlePulledDeletion` raises
 * an in-memory `concurrent` event for the conflict modal — but the modal is
 * ephemeral. The pull cursor (`META_REMOTE_SEQ`) advances past the deletion's
 * `_changes` seq in the same batch, and CouchDB never re-delivers a consumed
 * seq. So if the user dismisses the modal, misses it, or the app restarts
 * before resolving, the deletion intent is lost and the surviving local edit
 * silently un-deletes the file on the next push.
 *
 * Recording the conflict here, in the SAME `runWriteTx` as the cursor advance
 * (`Checkpoints.commitPullBatch` / `saveEmptyPullBatch`), makes the deletion
 * intent durable: the cursor can never move past a remote deletion without
 * either resolving it or remembering it for re-presentation. `PullWriter`
 * drains the set (re-emitting the conflict) and the ConflictOrchestrator
 * clears an entry once the user resolves it.
 *
 * Stored as one meta entry per id (`_sync/pending-conflict/<fileDocId>`) so
 * add/remove are single-key writes that compose atomically with the cursor
 * advance — exactly the shape `pending-apply` uses.
 */

import type { LocalDB } from "../local-db.ts";

export const PENDING_CONFLICT_KEY_PREFIX = "_sync/pending-conflict/";

export type PendingConflictKind =
    /** Remote deletion pulled while the local copy had an unpushed edit.
     *  Re-presented by rebuilding a tombstone as the remote side. */
    | "pull-delete-vs-edit"
    /** The mirror: the local copy is a soft-delete tombstone and the pulled
     *  remote doc is a concurrent ALIVE edit (#7). Re-presented by re-fetching
     *  the remote edit, since the surviving local side is the tombstone. */
    | "local-delete-vs-remote-edit"
    /** Both sides are concurrent ALIVE edits. Persisted so the user can DEFER
     *  the conflict (× = 保留) without losing the remote edit: the pull cursor
     *  advances past the remote rev without accepting it, so re-presentation
     *  re-fetches the remote doc (`getRemoteDoc`) and re-validates it.
     *  Pre-defer this was not persisted because keep-local kept the remote rev
     *  retrievable; defer broke that assumption (2026-06-02 incident). */
    | "edit-vs-edit";

export interface PendingConflictEntry {
    addedAt: number;
    kind: PendingConflictKind;
}

export interface PendingConflictRow {
    id: string;
    entry: PendingConflictEntry;
}

/** Build the meta key for a given file-doc id. */
export function pendingConflictKey(docId: string): string {
    return PENDING_CONFLICT_KEY_PREFIX + docId;
}

/** Recover the file-doc id from a meta key, or null if not in the namespace. */
export function pendingConflictIdFromKey(key: string): string | null {
    if (!key.startsWith(PENDING_CONFLICT_KEY_PREFIX)) return null;
    return key.slice(PENDING_CONFLICT_KEY_PREFIX.length);
}

interface MetaReader {
    getMetaByPrefix<V = unknown>(
        prefix: string,
    ): Promise<Array<{ key: string; value: V }>>;
}

/** Load every pending-conflict entry from the docs-store meta table. */
export async function loadAllPendingConflict(db: MetaReader): Promise<PendingConflictRow[]> {
    const rows = await db.getMetaByPrefix<unknown>(PENDING_CONFLICT_KEY_PREFIX);
    const out: PendingConflictRow[] = [];
    for (const { key, value } of rows) {
        const id = pendingConflictIdFromKey(key);
        if (id === null) continue;
        const entry = parseEntry(value);
        if (entry) out.push({ id, entry });
    }
    return out;
}

/**
 * Remove a single pending-conflict entry. Called by the ConflictOrchestrator
 * once the user resolves the deletion conflict (take-remote or keep-local) or
 * it is auto-resolved by another device. Deleting an absent key is a no-op.
 */
export async function clearPendingConflict(db: LocalDB, docId: string): Promise<void> {
    await db.runWriteTx({
        meta: [{ op: "delete", key: pendingConflictKey(docId) }],
    });
}

/** Defensive parse — meta values are persisted JSON, so a malformed entry
 *  shouldn't crash the load path. */
function parseEntry(raw: unknown): PendingConflictEntry | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Partial<PendingConflictEntry>;
    if (
        r.kind !== "pull-delete-vs-edit" &&
        r.kind !== "local-delete-vs-remote-edit" &&
        r.kind !== "edit-vs-edit"
    ) {
        return null;
    }
    const addedAt = typeof r.addedAt === "number" ? r.addedAt : 0;
    return { kind: r.kind, addedAt };
}
