/**
 * Manages the encryption metadata document stored in the remote vault DB.
 *
 * The `encryption:meta` doc holds the PBKDF2 salt and a key-check token
 * so that new devices can derive the same keys from the passphrase and
 * verify correctness before attempting to decrypt any content.
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

const META_DOC_ID = "encryption:meta";

export interface EncryptionMetaDoc {
    _id: typeof META_DOC_ID;
    _rev?: string;
    type: "encryption-meta";
    salt: string;
    keyCheck: string;
    version: 1;
    metaHmac?: string;
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

export async function fetchEncryptionMeta(
    client: ICouchClient,
): Promise<EncryptionMetaDoc | null> {
    return client.getDoc<EncryptionMetaDoc>(META_DOC_ID);
}

export async function deriveEncryption(
    passphrase: string,
): Promise<{ meta: EncryptionMetaDoc; keys: EncryptionKeys; crypto: CryptoProvider }> {
    const salt = generateSalt();
    const keys = await deriveKeys(passphrase, salt);
    const keyCheck = await createKeyCheck(keys);
    const saltB64 = uint8ToBase64(salt);
    const metaHmac = await computeMetaHmac(passphrase, saltB64, keyCheck, 1);
    const meta: EncryptionMetaDoc = {
        _id: META_DOC_ID,
        type: "encryption-meta",
        salt: saltB64,
        keyCheck,
        version: 1,
        metaHmac,
    };
    return { meta, keys, crypto: createCryptoProvider(keys) };
}

export async function pushEncryptionMeta(
    client: ICouchClient,
    meta: EncryptionMetaDoc,
): Promise<void> {
    const { _rev, ...withoutRev } = meta;
    await client.bulkDocs([withoutRev]);
}

export async function unlockWithPassphrase(
    meta: EncryptionMetaDoc,
    passphrase: string,
): Promise<{ keys: EncryptionKeys; crypto: CryptoProvider } | null> {
    if (meta.metaHmac) {
        const expected = await computeMetaHmac(
            passphrase, meta.salt, meta.keyCheck, meta.version,
        );
        if (expected !== meta.metaHmac) return null;
    }
    const salt = base64ToUint8(meta.salt);
    const keys = await deriveKeys(passphrase, salt);
    const ok = await verifyKeyCheck(keys, meta.keyCheck);
    if (!ok) return null;
    return { keys, crypto: createCryptoProvider(keys) };
}
