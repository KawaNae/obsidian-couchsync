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

/**
 * Trust boundary for remote-supplied paths. A FileDoc/ConfigDoc `_id`
 * carries the vault-relative path verbatim (`filePathFromId` is a bare
 * slice with no validation), so on a PLAINTEXT vault the path is fully
 * server-controlled. Obsidian's `normalizePath` does NOT resolve `..`
 * segments, and FileSystemAdapter resolves the path via `path.join(base,
 * p)` — so `../../evil` escapes the vault. Encryption happens to mask this
 * (the `_id` becomes an HMAC the server can't choose), but that is a side
 * effect, not the defense.
 *
 * Returns a human-readable reason string when `p` could escape the vault
 * sandbox, or `null` when it is a safe vault-relative path. Only the four
 * escape vectors are rejected — `..` segments, absolute paths, Windows
 * drive letters, and backslash separators — because those alone cannot be
 * legitimate vault-relative paths. Windows reserved names / trailing dots
 * are deliberately NOT rejected: they cause in-vault write quirks, not
 * sandbox escape, and rejecting them would drop legitimate notes.
 */
export function unsafeVaultPathReason(p: string): string | null {
    if (!p) return "empty path";
    if (p.includes("\\")) return "backslash separator";
    if (p.startsWith("/")) return "absolute path";
    if (/^[a-zA-Z]:/.test(p)) return "drive letter";
    for (const seg of p.split("/")) {
        if (seg === "..") return "parent-directory traversal (..)";
    }
    return null;
}
