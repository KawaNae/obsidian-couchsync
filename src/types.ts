/** Base fields shared by all CouchSync documents */
interface CouchSyncDocBase {
    _id: string;
    _rev?: string;
    _conflicts?: string[];
}

/** A vault file (note, image, attachment) stored as chunks */
export interface FileDoc extends CouchSyncDocBase {
    type: "file";
    chunks: string[];
    mtime: number;
    ctime: number;
    size: number;
    deleted?: boolean;
    /** Timestamp (Date.now()) when a user actually edited this file.
     *  Set only by fileToDb(); never updated by dbToFile() relay.
     *  Falls back to mtime for docs created before this field existed. */
    editedAt?: number;
    /** deviceId of the device that made the edit */
    editedBy?: string;
}

/** A content chunk — fragment of a file */
export interface ChunkDoc extends CouchSyncDocBase {
    type: "chunk";
    data: string; // base64-encoded content
}

/** A config file (.obsidian/ settings, plugin data.json, etc.) */
export interface ConfigDoc extends CouchSyncDocBase {
    type: "config";
    /** Base64-encoded raw bytes. */
    data: string;
    /** @deprecated Always true on new docs. Legacy docs with binary === false
     *  store plain UTF-8 text in `data` (read-time backward compat). */
    binary: boolean;
    mtime: number;
    size: number;
}

/** Local-only sync metadata (not replicated) */
export interface SyncMetaDoc {
    _id: "_local/sync-meta";
    _rev?: string;
    deviceId: string;
    deviceName: string;
    lastSync: number;
}

/** Union of all document types stored in PouchDB */
export type CouchSyncDoc = FileDoc | ChunkDoc | ConfigDoc;

/** Prefix constants for document IDs */
export const DOC_PREFIX = {
    CHUNK: "chunk:",
    CONFIG: "config:",
} as const;

export function isFileDoc(doc: CouchSyncDoc): doc is FileDoc {
    return doc.type === "file";
}

export function isChunkDoc(doc: CouchSyncDoc): doc is ChunkDoc {
    return doc.type === "chunk";
}

export function isConfigDoc(doc: CouchSyncDoc): doc is ConfigDoc {
    return doc.type === "config";
}
