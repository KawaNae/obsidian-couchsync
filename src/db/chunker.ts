import type { ChunkDoc } from "../types.ts";
import { DOC_PREFIX } from "../types.ts";

const MAX_CHUNK_SIZE = 100 * 1024; // 100KB in base64 characters

let xxhash: { h64ToString: (input: string) => string } | null = null;

async function getXXHash() {
    if (xxhash) return xxhash;
    const mod = await import("xxhash-wasm-102");
    xxhash = await (mod.default ?? mod)();
    return xxhash;
}

export async function computeHash(data: string): Promise<string> {
    const h = await getXXHash();
    return h.h64ToString(data);
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

function splitBase64(base64: string): string[] {
    if (base64.length <= MAX_CHUNK_SIZE) {
        return [base64];
    }
    const chunks: string[] = [];
    for (let i = 0; i < base64.length; i += MAX_CHUNK_SIZE) {
        chunks.push(base64.slice(i, i + MAX_CHUNK_SIZE));
    }
    return chunks;
}

export async function splitIntoChunks(content: ArrayBuffer): Promise<ChunkDoc[]> {
    const base64 = arrayBufferToBase64(content);
    const pieces = splitBase64(base64);

    const chunks: ChunkDoc[] = [];
    for (const piece of pieces) {
        const hash = await computeHash(piece);
        chunks.push({
            _id: `${DOC_PREFIX.CHUNK}${hash}`,
            type: "chunk",
            data: piece,
        });
    }
    return chunks;
}

export function joinChunks(chunks: ChunkDoc[]): ArrayBuffer {
    const base64 = chunks.map((c) => c.data).join("");
    return base64ToArrayBuffer(base64);
}
