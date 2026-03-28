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
}

/** A content chunk — fragment of a file */
export interface ChunkDoc extends CouchSyncDocBase {
    type: "chunk";
    data: string; // base64-encoded content
}

/** A hidden file from .obsidian/ directory */
export interface HiddenFileDoc extends CouchSyncDocBase {
    type: "hidden";
    data: string;
    mtime: number;
    size: number;
    deleted?: boolean;
}

/** Plugin configuration file */
export interface PluginConfigDoc extends CouchSyncDocBase {
    type: "plugin-config";
    data: string;
    mtime: number;
    deviceName: string;
    deleted?: boolean;
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
export type CouchSyncDoc = FileDoc | ChunkDoc | HiddenFileDoc | PluginConfigDoc;

/** Prefix constants for document IDs */
export const DOC_PREFIX = {
    CHUNK: "chunk:",
    HIDDEN: "hidden:",
    PLUGIN: "plugin:",
} as const;

/** Check if a doc ID represents a file (no prefix = file path) */
export function isFileDoc(doc: CouchSyncDoc): doc is FileDoc {
    return doc.type === "file";
}

export function isChunkDoc(doc: CouchSyncDoc): doc is ChunkDoc {
    return doc.type === "chunk";
}

export function isHiddenFileDoc(doc: CouchSyncDoc): doc is HiddenFileDoc {
    return doc.type === "hidden";
}

export function isPluginConfigDoc(doc: CouchSyncDoc): doc is PluginConfigDoc {
    return doc.type === "plugin-config";
}
