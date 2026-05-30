/**
 * E2E encryption primitives using Web Crypto API.
 *
 * Two purpose-specific keys are derived from a single passphrase:
 *   - contentKey (AES-256-GCM): encrypts attachment bytes and string fields
 *   - hmacKey (HMAC-SHA256): generates path-based content-addressed IDs
 *
 * Deriving separate keys via HKDF ensures that HMAC output (visible as
 * path-derived IDs on the server) leaks no information about the AES key.
 *
 * The provider exposes *primitives only* — IV + ciphertext as separate
 * Uint8Array values. Envelope framing (the `[codec-byte][IV?][body]`
 * format that lands on the wire) lives in `envelope.ts`; this module
 * is unaware of it. That separation keeps invariant 13 (encrypted
 * string envelope versioning) enforced structurally: there is no way
 * to call the provider directly and produce a non-versioned string
 * envelope.
 */

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

/** TS 5.7+ types a bare `Uint8Array` as `Uint8Array<ArrayBufferLike>`, which
 *  the DOM `BufferSource` (WebCrypto args) rejects because it pins to an
 *  `ArrayBuffer`-backed view. Our buffers are always `ArrayBuffer`-backed at
 *  runtime, so re-asserting the type is sound. Centralised here so the cast
 *  is documented once rather than scattered as inline `as` noise. */
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

export interface CryptoProvider {
    /** Encrypt arbitrary plain bytes. Returns the AES-GCM ciphertext
     *  (which already includes the authentication tag) and the random
     *  IV used. Callers compose the envelope.
     *
     *  `aad` (additional authenticated data) is covered by the GCM tag but
     *  NOT encrypted: the same exact bytes must be supplied to `decryptBytesIv`
     *  or authentication fails. Used to bind a ciphertext to its identity (the
     *  doc `_id`) so a tampering server cannot move an encrypted body onto a
     *  different doc. Omit for unbound payloads (e.g. chunk attachments, which
     *  are bound by content-addressing instead). */
    encryptBytesIv(plain: Uint8Array, aad?: Uint8Array): Promise<{ iv: Uint8Array; cipher: Uint8Array }>;
    /** Decrypt ciphertext produced by `encryptBytesIv`. The IV must be the
     *  exact 12-byte value, and `aad` the exact bytes, from the corresponding
     *  encrypt call — otherwise the GCM tag check throws. */
    decryptBytesIv(iv: Uint8Array, cipher: Uint8Array, aad?: Uint8Array): Promise<Uint8Array>;
    /** HMAC-SHA256 over binary input. Returns hex-encoded MAC. Callers
     *  hashing a string (e.g. vault path) must `TextEncoder.encode` it
     *  themselves — this method does not infer encoding. */
    hmacHash(data: Uint8Array): Promise<string>;
}

export interface EncryptionKeys {
    contentKey: CryptoKey;
    hmacKey: CryptoKey;
}

export function generateSalt(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

export async function deriveKeys(
    passphrase: string,
    salt: Uint8Array,
): Promise<EncryptionKeys> {
    const encoder = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(passphrase),
        "PBKDF2",
        false,
        ["deriveBits"],
    );
    const masterBits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: bs(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
        baseKey,
        256,
    );
    const masterKey = await crypto.subtle.importKey(
        "raw",
        masterBits,
        "HKDF",
        false,
        ["deriveBits", "deriveKey"],
    );
    const contentKey = await crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode("couchsync-content") },
        masterKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
    );
    const hmacKey = await crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode("couchsync-hmac") },
        masterKey,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign"],
    );
    return { contentKey, hmacKey };
}

export function createCryptoProvider(keys: EncryptionKeys): CryptoProvider {
    return {
        async encryptBytesIv(plain: Uint8Array, aad?: Uint8Array): Promise<{ iv: Uint8Array; cipher: Uint8Array }> {
            const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
            const params: AesGcmParams = { name: "AES-GCM", iv: bs(iv) };
            if (aad !== undefined) params.additionalData = bs(aad);
            const cipherBuf = await crypto.subtle.encrypt(
                params,
                keys.contentKey,
                bs(plain),
            );
            return { iv, cipher: new Uint8Array(cipherBuf) };
        },

        async decryptBytesIv(iv: Uint8Array, cipher: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
            if (iv.length !== IV_BYTES) {
                throw new Error(`decryptBytesIv: IV must be ${IV_BYTES} bytes`);
            }
            const params: AesGcmParams = { name: "AES-GCM", iv: bs(iv) };
            if (aad !== undefined) params.additionalData = bs(aad);
            const plainBuf = await crypto.subtle.decrypt(
                params,
                keys.contentKey,
                bs(cipher),
            );
            return new Uint8Array(plainBuf);
        },

        async hmacHash(data: Uint8Array): Promise<string> {
            const sig = await crypto.subtle.sign("HMAC", keys.hmacKey, bs(data));
            return arrayBufToHex(sig);
        },
    };
}

function arrayBufToHex(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
    return hex;
}
