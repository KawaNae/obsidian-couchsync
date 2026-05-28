import type { ChunkDoc } from "../types.ts";
import { CURRENT_SCHEMA_VERSION } from "../types.ts";
import { makeChunkId } from "../types/doc-id.ts";

/** Maximum bytes per binary chunk. Matches the previous era's effective
 *  binary boundary (100 KiB base64 → 75 KiB binary) so chunk granularity
 *  stays roughly the same across the v1 → v2 transition.
 *
 *  CouchDB's per-attachment ceiling is configurable but defaults to ~64 MiB;
 *  the choice here is content-dedup granularity, not transport. Larger
 *  chunks reduce per-chunk overhead at the cost of finer dedup. */
const MAX_CHUNK_BYTES = 75 * 1024;

let xxhash: { h64Raw: (input: Uint8Array, seed?: bigint) => bigint } | null = null;

async function getXXHash() {
    if (xxhash) return xxhash;
    const mod = await import("xxhash-wasm-102");
    const init = (mod.default ?? mod) as () => Promise<typeof xxhash>;
    xxhash = await init();
    return xxhash;
}

/** xxhash64 of plain binary content, hex-encoded with leading-zero padding
 *  to a stable 16-character output. Padding matters: chunk IDs are
 *  lexicographic keys in CouchDB, and a variable-length hash would change
 *  range-query semantics across hash values. */
export async function computeHash(data: Uint8Array): Promise<string> {
    const h = await getXXHash();
    const result = h.h64Raw(data);
    return result.toString(16).padStart(16, "0");
}

// Feature detection for the ES2024 base64 APIs. Obsidian Electron (desktop)
// and iOS 18.2+ have them; older iPads need the fallback path.
const HAS_NATIVE_BASE64 =
    typeof (Uint8Array.prototype as unknown as { toBase64?: () => string }).toBase64 === "function" &&
    typeof (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64 === "function";

export function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
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

function splitBinary(bytes: Uint8Array): Uint8Array[] {
    if (bytes.length === 0) {
        // Empty file → exactly one zero-length chunk. This matches the
        // v1 chunker's behaviour (which produced one chunk with empty
        // base64 data) so file→chunks→file round-trips through the
        // zero-byte path stay deterministic.
        return [new Uint8Array(0)];
    }
    if (bytes.length <= MAX_CHUNK_BYTES) {
        return [bytes];
    }
    const pieces: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += MAX_CHUNK_BYTES) {
        pieces.push(bytes.slice(i, i + MAX_CHUNK_BYTES));
    }
    return pieces;
}

export type ChunkHashFn = (data: Uint8Array) => Promise<string>;

/** Split a file's binary content into ChunkDocs. Each chunk carries both
 *  the binary `content` (v2 canonical) and a base64 `data` field (v1
 *  back-compat retained until Phase 6 removes it).
 *
 *  The hash is computed over the binary `content` — never over the
 *  base64 string. Same plaintext → same chunk ID, regardless of how
 *  the storage layer chooses to encode it. */
export async function splitIntoChunks(
    content: ArrayBuffer,
    hashFn?: ChunkHashFn,
): Promise<ChunkDoc[]> {
    const bytes = new Uint8Array(content);
    const pieces = splitBinary(bytes);
    const hash = hashFn ?? computeHash;

    const chunks: ChunkDoc[] = [];
    for (const piece of pieces) {
        const h = await hash(piece);
        chunks.push({
            _id: makeChunkId(h),
            type: "chunk",
            schemaVersion: CURRENT_SCHEMA_VERSION,
            data: arrayBufferToBase64(piece),
            content: piece,
        });
    }
    return chunks;
}

export function joinChunks(chunks: ChunkDoc[]): ArrayBuffer {
    // Prefer the v2 binary representation when present. Fall back to
    // decoding the base64 string for chunks that came in via legacy
    // storage paths (read from the local DB pre-Phase 4 migration, etc.).
    const binaries: Uint8Array[] = chunks.map((c) => {
        if (c.content) return c.content;
        return new Uint8Array(base64ToArrayBuffer(c.data));
    });
    let totalLen = 0;
    for (const b of binaries) totalLen += b.length;
    const out = new Uint8Array(totalLen);
    let off = 0;
    for (const b of binaries) {
        out.set(b, off);
        off += b.length;
    }
    return out.buffer;
}
