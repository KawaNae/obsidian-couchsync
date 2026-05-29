import type { ChunkDoc } from "../types.ts";
import { CHUNK_SCHEMA_VERSION } from "../types.ts";
import { makeChunkId, type ChunkHashAlg } from "../types/doc-id.ts";
import { ChunkContentMissingError } from "./chunk-attachment.ts";

/** Default per-binary-chunk size for vault FileDocs. Matches the previous
 *  era's effective binary boundary (100 KiB base64 → 75 KiB binary) so
 *  chunk granularity stays roughly the same across the v1 → v2 transition.
 *
 *  CouchDB's per-attachment ceiling is configurable but defaults to ~64 MiB;
 *  the choice here is content-dedup granularity, not transport. Larger
 *  chunks reduce per-chunk overhead at the cost of finer dedup. */
export const MAX_CHUNK_BYTES_VAULT = 75 * 1024;

/** Per-binary-chunk size for ConfigSync (`.obsidian/`) payloads.
 *
 *  Tuned for the measured config distribution: median 698B–1.4KB, 99%
 *  of JSON < 4KB, max ~8.6MB (bundled plugin `main.js`). At 256 KiB the
 *  long tail (plugin/theme bundles) yields ~35 chunks even at 8.6MB,
 *  small JSON becomes a single chunk regardless, and gzip's dictionary
 *  window is fully utilised. Cross-version dedup is limited (bundled JS
 *  usually rewrites entirely on upgrade), so going finer than 256 KiB
 *  trades real per-doc overhead for marginal dedup gains. */
export const MAX_CHUNK_BYTES_CONFIG = 256 * 1024;

/** Legacy alias for the default vault chunk size. New callers should
 *  reach for `MAX_CHUNK_BYTES_VAULT` (or pass an explicit `chunkBytes`
 *  in `ChunkerConfig`). */
const MAX_CHUNK_BYTES = MAX_CHUNK_BYTES_VAULT;

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

function splitBinary(bytes: Uint8Array, chunkBytes: number): Uint8Array[] {
    if (bytes.length === 0) {
        // Empty file → exactly one zero-length chunk. This matches the
        // v1 chunker's behaviour (which produced one chunk with empty
        // base64 data) so file→chunks→file round-trips through the
        // zero-byte path stay deterministic.
        return [new Uint8Array(0)];
    }
    if (bytes.length <= chunkBytes) {
        return [bytes];
    }
    const pieces: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += chunkBytes) {
        pieces.push(bytes.slice(i, i + chunkBytes));
    }
    return pieces;
}

/** A hasher bundles the hash function with its own algorithm identity,
 *  so the chunk id can be stamped with the truly-used algorithm tag.
 *
 *  Required because encrypted vaults swap `computeHash` (xxhash64) for
 *  `cryptoProvider.hmacHash` — the chunker can't tell from the function
 *  alone which algorithm produced the bytes, so the algorithm must be
 *  declared alongside (invariant 14). The `alg` getter is consulted on
 *  every chunk so live changes to the underlying crypto state propagate
 *  without re-wiring the hasher. */
export interface ChunkHasher {
    readonly alg: ChunkHashAlg;
    hash(data: Uint8Array): Promise<string>;
}

const DEFAULT_HASHER: ChunkHasher = {
    alg: "x64",
    hash: computeHash,
};

/** Bundles the hasher with the chunk size, so a single argument carries
 *  the full chunking policy for a call site. VaultSync passes the
 *  default (75 KiB + xxhash64 or the encrypted HMAC). ConfigSync passes
 *  `{hasher, chunkBytes: MAX_CHUNK_BYTES_CONFIG}` to opt into the larger
 *  256 KiB unit that suits config-file size distributions. */
export interface ChunkerConfig {
    hasher: ChunkHasher;
    /** Bytes per chunk. Default `MAX_CHUNK_BYTES_VAULT` (75 KiB). */
    chunkBytes?: number;
}

const DEFAULT_CHUNKER_CONFIG: ChunkerConfig = {
    hasher: DEFAULT_HASHER,
    chunkBytes: MAX_CHUNK_BYTES_VAULT,
};

/** Split a file's binary content into ChunkDocs. The hash is computed
 *  over the plain binary `content` — same plaintext → same chunk ID
 *  regardless of how the storage layer chooses to encode it on the wire
 *  (envelope flags / encryption / compression are downstream concerns).
 *  v0.25.0 dropped the legacy base64 `data` field; the canonical payload
 *  is `content` (Uint8Array) and the attachment is built from it at push
 *  time.
 *
 *  The hasher carries its own algorithm identity (`alg`), read once per
 *  chunk and used as the id tag (`chunk:<alg>:<hash>`). Plaintext-only
 *  callers can omit the argument and default to xxhash64 (`x64`).
 *
 *  Accepts either a `ChunkerConfig` object or a bare `ChunkHasher` for
 *  back-compat with the pre-v0.26 signature; the bare-hasher overload
 *  silently uses the default `MAX_CHUNK_BYTES_VAULT` chunk size.
 */
export async function splitIntoChunks(
    content: ArrayBuffer,
    configOrHasher: ChunkerConfig | ChunkHasher = DEFAULT_CHUNKER_CONFIG,
): Promise<ChunkDoc[]> {
    const config: ChunkerConfig = isChunkHasher(configOrHasher)
        ? { hasher: configOrHasher, chunkBytes: MAX_CHUNK_BYTES_VAULT }
        : configOrHasher;
    const hasher = config.hasher;
    const chunkBytes = config.chunkBytes ?? MAX_CHUNK_BYTES_VAULT;

    const bytes = new Uint8Array(content);
    const pieces = splitBinary(bytes, chunkBytes);

    const chunks: ChunkDoc[] = [];
    for (const piece of pieces) {
        const h = await hasher.hash(piece);
        chunks.push({
            _id: makeChunkId(h, hasher.alg),
            type: "chunk",
            schemaVersion: CHUNK_SCHEMA_VERSION,
            content: piece,
        });
    }
    return chunks;
}

function isChunkHasher(x: ChunkerConfig | ChunkHasher): x is ChunkHasher {
    return typeof (x as ChunkHasher).hash === "function"
        && typeof (x as ChunkHasher).alg === "string";
}

export function joinChunks(chunks: ChunkDoc[]): ArrayBuffer {
    // Fail-closed (Invariant I): a ChunkDoc is only usable when it carries a
    // real content buffer. A content-less doc (e.g. carried over from an old
    // schema, or a partial/corrupt write) must raise a typed, routable error
    // here rather than an opaque `TypeError: cannot read 'length' of
    // undefined` deep in the reassembly loop.
    for (const c of chunks) {
        if (!(c.content instanceof Uint8Array)) {
            throw new ChunkContentMissingError(c._id);
        }
    }
    let totalLen = 0;
    for (const c of chunks) totalLen += c.content.length;
    const out = new Uint8Array(totalLen);
    let off = 0;
    for (const c of chunks) {
        out.set(c.content, off);
        off += c.content.length;
    }
    return out.buffer;
}
