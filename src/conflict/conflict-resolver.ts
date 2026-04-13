import type { CouchSyncDoc, FileDoc, ConfigDoc } from "../types.ts";
import { isFileDoc, isConfigDoc } from "../types.ts";
import { compareVC } from "../sync/vector-clock.ts";
import { filePathFromId, configPathFromId } from "../types/doc-id.ts";
import { logDebug, logWarn } from "../ui/log.ts";

/**
 * Resolves conflicts using Vector Clock causality.
 *
 *   resolveOnPull(localDoc, remoteDoc) → "take-remote" | "keep-local" | "concurrent"
 *
 * Called during the pull path (SyncEngine / remote-couch helpers)
 * when a remote document differs from the local version. The caller acts
 * on the returned verdict:
 *   - "take-remote": overwrite local with remote
 *   - "keep-local": skip (local is newer, will be pushed eventually)
 *   - "concurrent": invoke onConcurrent callback for human resolution
 *
 * Two-instance pattern: one instance for vault DB (FileDoc), one for
 * config DB (ConfigDoc).
 */

/** A doc that ConflictResolver can process. Both kinds carry a vclock. */
type ResolvableDoc = FileDoc | ConfigDoc;

/** Result of a pull-time conflict check. */
export type PullVerdict = "take-remote" | "keep-local" | "concurrent";

/**
 * Fired when a pull-time comparison yields concurrent (VC-incomparable)
 * edits. The `vaultPath` argument is the bare vault path (for FileDoc)
 * or the `.obsidian/...` path (for ConfigDoc).
 */
export type OnConcurrentConflict = (
    vaultPath: string,
    revisions: ResolvableDoc[],
) => void | Promise<void>;

/**
 * Fired when a conflict auto-resolved (one revision dominated the rest).
 * `vaultPath` is the bare vault path. `winner` is the dominating revision,
 * `losers` are the superseded revisions.
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

    constructor(
        private onAutoResolved: OnAutoResolved | null = null,
    ) {}

    setOnConcurrent(handler: OnConcurrentConflict): void {
        this.onConcurrent = handler;
    }

    setOnAutoResolved(handler: OnAutoResolved): void {
        this.onAutoResolved = handler;
    }

    /**
     * Compare a local doc against a remote doc during pull. Returns
     * a verdict telling the caller what to do.
     *
     * If the verdict is "take-remote" and onAutoResolved is registered,
     * fires the callback with the remote doc as winner and local as loser.
     *
     * If the verdict is "concurrent" and onConcurrent is registered,
     * fires the callback so the UI can surface it.
     */
    async resolveOnPull(
        localDoc: ResolvableDoc | null,
        remoteDoc: ResolvableDoc,
    ): Promise<PullVerdict> {
        // No local version — always take remote.
        if (!localDoc) return "take-remote";

        const localVC = localDoc.vclock ?? {};
        const remoteVC = remoteDoc.vclock ?? {};
        const cmp = compareVC(localVC, remoteVC);

        const vaultPath = extractVaultPath(remoteDoc._id);

        switch (cmp) {
            case "equal":
                // Identical vclocks — content may or may not differ, but
                // causally they're the same edit. Keep local (no-op).
                return "keep-local";

            case "dominated":
                // Remote dominates local — take remote.
                if (this.onAutoResolved) {
                    try {
                        await this.onAutoResolved(vaultPath, remoteDoc, [localDoc]);
                    } catch (e) {
                        console.error(
                            `CouchSync: onAutoResolved callback failed for ${vaultPath}:`,
                            e,
                        );
                    }
                }
                logDebug(`auto-resolved: remote dominates local for ${vaultPath}`);
                return "take-remote";

            case "dominates":
                // Local dominates remote — keep local (push pending).
                logDebug(`keep-local: local dominates remote for ${vaultPath}`);
                return "keep-local";

            case "concurrent":
                // Neither dominates — true conflict, needs human judgment.
                if (this.onConcurrent) {
                    await this.onConcurrent(vaultPath, [localDoc, remoteDoc]);
                } else {
                    logWarn(
                        `CouchSync: concurrent conflict on ${vaultPath} but no handler registered.`,
                    );
                }
                return "concurrent";

            default:
                return "keep-local";
        }
    }

    /**
     * Legacy no-op: _conflicts trees are not used. Conflict resolution
     * happens via resolveOnPull() during the pull path.
     */
    async resolveIfConflicted(doc: CouchSyncDoc): Promise<boolean> {
        if (!(doc as any)._conflicts || (doc as any)._conflicts.length === 0) return false;
        if (!isFileDoc(doc) && !isConfigDoc(doc)) return false;

        const vaultPath = extractVaultPath(doc._id);
        logDebug(
            `resolveIfConflicted: ignoring _conflicts tree for ${vaultPath} ` +
            `(use resolveOnPull instead)`,
        );
        return false;
    }

    /**
     * Legacy no-op: returns 0. Conflict resolution uses resolveOnPull().
     * Called by the Maintenance tab's "Scan Conflicts" button.
     */
    async scanConflicts(): Promise<number> {
        return 0;
    }
}

/** Test helper exported for unit tests. Not part of the public API. */
export function _compareVCForTest(
    a: ResolvableDoc,
    b: ResolvableDoc,
): ReturnType<typeof compareVC> {
    return compareVC(a.vclock ?? {}, b.vclock ?? {});
}
