import type { ChunkDoc } from "../types.ts";
import { DOC_PREFIX } from "../types.ts";

const MAX_CHUNK_SIZE_TEXT = 1000; // characters
const MAX_CHUNK_SIZE_BIN = 102400; // bytes (100KB)

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

function splitText(content: string): string[] {
    if (content.length <= MAX_CHUNK_SIZE_TEXT) {
        return [content];
    }
    const lines = content.split("\n");
    const chunks: string[] = [];
    let current = "";

    for (const line of lines) {
        const candidate = current ? current + "\n" + line : line;
        if (candidate.length > MAX_CHUNK_SIZE_TEXT && current.length > 0) {
            chunks.push(current);
            current = line;
        } else {
            current = candidate;
        }
    }
    if (current.length > 0) {
        chunks.push(current);
    }
    return chunks;
}

function splitBinary(base64: string): string[] {
    if (base64.length <= MAX_CHUNK_SIZE_BIN) {
        return [base64];
    }
    const chunks: string[] = [];
    for (let i = 0; i < base64.length; i += MAX_CHUNK_SIZE_BIN) {
        chunks.push(base64.slice(i, i + MAX_CHUNK_SIZE_BIN));
    }
    return chunks;
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

export async function splitIntoChunks(
    content: string | ArrayBuffer,
    isBinary: boolean
): Promise<ChunkDoc[]> {
    let pieces: string[];

    if (isBinary) {
        const base64 = arrayBufferToBase64(content as ArrayBuffer);
        pieces = splitBinary(base64);
    } else {
        pieces = splitText(content as string);
    }

    const chunks: ChunkDoc[] = [];
    for (const piece of pieces) {
        const hash = await computeHash(piece);
        chunks.push({
            _id: `${DOC_PREFIX.CHUNK}${hash}`,
            type: "chunk",
            data: isBinary ? piece : btoa(unescape(encodeURIComponent(piece))),
        });
    }
    return chunks;
}

export function joinChunks(chunks: ChunkDoc[], isBinary: boolean): string | ArrayBuffer {
    if (isBinary) {
        const base64 = chunks.map((c) => c.data).join("");
        return base64ToArrayBuffer(base64);
    } else {
        return chunks.map((c) => decodeURIComponent(escape(atob(c.data)))).join("");
    }
}
