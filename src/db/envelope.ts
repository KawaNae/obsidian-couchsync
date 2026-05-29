/**
 * Codec envelope — self-describing wire format for persistent payloads.
 *
 * Every byte sequence persisted to CouchDB (attachment body, encrypted
 * string field) carries a 1-byte header that fully declares the codec
 * stack applied. A reader given the byte sequence alone can determine
 * how to decode it without consulting `vault:meta` or any other
 * external context.
 *
 *   byte 0   : codec flags
 *     bit 0  (0x01): encrypted (AES-GCM v1, IV(12B) immediately follows)
 *     bit 1  (0x02): compressed (gzip v1)
 *     bit 2-6     : reserved, must be 0 (reader rejects)
 *     bit 7  (0x80): extension flag, must be 0 in v1 (reserved escape
 *                    for a future extended descriptor at byte 1)
 *   byte 1+  : [IV(12B) — only if bit 0=1] [payload]
 *
 * The order of operations is fixed: on push the body is compressed
 * before it is encrypted (`encrypt(compress(plain))`). The header
 * records what was applied; the order is implicit in invariant 10.
 *
 * Plaintext + uncompressed attachments still carry the `0x00` header
 * for universal self-description (invariant 12). Plaintext string
 * fields without encryption keep their bare base64 encoding — the
 * format is unambiguous and an envelope adds no information.
 */

import type { CryptoProvider } from "./crypto-provider.ts";

const FLAG_ENCRYPTED = 0x01;
const FLAG_COMPRESSED = 0x02;
const FLAG_EXTENSION = 0x80;
const RESERVED_MASK = 0b0111_1100; // bits 2-6
const IV_LENGTH = 12;

export interface CodecBits {
    encrypted: boolean;
    compressed: boolean;
}

/** A parsed envelope. Decorators receive these, transform body /
 *  bits / iv, and re-encode for the next layer. */
export interface Envelope {
    bits: CodecBits;
    /** Present iff `bits.encrypted`. Always exactly 12 bytes. */
    iv?: Uint8Array;
    /** Payload bytes after the IV (if any). */
    body: Uint8Array;
}

export class EnvelopeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "EnvelopeError";
    }
}

export function plainEnvelope(body: Uint8Array): Envelope {
    return { bits: { encrypted: false, compressed: false }, body };
}

function flagsByte(bits: CodecBits): number {
    let b = 0;
    if (bits.encrypted) b |= FLAG_ENCRYPTED;
    if (bits.compressed) b |= FLAG_COMPRESSED;
    return b;
}

export function encodeEnvelope(env: Envelope): Uint8Array {
    if (env.bits.encrypted) {
        if (!env.iv || env.iv.length !== IV_LENGTH) {
            throw new EnvelopeError(
                `encodeEnvelope: encrypted envelope requires IV of ${IV_LENGTH} bytes`,
            );
        }
        const out = new Uint8Array(1 + IV_LENGTH + env.body.length);
        out[0] = flagsByte(env.bits);
        out.set(env.iv, 1);
        out.set(env.body, 1 + IV_LENGTH);
        return out;
    }
    if (env.iv) {
        throw new EnvelopeError(
            "encodeEnvelope: iv present but encrypted bit not set",
        );
    }
    const out = new Uint8Array(1 + env.body.length);
    out[0] = flagsByte(env.bits);
    out.set(env.body, 1);
    return out;
}

export function decodeEnvelope(blob: Uint8Array): Envelope {
    if (blob.length < 1) {
        throw new EnvelopeError("decodeEnvelope: empty blob");
    }
    const flags = blob[0];
    if (flags & RESERVED_MASK) {
        throw new EnvelopeError(
            `decodeEnvelope: reserved bits set in flag byte 0x${flags.toString(16)}`,
        );
    }
    if (flags & FLAG_EXTENSION) {
        throw new EnvelopeError(
            "decodeEnvelope: extension flag set, no extended descriptor in v1",
        );
    }
    const bits: CodecBits = {
        encrypted: (flags & FLAG_ENCRYPTED) !== 0,
        compressed: (flags & FLAG_COMPRESSED) !== 0,
    };
    if (bits.encrypted) {
        if (blob.length < 1 + IV_LENGTH) {
            throw new EnvelopeError(
                `decodeEnvelope: encrypted blob shorter than 1 + IV(${IV_LENGTH})`,
            );
        }
        return {
            bits,
            iv: blob.slice(1, 1 + IV_LENGTH),
            body: blob.slice(1 + IV_LENGTH),
        };
    }
    return { bits, body: blob.slice(1) };
}

// ── Base64 transport ──────────────────────────────────────

function uint8ToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

// ── String envelope helpers (for encryptedPath) ──

/**
 * Encrypt an arbitrary UTF-8 string into a base64-wrapped envelope.
 * Output format: `base64( [0x01][IV(12B)][AES-GCM(utf8(s))] )`.
 *
 * Symmetric with `decryptString`. Used by the encrypting-couch-client
 * for the `encryptedPath` field, which cannot ride as an attachment.
 */
export async function encryptString(
    plain: string,
    crypto: CryptoProvider,
): Promise<string> {
    const plainBytes = new TextEncoder().encode(plain);
    const { iv, cipher } = await crypto.encryptBytesIv(plainBytes);
    const envelope: Envelope = {
        bits: { encrypted: true, compressed: false },
        iv,
        body: cipher,
    };
    return uint8ToBase64(encodeEnvelope(envelope));
}

export async function decryptString(
    encoded: string,
    crypto: CryptoProvider,
): Promise<string> {
    const env = decodeEnvelope(base64ToUint8(encoded));
    if (!env.bits.encrypted || !env.iv) {
        throw new EnvelopeError("decryptString: envelope is not encrypted");
    }
    if (env.bits.compressed) {
        throw new EnvelopeError(
            "decryptString: compressed string envelopes not supported in v1",
        );
    }
    const plainBytes = await crypto.decryptBytesIv(env.iv, env.body);
    return new TextDecoder().decode(plainBytes);
}
