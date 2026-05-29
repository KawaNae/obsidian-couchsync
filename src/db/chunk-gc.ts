/**
 * Garbage collection for orphaned chunk documents.
 *
 * Orphan chunks accumulate when:
 *   - A crash occurs between chunk write and owner-doc update (pre-v0.15
 *     for FileDocs; new code path for ConfigDocs since v0.26)
 *   - An owner file/config's content changes and old chunks are no longer
 *     referenced
 *   - An owner doc is deleted but its chunks remain
 *
 * Scans the full chunk id range using the body-free `listIds` primitive,
 * then deletes every chunk not referenced by any live (non-deleted)
 * owner doc.
 *
 * Generic over the owner-doc kind (invariant 16): vault FileDocs live in
 * LocalDB, ConfigDocs live in ConfigLocalDB, and chunks are scoped per
 * DB. Two convenience wrappers (`gcOrphanChunks` for vault,
 * `gcOrphanConfigChunks` for config) wire the right doc enumerator into
 * the shared core so callers never need to remember which collector
 * function pairs with which store.
 */

import type { LocalDB } from "./local-db.ts";
import type { ConfigLocalDB } from "./config-local-db.ts";
import type { CouchSyncDoc } from "../types.ts";
import type { WriteTransaction } from "./write-transaction.ts";
import type { ListIdsRange } from "./interfaces.ts";
import { ID_RANGE, configPathFromId } from "../types/doc-id.ts";
import { collectFileChunkRefs, collectReferencedChunks } from "./chunk-refs.ts";
import { logInfo } from "../ui/log.ts";

export interface GcResult {
    scannedChunks: number;
    referencedChunks: number;
    deletedChunks: number;
}

/** Minimal store surface needed by the GC core: enumerate ids in the
 *  chunk range and atomically delete a list of them. Both `LocalDB`
 *  and `ConfigLocalDB` satisfy this. */
interface ChunkSweepStore {
    listIds(range: ListIdsRange): Promise<string[]>;
    runWriteTx(tx: WriteTransaction<CouchSyncDoc>): Promise<void>;
}

/** Shared sweep — caller passes the live-owner reference map; we
 *  enumerate chunk ids without bodies and delete the unreferenced ones
 *  in a single rw tx so `_update_seq` cannot land half-applied. */
async function sweepOrphanChunks(
    db: ChunkSweepStore,
    referenced: Map<string, string[]>,
    label: string,
): Promise<GcResult> {
    // Enumerate chunk ids without loading bodies. For a 50k-chunk vault,
    // include_docs-style `allDocs` would pull ~6.5 GB into memory; the
    // `listIds` primitive uses the primary-key index directly.
    const chunkIds = await db.listIds({
        startkey: ID_RANGE.chunk.startkey,
        endkey: ID_RANGE.chunk.endkey,
    });

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
            `${label}: scanned ${result.scannedChunks}, ` +
                `referenced ${result.referencedChunks}, ` +
                `deleted ${result.deletedChunks} orphan(s)`,
        );
    }

    return result;
}

/** Sweep orphan chunks in the vault DB. References are derived from
 *  live FileDocs (deleted ones do not pin chunks). */
export async function gcOrphanChunks(db: LocalDB): Promise<GcResult> {
    const fileDocs = await db.allFileDocs();
    const referenced = collectFileChunkRefs(fileDocs);
    return sweepOrphanChunks(db, referenced, "Chunk GC");
}

/** Sweep orphan chunks in the config DB. References are derived from
 *  live ConfigDocs. Invariant 16 keeps the reference graph scoped to
 *  the config DB: config chunks are not visible from the vault DB and
 *  vice versa, so this sweep cannot accidentally delete a chunk that
 *  is still referenced from the other DB. */
export async function gcOrphanConfigChunks(db: ConfigLocalDB): Promise<GcResult> {
    const configDocs = await db.allConfigDocs();
    const referenced = collectReferencedChunks(
        configDocs,
        (cd) => configPathFromId(cd._id),
    );
    return sweepOrphanChunks(db, referenced, "Config Chunk GC");
}
