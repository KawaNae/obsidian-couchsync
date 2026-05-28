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

/** Current doc schema version. Bumped when the on-disk / on-wire shape
 *  of replicated docs changes in a way that requires the reader to know
 *  which interpretation to apply. The current value is 2 — the
 *  attachment-based data layer redesigned in `plans/2026-05-28-data-layer-v2.md`.
 *
 *  Writers always stamp this value on every new doc. Readers tolerate
 *  missing values (legacy / pre-v2 docs) and treat them as the previous
 *  version. Future bumps should add new variants here and route via
 *  explicit version checks at the decoder boundary.
 */
export const CURRENT_SCHEMA_VERSION = 2 as const;
export type SchemaVersion = typeof CURRENT_SCHEMA_VERSION;

/** Base fields shared by all CouchSync documents */
interface CouchSyncDocBase {
    _id: string;
    _rev?: string;
    /** Doc schema version. Optional in the type system so legacy docs
     *  (without the field) remain valid; writers always set it. */
    schemaVersion?: SchemaVersion;
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
 *  `_id` is `"chunk:" + hash(plainBytes)` — always constructed via
 *  `makeChunkId`. Chunks are content-addressed and shared across files.
 *  In v2 the hash input is the plain binary content (Uint8Array), not the
 *  base64 string of it — see `chunker.ts`.
 *
 *  Phase 2 keeps `data: string` (base64) and adds the parallel `content: Uint8Array`.
 *  Phase 6 (attachment plumbing) moves the canonical payload into a
 *  CouchDB attachment (`_attachments.c`) and removes `data`.
 */
export interface ChunkDoc extends CouchSyncDocBase {
    type: "chunk";
    /** Base64-encoded content. Legacy v1 storage carrier, retained for
     *  back-compat during phases 2-5. Phase 6 removes this in favour of
     *  the binary attachment.
     *  @deprecated Use `content` (Uint8Array) for new code paths. */
    data: string;
    /** Plain binary content. v2 canonical representation. Optional on
     *  the type so docs read from legacy storage (data-only) remain
     *  valid; the chunker always sets it on newly-produced chunks. */
    content?: Uint8Array;
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
