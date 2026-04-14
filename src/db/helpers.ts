/**
 * Shorthands over `LocalDB.runWrite` for the two most common atomic-write
 * patterns in this codebase. Kept intentionally small — any other shape
 * should be expressed as an inline `runWrite({...})` so "what happens in
 * one tx" stays explicit at the call site.
 */

import type { LocalDB } from "./local-db.ts";
import type { CouchSyncDoc } from "../types.ts";
import type { VectorClock } from "../sync/vector-clock.ts";

/**
 * Commit a single document in its own tx. Optional `expectedVclock`
 * enables vclock CAS — the tx aborts with `DbError(kind:"conflict")` if
 * the stored vclock differs (caller-side retry if desired).
 */
export async function putDoc(
    db: LocalDB,
    doc: CouchSyncDoc,
    expectedVclock?: VectorClock,
): Promise<void> {
    await db.runWrite({
        docs: [{ doc, ...(expectedVclock !== undefined ? { expectedVclock } : {}) }],
    });
}

/**
 * Commit many documents in one tx. No CAS — callers that need CAS should
 * issue separate `runWrite` calls (or a single builder) per doc. Empty
 * input is a no-op.
 */
export async function putDocs(
    db: LocalDB,
    docs: CouchSyncDoc[],
): Promise<void> {
    if (docs.length === 0) return;
    await db.runWrite({
        docs: docs.map((doc) => ({ doc })),
    });
}
