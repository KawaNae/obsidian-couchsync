/**
 * Garbage collection for orphaned chunk documents.
 *
 * Orphan chunks accumulate when:
 *   - A crash occurs between chunk write and FileDoc update (pre-v0.15.0)
 *   - A file's content changes and old chunks are no longer referenced
 *   - A FileDoc is deleted but its chunks remain
 *
 * Scans the full chunk id range using the body-free `listIds` primitive,
 * then deletes every chunk not referenced by any live (non-deleted)
 * FileDoc.
 */

import type { LocalDB } from "./local-db.ts";
import { ID_RANGE } from "../types/doc-id.ts";
import { collectReferencedChunks } from "./chunk-refs.ts";
import { logInfo } from "../ui/log.ts";

export interface GcResult {
    scannedChunks: number;
    referencedChunks: number;
    deletedChunks: number;
}

export async function gcOrphanChunks(db: LocalDB): Promise<GcResult> {
    // 1. Live-FileDoc reference set, via the shared helper.
    const fileDocs = await db.allFileDocs();
    const referenced = collectReferencedChunks(fileDocs);

    // 2. Enumerate chunk ids without loading bodies. For a 50k-chunk
    //    vault, include_docs-style `allDocs` would pull ~6.5 GB into
    //    memory; `listIds` uses the primary-key index directly.
    const chunkIds = await db.listIds({
        startkey: ID_RANGE.chunk.startkey,
        endkey: ID_RANGE.chunk.endkey,
    });

    // 3. Delete orphans atomically: one rw tx so a crash mid-GC cannot
    //    leave `_update_seq` inconsistent — either every orphan is gone
    //    or none of them are.
    const orphanIds = chunkIds.filter((id) => !referenced.has(id));
    if (orphanIds.length > 0) {
        await db.runWriteTx({ deletes: orphanIds });
    }

    const result: GcResult = {
        scannedChunks: chunkIds.length,
        referencedChunks: referenced.size,
        deletedChunks: orphanIds.length,
    };

    if (result.deletedChunks > 0) {
        logInfo(
            `Chunk GC: scanned ${result.scannedChunks}, ` +
                `referenced ${result.referencedChunks}, ` +
                `deleted ${result.deletedChunks} orphan(s)`,
        );
    }

    return result;
}
