/**
 * Single source of truth for CouchSync document `_id` generation, detection,
 * and parsing.
 *
 * ## Scheme
 *
 * ```
 * file:<vaultPath>              FileDoc    e.g. "file:notes/hello.md"
 * chunk:<alg>:<hash>            ChunkDoc   e.g. "chunk:x64:a1b2c3d4..."
 * config:<vaultPath>            ConfigDoc  e.g. "config:.obsidian/appearance.json"
 * _local/<name>                 CouchDB reserved (not replicated)
 * ```
 *
 * The chunk id carries an algorithm tag between the `chunk:` prefix and
 * the hash payload. v0.25.0 ships with `x64` (xxhash64 / 16 hex chars).
 * Adding a new hash function (e.g. blake3) introduces a new tag (`b3`,
 * etc.) that coexists in the same namespace — old `chunk:x64:...` ids
 * and new `chunk:b3:...` ids can live side-by-side, with the algorithm
 * trivially derivable from the id alone (invariant 14).
 *
 * All three replicated prefixes (`file:`, `chunk:`, `config:`) are
 * lexicographically disjoint, so `allDocs({ startkey, endkey })` range
 * queries over `ID_RANGE.<kind>` will never accidentally overlap. See
 * the `prefix disjointness` test block for the exact orderings this
 * module relies on.
 *
 * ## Usage rule
 *
 * Never call `id.startsWith("chunk:")` or `id.slice("config:".length)`
 * directly anywhere else in the codebase. Always go through this module.
 * That centralisation is the whole point — it prevents the kind of
 * per-file drift that accumulated before this redesign.
 */

export const DOC_ID = {
    FILE: "file:" as const,
    CHUNK: "chunk:" as const,
    CONFIG: "config:" as const,
} as const;

export type DocKind = "file" | "chunk" | "config";

/** Hash algorithms allowed in chunk ids.
 *  - `x64`: xxhash64 (16 hex chars) — plaintext vaults
 *  - `hmac`: HMAC-SHA256 (64 hex chars) — encrypted vaults
 *
 *  Encrypted vaults swap to HMAC so the chunk id derived from plain
 *  content cannot be linked across vaults by a server that knows the
 *  public, keyless xxhash64. Both forms can coexist in one vault
 *  (the tag in the id selects the verifier per chunk). */
export type ChunkHashAlg = "x64" | "hmac";

/** Default algorithm tag for new chunk ids — used when no hasher is
 *  supplied (plaintext code paths and unit tests). Real chunker
 *  callers pass an explicit hasher that carries its own algorithm. */
export const DEFAULT_CHUNK_ALG: ChunkHashAlg = "x64";

/**
 * Range query bounds per replicated kind. Use with `allDocs`:
 *
 *   db.allDocs({
 *     startkey: ID_RANGE.file.startkey,
 *     endkey:   ID_RANGE.file.endkey,
 *     include_docs: true,
 *   })
 *
 * The `￰` upper bound is the largest reasonably-matchable BMP codepoint
 * and ensures every `<prefix>:<anything>` entry is included.
 *
 * `chunk.x64` narrows the chunk range to a single hash algorithm —
 * useful when phasing in a new algorithm and needing to enumerate just
 * one cohort. `chunk.startkey/endkey` cover every algorithm.
 */
export const ID_RANGE = {
    file: { startkey: DOC_ID.FILE, endkey: DOC_ID.FILE + "￰" },
    chunk: {
        startkey: DOC_ID.CHUNK,
        endkey: DOC_ID.CHUNK + "￰",
        x64: {
            startkey: DOC_ID.CHUNK + "x64:",
            endkey: DOC_ID.CHUNK + "x64:￰",
        },
        hmac: {
            startkey: DOC_ID.CHUNK + "hmac:",
            endkey: DOC_ID.CHUNK + "hmac:￰",
        },
    },
    config: { startkey: DOC_ID.CONFIG, endkey: DOC_ID.CONFIG + "￰" },
} as const;

// ── Generation ──────────────────────────────────────────────────────────

export function makeFileId(vaultPath: string): string {
    return DOC_ID.FILE + vaultPath;
}

/** Build a chunk id of the form `chunk:<alg>:<hash>`. The default
 *  algorithm (`x64`) matches what `chunker.computeHash` produces; pass
 *  another tag explicitly when minting ids for a different algorithm
 *  during a rolling migration. */
export function makeChunkId(
    hash: string,
    alg: ChunkHashAlg = DEFAULT_CHUNK_ALG,
): string {
    return DOC_ID.CHUNK + alg + ":" + hash;
}

export function makeConfigId(vaultPath: string): string {
    return DOC_ID.CONFIG + vaultPath;
}

// ── Predicates ──────────────────────────────────────────────────────────

export function isFileDocId(id: string): boolean {
    return id.startsWith(DOC_ID.FILE);
}

export function isChunkDocId(id: string): boolean {
    return id.startsWith(DOC_ID.CHUNK);
}

export function isConfigDocId(id: string): boolean {
    return id.startsWith(DOC_ID.CONFIG);
}

/** CouchDB-reserved local / design docs (never replicated). */
export function isLocalDocId(id: string): boolean {
    return id.startsWith("_");
}

/** One of the replicated kinds (file / chunk / config). */
export function isReplicatedDocId(id: string): boolean {
    return isFileDocId(id) || isChunkDocId(id) || isConfigDocId(id);
}

// ── Payload extraction ──────────────────────────────────────────────────

export function filePathFromId(id: string): string {
    if (!isFileDocId(id)) {
        throw new Error(`filePathFromId: not a file doc id: ${id}`);
    }
    return id.slice(DOC_ID.FILE.length);
}

/** Parse a chunk id into its algorithm tag and hash. Throws when the
 *  id does not match the `chunk:<alg>:<hash>` shape — there is no
 *  legacy-flat fallback (v0.25.0 mints every chunk with an explicit
 *  algorithm tag). */
export function parseChunkId(id: string): { alg: ChunkHashAlg; hash: string } {
    if (!isChunkDocId(id)) {
        throw new Error(`parseChunkId: not a chunk doc id: ${id}`);
    }
    const rest = id.slice(DOC_ID.CHUNK.length);
    const colon = rest.indexOf(":");
    if (colon < 0) {
        throw new Error(`parseChunkId: missing algorithm tag in ${id}`);
    }
    const alg = rest.slice(0, colon);
    const hash = rest.slice(colon + 1);
    if (alg !== "x64" && alg !== "hmac") {
        throw new Error(`parseChunkId: unknown algorithm '${alg}' in ${id}`);
    }
    return { alg, hash };
}

/** Returns just the hash payload (delegates to `parseChunkId`). */
export function chunkHashFromId(id: string): string {
    return parseChunkId(id).hash;
}

export function configPathFromId(id: string): string {
    if (!isConfigDocId(id)) {
        throw new Error(`configPathFromId: not a config doc id: ${id}`);
    }
    return id.slice(DOC_ID.CONFIG.length);
}

// ── General-purpose parser ──────────────────────────────────────────────

export type ParsedDocId =
    | { kind: "file"; path: string }
    | { kind: "chunk"; alg: ChunkHashAlg; hash: string }
    | { kind: "config"; path: string }
    | { kind: "local"; name: string }
    | { kind: "unknown" };

export function parseDocId(id: string): ParsedDocId {
    if (isConfigDocId(id)) return { kind: "config", path: configPathFromId(id) };
    if (isChunkDocId(id)) {
        const { alg, hash } = parseChunkId(id);
        return { kind: "chunk", alg, hash };
    }
    if (isFileDocId(id)) return { kind: "file", path: filePathFromId(id) };
    if (id.startsWith("_local/")) {
        return { kind: "local", name: id.slice("_local/".length) };
    }
    if (id.startsWith("_")) {
        return { kind: "local", name: id.slice(1) };
    }
    return { kind: "unknown" };
}
