import type { VectorClock } from "./sync/vector-clock.ts";
export type { VectorClock } from "./sync/vector-clock.ts";

// Re-export the ID helpers from the centralised module so existing imports
// of `../types` stay ergonomic. New code should import from "./types/doc-id"
// directly when it only needs ID helpers.
export {
    DOC_ID,
    ID_RANGE,
    makeFileId,
    makeChunkId,
    makeConfigId,
    isFileDocId,
    isChunkDocId,
    isConfigDocId,
    isLocalDocId,
    isReplicatedDocId,
    filePathFromId,
    chunkHashFromId,
    parseChunkId,
    configPathFromId,
    parseDocId,
} from "./types/doc-id.ts";
export type { DocKind, ParsedDocId, ChunkHashAlg } from "./types/doc-id.ts";

/** Per-doc-kind schema version. Each replicated doc kind carries its
 *  own version literal so the kinds can evolve independently: e.g.
 *  ConfigDoc moves from v2 to v3 (chunks-based) without forcing FileDoc
 *  to re-stamp. Writers stamp the constant matching the kind; readers
 *  rely on the type guarantee (invariant 11) and don't tolerate
 *  undefined.
 *
 *  - `FILE_SCHEMA_VERSION = 2` — attachment-based v2 (data-layer-v2)
 *  - `CHUNK_SCHEMA_VERSION = 2` — attachment-based v2
 *  - `CONFIG_SCHEMA_VERSION = 3` — chunks-based, attachment payload
 *    (ConfigSync chunking, supersedes the `data: string` inline form)
 */
export const FILE_SCHEMA_VERSION = 2 as const;
export const CHUNK_SCHEMA_VERSION = 2 as const;
export const CONFIG_SCHEMA_VERSION = 3 as const;

export type FileSchemaVersion = typeof FILE_SCHEMA_VERSION;
export type ChunkSchemaVersion = typeof CHUNK_SCHEMA_VERSION;
export type ConfigSchemaVersion = typeof CONFIG_SCHEMA_VERSION;

/** Aggregate alias kept for legacy call sites that need to mention "the
 *  schemaVersion field of any replicated doc" without committing to a
 *  specific kind. Most code should use the per-kind constants. */
export type SchemaVersion =
    | FileSchemaVersion
    | ChunkSchemaVersion
    | ConfigSchemaVersion;

/** Back-compat alias — equal to `FILE_SCHEMA_VERSION`. Pre-v0.26 the
 *  three kinds shared a single version; downstream code that still
 *  imports this constant continues to compile, but new writers should
 *  reach for the per-kind constant directly. */
export const CURRENT_SCHEMA_VERSION = FILE_SCHEMA_VERSION;

/** Base fields shared by all CouchSync documents. The `schemaVersion`
 *  field lives on each concrete interface so the literal type pins to
 *  the right per-kind version. */
interface CouchSyncDocBase {
    _id: string;
    _rev?: string;
}

/** A vault file (note, image, attachment) stored as chunks.
 *
 *  `_id` is `"file:" + vaultPath` — always constructed via `makeFileId`.
 *  Ordering is determined solely by `vclock` (Vector Clock over deviceIds).
 *  `mtime` / `ctime` are preserved for display but MUST NOT be used for
 *  freshness comparison — that role belongs to `vclock` exclusively.
 */
export interface FileDoc extends CouchSyncDocBase {
    type: "file";
    schemaVersion: FileSchemaVersion;
    chunks: string[];
    mtime: number;
    ctime: number;
    size: number;
    deleted?: boolean;
    /** Causal order. Required on all writes. */
    vclock: VectorClock;
}

/** A content chunk — fragment of a file.
 *
 *  `_id` is `"chunk:<alg>:<hash>"` — always constructed via `makeChunkId`.
 *  Chunks are content-addressed and shared across files. v0.25.0 uses
 *  the `x64` algorithm tag (xxhash64 of plain binary content) for every
 *  newly-minted chunk.
 *
 *  The canonical payload rides as a CouchDB attachment named `"c"`
 *  (envelope-formatted; see `envelope.ts`). The local `content` field
 *  holds the plain binary so the push pipeline can re-wrap it without
 *  re-reading from vault — that's the only reason it lives in the doc
 *  body. There is no legacy base64 `data` field; v0.25.0 dropped it
 *  along with the multipart-related transport.
 */
export interface ChunkDoc extends CouchSyncDocBase {
    type: "chunk";
    schemaVersion: ChunkSchemaVersion;
    /** Plain binary content. Required — chunker always sets it, and
     *  push pipeline reads it directly when building the `c` attachment. */
    content: Uint8Array;
}

/** A config file (`.obsidian/` settings, plugin data.json, theme CSS, etc).
 *
 *  `_id` is `"config:" + vaultPath` — always constructed via `makeConfigId`.
 *  Config sync is scan-based (explicit rescan/write, not continuous watch).
 *
 *  Lives in a SEPARATE database (`ConfigLocalDB`) and a separate remote
 *  CouchDB (`couchdbConfigDbName`) — see v0.11.0 design. The vault DB
 *  must NOT contain `config:*` docs; the config DB must NOT contain
 *  anything else.
 *
 *  Like FileDoc, ordering between concurrent edits within the same
 *  config pool is decided by `vclock` — never by mtime.
 *
 *  v3 (ConfigSync chunking) replaces the legacy `data: string` (base64
 *  inline) field with `chunks: string[]`, mirroring FileDoc. Each chunk
 *  rides as a `ChunkDoc` in the SAME config DB with an envelope-formatted
 *  attachment "c" — invariant 12 universality now applies to config DB
 *  too. Cross-device dedup (identical plugin/theme across N devices →
 *  one chunk on remote) and wire-level gzip (via CompressingCouchClient)
 *  are the load-bearing wins.
 */
export interface ConfigDoc extends CouchSyncDocBase {
    type: "config";
    schemaVersion: ConfigSchemaVersion;
    /** Ordered list of `chunk:<alg>:<hash>` ids that compose this config
     *  file's binary content. Empty for zero-byte files (one chunk of
     *  zero length, matching FileDoc semantics). */
    chunks: string[];
    mtime: number;
    size: number;
    /** Causal order. Required on all writes. */
    vclock: VectorClock;
    /** Tombstone marker — pull-side write skips when true (symmetric with
     *  FileDoc.deleted). Currently only used for migration safety; the
     *  manual scan/push/pull flow does not generate tombstones, but
     *  future continuous-mode work can. */
    deleted?: boolean;
}

/** Union of all document types stored in the local DB */
export type CouchSyncDoc = FileDoc | ChunkDoc | ConfigDoc;

export function isFileDoc(doc: CouchSyncDoc): doc is FileDoc {
    return doc.type === "file";
}

export function isChunkDoc(doc: CouchSyncDoc): doc is ChunkDoc {
    return doc.type === "chunk";
}

export function isConfigDoc(doc: CouchSyncDoc): doc is ConfigDoc {
    return doc.type === "config";
}
