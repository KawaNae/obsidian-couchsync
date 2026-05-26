/**
 * E2E encryption primitives using Web Crypto API.
 *
 * Two purpose-specific keys are derived from a single passphrase:
 *   - contentKey (AES-256-GCM): encrypts ChunkDoc.data and ConfigDoc.data
 *   - hmacKey (HMAC-SHA256): generates content-addressed chunk IDs
 *
 * Deriving separate keys via HKDF ensures that HMAC output (visible as
 * chunk IDs on the server) leaks no information about the AES key.
 */

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_CHECK_PLAINTEXT = "couchsync-e2e-v1";

export interface CryptoProvider {
    encrypt(plainBase64: string): Promise<string>;
    decrypt(envelope: string): Promise<string>;
    hmacHash(data: string): Promise<string>;
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
        { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
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

export async function createKeyCheck(keys: EncryptionKeys): Promise<string> {
    const provider = createCryptoProvider(keys);
    return provider.encrypt(btoa(KEY_CHECK_PLAINTEXT));
}

export async function verifyKeyCheck(
    keys: EncryptionKeys,
    keyCheck: string,
): Promise<boolean> {
    try {
        const provider = createCryptoProvider(keys);
        const decrypted = await provider.decrypt(keyCheck);
        return atob(decrypted) === KEY_CHECK_PLAINTEXT;
    } catch {
        return false;
    }
}

export function createCryptoProvider(keys: EncryptionKeys): CryptoProvider {
    return {
        async encrypt(plainBase64: string): Promise<string> {
            const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
            const encoder = new TextEncoder();
            const cipherBuf = await crypto.subtle.encrypt(
                { name: "AES-GCM", iv },
                keys.contentKey,
                encoder.encode(plainBase64),
            );
            return uint8ToBase64(iv) + ":" + uint8ToBase64(new Uint8Array(cipherBuf));
        },

        async decrypt(envelope: string): Promise<string> {
            const colonIdx = envelope.indexOf(":");
            if (colonIdx < 0) throw new Error("Invalid encrypted envelope");
            const iv = base64ToUint8(envelope.slice(0, colonIdx));
            const ciphertext = base64ToUint8(envelope.slice(colonIdx + 1));
            const plainBuf = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv },
                keys.contentKey,
                ciphertext,
            );
            return new TextDecoder().decode(plainBuf);
        },

        async hmacHash(data: string): Promise<string> {
            const encoder = new TextEncoder();
            const sig = await crypto.subtle.sign("HMAC", keys.hmacKey, encoder.encode(data));
            return arrayBufToHex(sig);
        },
    };
}

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

function arrayBufToHex(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
    return hex;
}
