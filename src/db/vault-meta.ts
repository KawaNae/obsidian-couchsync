/**
 * Vault-level metadata doc — the single source of truth for codec
 * configuration on the remote vault DB. v2 generalises the older
 * `encryption:meta` to also record compression state, so a Clone
 * device can rebuild its decorator stack to match the server.
 *
 * The doc is never encrypted (the encryption key is derived from the
 * passphrase before it can be read) and always fetched via a raw
 * client. Stored at the fixed id `vault:meta`.
 */

import type { ICouchClient } from "./interfaces.ts";
import {
    deriveKeys,
    generateSalt,
    createKeyCheck,
    verifyKeyCheck,
    createCryptoProvider,
    computeMetaHmac,
    type EncryptionKeys,
    type CryptoProvider,
} from "./crypto-provider.ts";

export const VAULT_META_DOC_ID = "vault:meta";

/** Schema for the `vault:meta` doc in v2. */
export interface VaultMetaDoc {
    _id: typeof VAULT_META_DOC_ID;
    _rev?: string;
    type: "vault-meta";
    /** Doc-shape version. Bumped when the structure of *this* doc
     *  changes (independent of cipher/compression algorithm versions). */
    schemaVersion: 2;

    /** Encryption section. `enabled: false` means the salt/keyCheck/
     *  metaHmac fields are absent (and the vault is plaintext). */
    encryption:
        | {
            enabled: false;
        }
        | {
            enabled: true;
            /** Key-derivation algorithm version. v1 = PBKDF2 600k SHA-256. */
            kdfVersion: 1;
            /** Cipher / envelope version. v2 = `IV(12B) || AES-GCM(plain)` binary blob. */
            cipherVersion: 2;
            salt: string; // base64
            keyCheck: string; // encrypted token
            metaHmac?: string;
        };

    /** Compression section. `enabled: false` means attachment bodies
     *  ride the wire as-is. */
    compression:
        | {
            enabled: false;
        }
        | {
            enabled: true;
            /** Compression algorithm. Reserved for future swap-in (e.g. zstd). */
            algorithm: "gzip";
            /** Algorithm-revision marker. Currently 1 (vanilla DEFLATE/gzip). */
            version: 1;
        };
}

/** v1 -> v2 migration shim: `encryption:meta` documents written by
 *  pre-v2 builds. Kept here as a typed read target so a single-pass
 *  loader can recognise + migrate them on the fly during the
 *  transition window. */
export interface LegacyEncryptionMetaDoc {
    _id: "encryption:meta";
    _rev?: string;
    type: "encryption-meta";
    salt: string;
    keyCheck: string;
    version: 1;
    metaHmac?: string;
}

export async function fetchVaultMeta(
    client: ICouchClient,
): Promise<VaultMetaDoc | null> {
    return client.getDoc<VaultMetaDoc>(VAULT_META_DOC_ID);
}

/** Compatibility helper for Init flows that previously fetched
 *  `encryption:meta`. Returns the legacy doc if present, allowing
 *  migration code to detect the older format. */
export async function fetchLegacyEncryptionMeta(
    client: ICouchClient,
): Promise<LegacyEncryptionMetaDoc | null> {
    return client.getDoc<LegacyEncryptionMetaDoc>("encryption:meta");
}

export interface DeriveResult {
    meta: VaultMetaDoc;
    keys: EncryptionKeys;
    crypto: CryptoProvider;
}

/** Build a fresh vault:meta doc for Init. `passphrase` is required only
 *  when `encryption=true`. The returned `keys` / `crypto` are present
 *  only in the encryption-enabled case; callers that disable encryption
 *  should not attempt to use them. */
export async function buildInitialVaultMeta(opts: {
    encryption: boolean;
    passphrase?: string;
    compression: boolean;
}): Promise<DeriveResult | { meta: VaultMetaDoc; keys: null; crypto: null }> {
    if (opts.encryption) {
        if (!opts.passphrase) {
            throw new Error("buildInitialVaultMeta: passphrase required when encryption=true");
        }
        const salt = generateSalt();
        const keys = await deriveKeys(opts.passphrase, salt);
        const keyCheck = await createKeyCheck(keys);
        const saltB64 = uint8ToBase64(salt);
        const metaHmac = await computeMetaHmac(opts.passphrase, saltB64, keyCheck, 1);
        const meta: VaultMetaDoc = {
            _id: VAULT_META_DOC_ID,
            type: "vault-meta",
            schemaVersion: 2,
            encryption: {
                enabled: true,
                kdfVersion: 1,
                cipherVersion: 2,
                salt: saltB64,
                keyCheck,
                metaHmac,
            },
            compression: opts.compression
                ? { enabled: true, algorithm: "gzip", version: 1 }
                : { enabled: false },
        };
        return { meta, keys, crypto: createCryptoProvider(keys) };
    }
    const meta: VaultMetaDoc = {
        _id: VAULT_META_DOC_ID,
        type: "vault-meta",
        schemaVersion: 2,
        encryption: { enabled: false },
        compression: opts.compression
            ? { enabled: true, algorithm: "gzip", version: 1 }
            : { enabled: false },
    };
    return { meta, keys: null, crypto: null };
}

export async function pushVaultMeta(
    client: ICouchClient,
    meta: VaultMetaDoc,
): Promise<void> {
    const { _rev, ...withoutRev } = meta;
    void _rev;
    await client.bulkDocs([withoutRev]);
}

/** Clone-side: derive crypto keys from passphrase against the meta's
 *  stored salt + keyCheck. Returns null when the passphrase does not
 *  match either the integrity HMAC or the key-check token. */
export async function unlockVaultMeta(
    meta: VaultMetaDoc,
    passphrase: string,
): Promise<{ keys: EncryptionKeys; crypto: CryptoProvider } | null> {
    if (!meta.encryption.enabled) return null;
    const enc = meta.encryption;
    if (enc.metaHmac) {
        const expected = await computeMetaHmac(
            passphrase, enc.salt, enc.keyCheck, 1,
        );
        if (expected !== enc.metaHmac) return null;
    }
    const salt = base64ToUint8(enc.salt);
    const keys = await deriveKeys(passphrase, salt);
    const ok = await verifyKeyCheck(keys, enc.keyCheck);
    if (!ok) return null;
    return { keys, crypto: createCryptoProvider(keys) };
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
