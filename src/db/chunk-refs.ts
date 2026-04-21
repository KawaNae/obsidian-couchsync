/**
 * Shared helper for computing the set of chunks that are referenced by
 * live (non-deleted) FileDocs. Used by both `chunk-gc` (single-store GC)
 * and `sync/chunk-consistency` (cross-store diff). Centralising the rule
 * prevents the two callers from drifting on what counts as a reference.
 */

import type { FileDoc } from "../types.ts";
import { filePathFromId } from "../types/doc-id.ts";

/**
 * Build a chunk-id → referencing-file-paths map from an iterable of
 * FileDocs. Deleted FileDocs are skipped (matches the invariant in
 * `gcOrphanChunks`: a deleted FileDoc never pins its chunks).
 */
export function collectReferencedChunks(
    fileDocs: Iterable<FileDoc>,
): Map<string, string[]> {
    const refs = new Map<string, string[]>();
    for (const fd of fileDocs) {
        if (fd.deleted) continue;
        const path = filePathFromId(fd._id);
        for (const cid of fd.chunks) {
            const arr = refs.get(cid);
            if (arr) arr.push(path);
            else refs.set(cid, [path]);
        }
    }
    return refs;
}
