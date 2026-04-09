/**
 * Single source of truth for CouchSync document `_id` generation, detection,
 * and parsing.
 *
 * ## Scheme
 *
 * ```
 * file:<vaultPath>      FileDoc    e.g. "file:notes/hello.md"
 * chunk:<xxhash64>      ChunkDoc   e.g. "chunk:a1b2c3d4..."
 * config:<vaultPath>    ConfigDoc  e.g. "config:.obsidian/appearance.json"
 * _local/<name>         PouchDB reserved (not replicated)
 * ```
 *
 * All three replicated prefixes are lexicographically disjoint, so
 * `allDocs({ startkey, endkey })` range queries over `ID_RANGE.<kind>` will
 * never accidentally overlap. See the `prefix disjointness` test block for
 * the exact orderings this module relies on.
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

/**
 * PouchDB range query bounds per replicated kind. Use with `allDocs`:
 *
 *   db.allDocs({
 *     startkey: ID_RANGE.file.startkey,
 *     endkey:   ID_RANGE.file.endkey,
 *     include_docs: true,
 *   })
 *
 * The `\ufff0` upper bound is the largest reasonably-matchable BMP codepoint
 * and ensures every `<prefix>:<anything>` entry is included.
 */
export const ID_RANGE = {
    file: { startkey: DOC_ID.FILE, endkey: DOC_ID.FILE + "\ufff0" },
    chunk: { startkey: DOC_ID.CHUNK, endkey: DOC_ID.CHUNK + "\ufff0" },
    config: { startkey: DOC_ID.CONFIG, endkey: DOC_ID.CONFIG + "\ufff0" },
} as const;

// ── Generation ──────────────────────────────────────────────────────────

export function makeFileId(vaultPath: string): string {
    return DOC_ID.FILE + vaultPath;
}

export function makeChunkId(hash: string): string {
    return DOC_ID.CHUNK + hash;
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

/** PouchDB-reserved local / design docs (never replicated). */
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

export function chunkHashFromId(id: string): string {
    if (!isChunkDocId(id)) {
        throw new Error(`chunkHashFromId: not a chunk doc id: ${id}`);
    }
    return id.slice(DOC_ID.CHUNK.length);
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
    | { kind: "chunk"; hash: string }
    | { kind: "config"; path: string }
    | { kind: "local"; name: string }
    | { kind: "unknown" };

export function parseDocId(id: string): ParsedDocId {
    if (isConfigDocId(id)) return { kind: "config", path: configPathFromId(id) };
    if (isChunkDocId(id)) return { kind: "chunk", hash: chunkHashFromId(id) };
    if (isFileDocId(id)) return { kind: "file", path: filePathFromId(id) };
    if (id.startsWith("_local/")) {
        return { kind: "local", name: id.slice("_local/".length) };
    }
    if (id.startsWith("_")) {
        return { kind: "local", name: id.slice(1) };
    }
    return { kind: "unknown" };
}
