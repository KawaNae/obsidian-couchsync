import type { ChunkDoc } from "../types.ts";
import { makeChunkId } from "../types/doc-id.ts";

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

// Feature detection for the ES2024 base64 APIs. Obsidian Electron (desktop)
// and iOS 18.2+ have them; older iPads need the fallback path.
const HAS_NATIVE_BASE64 =
    typeof (Uint8Array.prototype as unknown as { toBase64?: () => string }).toBase64 === "function" &&
    typeof (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64 === "function";

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    if (HAS_NATIVE_BASE64) {
        return (bytes as unknown as { toBase64: () => string }).toBase64();
    }
    return arrayBufferToBase64Fallback(bytes);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
    if (HAS_NATIVE_BASE64) {
        const bytes = (Uint8Array as unknown as { fromBase64: (s: string) => Uint8Array })
            .fromBase64(base64);
        return bytes.buffer as ArrayBuffer;
    }
    return base64ToArrayBufferFallback(base64);
}

// Exported so tests can exercise the fallback path explicitly, regardless of
// whether the running Node/browser ships the native API.
export function arrayBufferToBase64Fallback(bytes: Uint8Array): string {
    // 0x8000 keeps well under the call-stack limit for String.fromCharCode.apply
    // while still amortising the btoa call across large chunks.
    const CHUNK = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
        const slice = bytes.subarray(i, i + CHUNK);
        binary += String.fromCharCode.apply(null, slice as unknown as number[]);
    }
    return btoa(binary);
}

export function base64ToArrayBufferFallback(base64: string): ArrayBuffer {
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
            _id: makeChunkId(hash),
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
