/**
 * Shared helper for computing the set of chunks that are referenced by
 * live (non-deleted) chunk-owning docs.
 *
 * Generic over the owner doc kind: vault FileDocs (chunks live in the
 * vault DB) and ConfigDocs (chunks live in the separate config DB) both
 * carry `chunks: string[]` and `deleted?: boolean`, and the GC / repair
 * machinery only needs a label per owner (used in human-readable
 * "referencedBy" diagnostics).
 *
 * Two callers downstream:
 *   - `chunk-gc.ts` — single-store orphan sweep
 *   - `sync/chunk-consistency.ts` — cross-store diff
 *
 * Centralising the rule prevents the callers from drifting on what
 * counts as a reference. Invariant 16: chunk reference graphs are
 * scoped to a single owner-doc kind; mixing vault and config refs in
 * one map would silently break orphan accounting.
 */

import type { FileDoc } from "../types.ts";
import { filePathFromId } from "../types/doc-id.ts";

/** Minimum shape of any doc that owns chunks. Both FileDoc and ConfigDoc
 *  satisfy this. The generic constraint is intentionally narrow so
 *  callers can't accidentally pass a ChunkDoc (which would type-check
 *  if we only required `_id`). */
export interface ChunkOwnerDoc {
    _id: string;
    chunks: string[];
    deleted?: boolean;
}

/**
 * Build a `chunk-id → referencing-owner-labels` map from an iterable of
 * chunk-owning docs. `deleted` docs are skipped (matches the invariant
 * in `gcOrphanChunks`: a deleted owner never pins its chunks).
 *
 * `labelOf` returns the per-owner label written into the reference list
 * — for FileDoc that's the vault path, for ConfigDoc that's the config
 * path. Tests / diagnostics use this label to identify the owner; it is
 * not load-bearing for orphan detection (the keys are).
 */
export function collectReferencedChunks<TDoc extends ChunkOwnerDoc>(
    docs: Iterable<TDoc>,
    labelOf: (d: TDoc) => string,
): Map<string, string[]> {
    const refs = new Map<string, string[]>();
    for (const d of docs) {
        if (d.deleted) continue;
        const label = labelOf(d);
        for (const cid of d.chunks) {
            const arr = refs.get(cid);
            if (arr) arr.push(label);
            else refs.set(cid, [label]);
        }
    }
    return refs;
}

/** Convenience wrapper: vault FileDocs labelled by vault path. The most
 *  common caller (chunk-gc, chunk-consistency for vault) goes through
 *  this helper so it doesn't have to remember the label policy. */
export function collectFileChunkRefs(
    fileDocs: Iterable<FileDoc>,
): Map<string, string[]> {
    return collectReferencedChunks(fileDocs, (fd) => filePathFromId(fd._id));
}
