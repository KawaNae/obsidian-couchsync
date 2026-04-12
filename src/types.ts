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
    configPathFromId,
    parseDocId,
} from "./types/doc-id.ts";
export type { DocKind, ParsedDocId } from "./types/doc-id.ts";

/** Base fields shared by all CouchSync documents */
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
 *  `_id` is `"chunk:" + xxhash64(content)` — always constructed via
 *  `makeChunkId`. Chunks are content-addressed and shared across files.
 */
export interface ChunkDoc extends CouchSyncDocBase {
    type: "chunk";
    data: string; // base64-encoded content
}

/** A config file (`.obsidian/` settings, plugin data.json, theme CSS, etc).
 *
 *  `_id` is `"config:" + vaultPath` — always constructed via `makeConfigId`.
 *  Config sync is scan-based (explicit rescan/write, not continuous watch).
 *
 *  Lives in a SEPARATE PouchDB (`ConfigLocalDB`) and a separate remote
 *  CouchDB (`couchdbConfigDbName`) — see v0.11.0 design. The vault DB
 *  must NOT contain `config:*` docs; the config DB must NOT contain
 *  anything else.
 *
 *  Like FileDoc, ordering between concurrent edits within the same
 *  config pool is decided by `vclock` — never by mtime.
 */
export interface ConfigDoc extends CouchSyncDocBase {
    type: "config";
    /** Base64-encoded raw bytes. Always binary-safe. */
    data: string;
    mtime: number;
    size: number;
    /** Causal order. Required on all writes. */
    vclock: VectorClock;
}

/** Union of all document types stored in PouchDB */
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
