import type { FileDoc, ConfigDoc } from "../types.ts";
import { isFileDoc } from "../types.ts";
import { classifySyncRelation } from "../sync/classify-sync-relation.ts";
import { filePathFromId, configPathFromId } from "../types/doc-id.ts";
import { logDebug, logWarn } from "../ui/log.ts";

/**
 * Resolves conflicts using the unified `classifySyncRelation` classifier.
 *
 *   resolveOnPull(localDoc, remoteDoc)
 *     → "take-remote" | "keep-local" | "concurrent" | "silent-merge"
 *
 * Called during the pull path (SyncEngine / remote-couch helpers)
 * when a remote document differs from the local version. The caller acts
 * on the returned verdict:
 *   - "take-remote": overwrite local with remote
 *   - "keep-local": skip (local is newer, will be pushed eventually)
 *   - "concurrent": enqueue for human resolution via SyncEngine.onConcurrent
 *   - "silent-merge": chunks identical but vclocks drifted — caller must
 *     `mergeVC` and commit the remote doc with the merged clock; do NOT
 *     enqueue a concurrent event. Closes audit-2026-05-08 MEDIUM
 *     (false-positive concurrent on initial-sync devices).
 *
 * **CLASSIFIER:** routes through `classifySyncRelation` (the single source
 * of truth). Do not duplicate the chunks/vclock matrix logic here.
 *
 * Two-instance pattern: one instance for vault DB (FileDoc), one for
 * config DB (ConfigDoc).
 */

/** A doc that ConflictResolver can process. Both kinds carry a vclock. */
type ResolvableDoc = FileDoc | ConfigDoc;

/** Result of a pull-time conflict check. */
export type PullVerdict = "take-remote" | "keep-local" | "concurrent" | "silent-merge";

/**
 * Adapt a doc into the chunks/size fingerprint the classifier expects.
 * FileDoc passes `chunks` directly; ConfigDoc wraps `data` (base64 of the
 * full content) into a 1-element array — content-addressed equality still
 * holds. Tombstones with `chunks:[]` and `size:0` compare correctly:
 * deleted-vs-deleted is identical, deleted-vs-alive is content-differing.
 */
function asContent(doc: ResolvableDoc): { chunks: readonly string[]; size: number } {
    if (isFileDoc(doc)) {
        return { chunks: doc.chunks, size: doc.size };
    }
    // ConfigDoc.data is base64 of the file. Use the data string itself as
    // a single-element fingerprint — equal data ⇒ equal content.
    return { chunks: [doc.data], size: doc.size };
}

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

        const localContent = asContent(localDoc);
        const remoteContent = asContent(remoteDoc);
        const localVC = localDoc.vclock ?? {};
        const remoteVC = remoteDoc.vclock ?? {};

        // CLASSIFIER: pure chunks×vclock matrix. Do not branch on
        // compareVC directly — the classifier already does that and
        // additionally detects vclock-only-drift (= silent-merge),
        // closing audit-2026-05-08 MEDIUM (false-positive concurrent
        // on initial-sync devices).
        const relation = classifySyncRelation({
            leftVC: localVC,
            leftChunks: localContent.chunks,
            leftSize: localContent.size,
            rightVC: remoteVC,
            rightChunks: remoteContent.chunks,
            rightSize: remoteContent.size,
            // No `lastSynced` — pull-side replication is independent of
            // vault integration state. Without baseline the classifier
            // never returns `legacy-skip` here.
        });

        const vaultPath = extractVaultPath(remoteDoc._id);

        switch (relation) {
            case "identical":
                // Same content + same vclock — already converged. Caller
                // normally short-circuits before reaching here (pull-writer
                // skips on `compareVC === "equal"`); kept as a safe
                // fallback.
                return "keep-local";

            case "vclock-only-drift":
                // Same content, different vclocks. Silent-merge: caller
                // mergeVC's the clocks and commits remote doc with the
                // merged clock. No concurrent event.
                logDebug(
                    `silent-merge (vclock-only-drift) for ${vaultPath} — ` +
                    `local=${formatVC(localVC)} remote=${formatVC(remoteVC)}`,
                );
                return "silent-merge";

            case "remote-edit":
                // Remote dominates with new content — normal pull update.
                return "take-remote";

            case "local-edit":
                // Local has newer content (vclock equal/dominates, chunks
                // differ). Push pending.
                logDebug(
                    `keep-local (local newer) for ${vaultPath} — local=${formatVC(localVC)} remote=${formatVC(remoteVC)}`,
                );
                return "keep-local";

            case "true-divergent":
                // Both sides changed concurrently — needs human judgment.
                logWarn(
                    `CouchSync: concurrent conflict on ${vaultPath} — enqueued for resolution.`,
                );
                return "concurrent";

            case "legacy-skip":
                // Should not happen here (no lastSynced passed); fall back
                // to keep-local for safety.
                logDebug(
                    `keep-local (legacy-skip fallback) for ${vaultPath}`,
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
