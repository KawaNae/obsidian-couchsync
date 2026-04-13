/**
 * Garbage collection for orphaned chunk documents.
 *
 * Orphan chunks accumulate when:
 *   - A crash occurs between chunk write and FileDoc update (pre-v0.15.0)
 *   - A file's content changes and old chunks are no longer referenced
 *   - A FileDoc is deleted but its chunks remain
 *
 * This module scans all ChunkDocs and deletes those not referenced by any
 * live (non-deleted) FileDoc.
 */

import type { LocalDB } from "./local-db.ts";
import { ID_RANGE } from "../types/doc-id.ts";
import { logInfo } from "../ui/log.ts";

export interface GcResult {
    scannedChunks: number;
    referencedChunks: number;
    deletedChunks: number;
}

export async function gcOrphanChunks(db: LocalDB): Promise<GcResult> {
    // 1. Collect chunk IDs referenced by live FileDocs.
    const fileDocs = await db.allFileDocs();
    const referenced = new Set<string>();
    for (const doc of fileDocs) {
        if (doc.deleted) continue;
        for (const id of doc.chunks) referenced.add(id);
    }

    // 2. Scan all chunk documents.
    const allChunks = await db.allDocs({
        startkey: ID_RANGE.chunk.startkey,
        endkey: ID_RANGE.chunk.endkey,
    });

    // 3. Delete orphans (not referenced by any live FileDoc).
    const orphanIds = allChunks.rows
        .filter((r) => !referenced.has(r.id))
        .map((r) => r.id);

    for (const id of orphanIds) {
        await db.delete(id);
    }

    const result: GcResult = {
        scannedChunks: allChunks.rows.length,
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
