/**
 * Order-sensitive chunk-list equality.
 *
 * Chunks are content-addressed (xxhash), so identical IDs ⇒ identical bytes.
 * The `chunkListsEqual` helper compares two ordered chunk arrays. Used by
 * the sync classifier (`classify-sync-relation.ts`) and by call sites that
 * still want a direct content fingerprint comparison without going through
 * the full classifier.
 */

export function chunkListsEqual(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
