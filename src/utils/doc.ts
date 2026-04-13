/**
 * Utility for stripping CouchDB `_rev` from documents before local storage.
 *
 * Replaces the `{ _rev, ...rest } = doc as any` pattern used across the
 * codebase with a type-safe function.
 */

/** Strip `_rev` from a document, returning the rest with correct types. */
export function stripRev<T extends { _rev?: string }>(
    doc: T,
): Omit<T, "_rev"> {
    const { _rev, ...rest } = doc;
    return rest;
}
