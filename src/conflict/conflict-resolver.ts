import type { FileDoc, ConfigDoc } from "../types.ts";
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
 *   - "concurrent": enqueue for human resolution via SyncEngine.onConcurrent
 *
 * Pure vclock comparison — no side effects, no callbacks.
 *
 * Two-instance pattern: one instance for vault DB (FileDoc), one for
 * config DB (ConfigDoc).
 */

/** A doc that ConflictResolver can process. Both kinds carry a vclock. */
type ResolvableDoc = FileDoc | ConfigDoc;

/** Result of a pull-time conflict check. */
export type PullVerdict = "take-remote" | "keep-local" | "concurrent";

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
    /**
     * Compare a local doc against a remote doc during pull. Returns
     * a verdict telling the caller what to do.
     *
     * No side effects — the caller (SyncEngine) is responsible for
     * acting on the verdict (enqueuing concurrent conflicts, etc.).
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
                logDebug(
                    `keep-local (equal vclock) for ${vaultPath} — vc=${formatVC(localVC)}`,
                );
                return "keep-local";

            case "dominated":
                // Remote dominates local — normal update, not a conflict.
                // History is preserved by dbToFile → captureSyncWrite.
                return "take-remote";

            case "dominates":
                // Local dominates remote — keep local (push pending).
                logDebug(
                    `keep-local (local dominates) for ${vaultPath} — local=${formatVC(localVC)} remote=${formatVC(remoteVC)}`,
                );
                return "keep-local";

            case "concurrent":
                // Neither dominates — true conflict, needs human judgment.
                logWarn(
                    `CouchSync: concurrent conflict on ${vaultPath} — enqueued for resolution.`,
                );
                return "concurrent";

            default:
                logDebug(
                    `keep-local (default branch, cmp=${cmp}) for ${vaultPath} — local=${formatVC(localVC)} remote=${formatVC(remoteVC)}`,
                );
                return "keep-local";
        }
    }
}

/** Compact vclock formatter for diagnostic logs: `{deviceA:3,deviceB:1}`.
 *  Sorted by device id for stable output across log lines. */
function formatVC(vc: Record<string, number>): string {
    const keys = Object.keys(vc).sort();
    if (keys.length === 0) return "{}";
    return "{" + keys.map((k) => `${k}:${vc[k]}`).join(",") + "}";
}
