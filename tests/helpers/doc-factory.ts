/**
 * Shared document factories for tests. Centralises `makeFileDoc`,
 * `makeChunkDoc`, `makeConfigDoc` so every test file doesn't
 * reinvent them with slight variations.
 */

import type { FileDoc, ChunkDoc, ConfigDoc } from "../../src/types.ts";
import type { VectorClock } from "../../src/sync/vector-clock.ts";
import { makeFileId, makeChunkId, makeConfigId } from "../../src/types/doc-id.ts";
import { splitIntoChunks, arrayBufferToBase64 } from "../../src/db/chunker.ts";

export function makeFileDoc(
    path: string,
    opts: {
        chunks?: string[];
        mtime?: number;
        ctime?: number;
        size?: number;
        vclock?: VectorClock;
        deleted?: boolean;
    } = {},
): FileDoc {
    return {
        _id: makeFileId(path),
        type: "file",
        chunks: opts.chunks ?? [],
        mtime: opts.mtime ?? 1000,
        ctime: opts.ctime ?? 1000,
        size: opts.size ?? 0,
        vclock: opts.vclock ?? { A: 1 },
        deleted: opts.deleted,
    };
}

/**
 * Create a FileDoc with real chunks derived from content.
 * Returns the FileDoc and its ChunkDocs for insertion into a store.
 */
export async function makeFileDocWithContent(
    path: string,
    content: string,
    opts: {
        vclock?: VectorClock;
        deviceId?: string;
    } = {},
): Promise<{ fileDoc: FileDoc; chunks: ChunkDoc[] }> {
    const buf = new TextEncoder().encode(content).buffer;
    const chunks = await splitIntoChunks(buf);
    const vclock = opts.vclock ?? { [opts.deviceId ?? "A"]: 1 };
    const fileDoc: FileDoc = {
        _id: makeFileId(path),
        type: "file",
        chunks: chunks.map((c) => c._id),
        mtime: Date.now(),
        ctime: Date.now(),
        size: buf.byteLength,
        vclock,
    };
    return { fileDoc, chunks: chunks as ChunkDoc[] };
}

export function makeChunkDoc(hash: string, data: string): ChunkDoc {
    return {
        _id: makeChunkId(hash),
        type: "chunk",
        data,
    };
}

export function makeConfigDoc(
    path: string,
    opts: {
        data?: string;
        mtime?: number;
        size?: number;
        vclock?: VectorClock;
    } = {},
): ConfigDoc {
    return {
        _id: makeConfigId(path),
        type: "config",
        data: opts.data ?? arrayBufferToBase64(new TextEncoder().encode("data").buffer),
        mtime: opts.mtime ?? 1000,
        size: opts.size ?? 4,
        vclock: opts.vclock ?? { A: 1 },
    };
}
