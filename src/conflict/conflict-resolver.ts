/// <reference types="pouchdb-browser" />
import type { CouchSyncDoc, FileDoc, ConfigDoc } from "../types.ts";
import { isFileDoc, isConfigDoc } from "../types.ts";
import { compareVC, findDominator } from "../sync/vector-clock.ts";
import { filePathFromId, configPathFromId } from "../types/doc-id.ts";

/**
 * Resolves PouchDB conflict trees using Vector Clock causality.
 *
 * For each conflicting FileDoc or ConfigDoc:
 *  1. Fetch every conflicting revision.
 *  2. If one revision causally dominates (or equals) every other, it is a
 *     safe auto-resolution — the dominated revisions are removed and the
 *     dominator becomes the sole current rev.
 *  3. If any pair of revisions is *concurrent* (incomparable VCs), the
 *     conflict requires human judgment. The `onConcurrent` callback is
 *     invoked with the path and the full revision set so the UI can raise
 *     a modal. No revisions are removed and the PouchDB conflict tree is
 *     left intact until the user resolves it.
 *
 * Physical timestamps (mtime, editedAt) are never consulted — that was the
 * old behavior and it silently dropped writes under clock skew / network
 * delay. Now the only source of truth for ordering is the vclock field.
 *
 * ## Two-instance pattern (v0.11.0+)
 *
 * The same class is instantiated twice in production: once for the vault
 * DB (resolves FileDoc conflicts) and once for the config DB (resolves
 * ConfigDoc conflicts). The constructor takes a `getDb()` accessor so
 * each instance points at its own PouchDB. The dispatch in
 * `resolveIfConflicted` accepts both doc kinds and extracts the
 * user-facing vault path appropriately.
 */

/** A doc that ConflictResolver can process. Both kinds carry a vclock. */
type ResolvableDoc = FileDoc | ConfigDoc;

/**
 * Fired when a conflict tree is causally concurrent (no dominator).
 * The `vaultPath` argument is the bare vault path (for FileDoc) or the
 * `.obsidian/...` path (for ConfigDoc), NOT the PouchDB _id — safe to
 * forward directly to history capture, UI notices, modals, etc.
 */
export type OnConcurrentConflict = (
    vaultPath: string,
    revisions: ResolvableDoc[],
) => void | Promise<void>;

/**
 * Fired when a conflict auto-resolved (one revision dominated the rest).
 * `vaultPath` is the bare vault path. `winner` is the dominating revision,
 * `losers` are the superseded revisions (already removed from PouchDB).
 */
export type OnAutoResolved = (
    vaultPath: string,
    winner: ResolvableDoc,
    losers: ResolvableDoc[],
) => void | Promise<void>;

/**
 * Extract the user-facing path from a doc id. Throws for unknown id
 * shapes — that should never happen because we filter by `isFileDoc ||
 * isConfigDoc` before calling, and the schema guard rejects bare ids.
 */
function extractVaultPath(id: string): string {
    if (id.startsWith("file:")) return filePathFromId(id);
    if (id.startsWith("config:")) return configPathFromId(id);
    throw new Error(`extractVaultPath: unknown id shape: ${id}`);
}

export class ConflictResolver {
    private onConcurrent: OnConcurrentConflict | null = null;

    /**
     * @param getDb     Returns the PouchDB instance to scan/resolve against.
     *                  Vault use: `() => localDb.getDb()`.
     *                  Config use: `() => configLocalDb.getDb()`.
     * @param onAutoResolved Optional callback fired after a safe
     *                  auto-resolution. Receives the bare vault path,
     *                  the winning revision, and the superseded losers.
     */
    constructor(
        private getDb: () => PouchDB.Database<CouchSyncDoc>,
        private onAutoResolved: OnAutoResolved | null = null,
    ) {}

    setOnConcurrent(handler: OnConcurrentConflict): void {
        this.onConcurrent = handler;
    }

    setOnAutoResolved(handler: OnAutoResolved): void {
        this.onAutoResolved = handler;
    }

    /**
     * Inspect `doc` for PouchDB conflicts and resolve them if possible.
     * Returns true if the conflict was auto-resolved, false if no conflict
     * existed, was an unsupported doc type, or required human resolution.
     */
    async resolveIfConflicted(doc: CouchSyncDoc): Promise<boolean> {
        if (!doc._conflicts || doc._conflicts.length === 0) return false;
        if (!isFileDoc(doc) && !isConfigDoc(doc)) return false;

        // Extract the vault path once so every downstream callback and
        // log line reports the user-meaningful path instead of the
        // prefixed PouchDB id. PouchDB operations (get/put/remove) still
        // use the raw `doc._id` since that's what they index on.
        const vaultPath = extractVaultPath(doc._id);
        const db = this.getDb();
        const winnerRev = doc._rev;
        const revisions: ResolvableDoc[] = [doc as ResolvableDoc];
        for (const rev of doc._conflicts) {
            try {
                const r = (await db.get(doc._id, { rev })) as unknown as ResolvableDoc;
                revisions.push(r);
            } catch (e) {
                console.error(
                    `CouchSync: failed to load conflict rev ${rev} for ${vaultPath}:`,
                    e,
                );
            }
        }

        const dominator = findDominator(revisions);
        if (dominator) {
            // Safe auto-resolution: promote the dominator to current and
            // remove every other revision from the conflict tree.
            if (dominator._rev !== winnerRev) {
                // Replace the current winner's content with the dominator's
                // while keeping the current rev chain so PouchDB accepts
                // it as an update.
                const merged = {
                    ...dominator,
                    _id: doc._id,
                    _rev: winnerRev,
                } as ResolvableDoc;
                delete (merged as { _conflicts?: unknown })._conflicts;
                await db.put(merged as unknown as CouchSyncDoc);
            }
            const losers: ResolvableDoc[] = [];
            for (const rev of revisions) {
                if (rev._rev === winnerRev) continue;
                losers.push(rev);
                try {
                    if (rev._rev) await db.remove(doc._id, rev._rev);
                } catch (e) {
                    console.error(
                        `CouchSync: failed to remove rev ${rev._rev} for ${vaultPath}:`,
                        e,
                    );
                }
            }
            if (this.onAutoResolved && losers.length > 0) {
                try {
                    await this.onAutoResolved(vaultPath, dominator, losers);
                } catch (e) {
                    console.error(
                        `CouchSync: onAutoResolved callback failed for ${vaultPath}:`,
                        e,
                    );
                }
            }
            console.log(
                `CouchSync: auto-resolved ${doc._conflicts.length} conflict(s) for ${vaultPath}`,
            );
            return true;
        }

        // Concurrent — no single dominator. Raise to human.
        if (this.onConcurrent) {
            await this.onConcurrent(vaultPath, revisions);
        } else {
            console.warn(
                `CouchSync: concurrent conflict on ${vaultPath} but no handler registered; ` +
                    "leaving PouchDB conflict tree intact.",
            );
        }
        return false;
    }

    /**
     * Walk every doc with a conflict tree and attempt to resolve each.
     * Used as the post-replication-batch hook so conflicts are detected
     * as soon as PouchDB sync materialises them.
     */
    async scanConflicts(): Promise<number> {
        const db = this.getDb();
        const result = await db.allDocs({
            include_docs: true,
            conflicts: true,
        });

        let resolved = 0;
        for (const row of result.rows) {
            if (!("doc" in row) || !row.doc) continue;
            const d = row.doc as unknown as CouchSyncDoc;
            if (!d._conflicts || d._conflicts.length === 0) continue;
            if (await this.resolveIfConflicted(d)) resolved++;
        }
        return resolved;
    }
}

/** Test helper exported for unit tests. Not part of the public API. */
export function _compareVCForTest(
    a: ResolvableDoc,
    b: ResolvableDoc,
): ReturnType<typeof compareVC> {
    return compareVC(a.vclock ?? {}, b.vclock ?? {});
}
