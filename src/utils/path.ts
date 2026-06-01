/**
 * Path normalization for case-insensitive comparison and lookup.
 *
 * `PathKey` is a nominal-typed normalized form: NFC-normalized + lowercased.
 * It exists ONLY for set/map keys and equality checks where we need to
 * treat case-folded duplicates as the same logical path (case-insensitive
 * filesystems, Unicode-equivalent forms).
 *
 * NEVER use a PathKey for filesystem I/O — the original-case path must
 * be preserved for correct read/write against the underlying FS. Pair
 * `PathKey` with the raw `string` path wherever both are needed.
 */

export type PathKey = string & { readonly __pathKey: unique symbol };

export function toPathKey(p: string): PathKey {
    return p.normalize("NFC").toLowerCase() as PathKey;
}

/**
 * The parent folder of a vault path, or "" for a root-level path. Original
 * case is preserved (this is for FS I/O, not key comparison). Used by the
 * empty-folder prune to walk upward after a deletion.
 */
export function parentDir(p: string): string {
    const i = p.lastIndexOf("/");
    return i < 0 ? "" : p.slice(0, i);
}
