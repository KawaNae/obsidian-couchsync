/**
 * Vault-level metadata doc — the **capability declaration** for the
 * remote vault DB. v2 generalises the older `encryption:meta` to also
 * record compression state, so a Clone device can rebuild its
 * decorator stack (encryption on/off, compression on/off, KDF
 * version, cipher version) to match what the vault was initialised
 * with.
 *
 * ## Role boundary (post-v0.25.0)
 *
 * `vault:meta` declares **what this vault is** at a global level. It
 * is **never consulted to decode an individual byte sequence**:
 *
 * - Attachment binary carries its own 1-byte codec envelope header
 *   (`envelope.ts`) that fully describes encrypted/compressed status.
 * - Encrypted string fields (`encryptedPath`) are base64-wrapped
 *   envelopes with the same self-describing header.
 * - Replicated doc bodies carry `schemaVersion` for shape.
 * - Chunk ids carry the hash-algorithm tag (`chunk:<alg>:<hash>`).
 *
 * That separation (invariants 11-15) means a reader handed any single
 * byte sequence can decode it without first fetching `vault:meta`.
 * The doc is for Clone-time stack assembly and human-facing settings
 * — not the per-blob decode path.
 *
 * The doc is never encrypted (the encryption key is derived from the
 * passphrase before it can be read) and always fetched via a raw
 * client. Stored at the fixed id `vault:meta`.
 */

import type { ICouchClient } from "./interfaces.ts";
import {
    deriveKeys,
    generateSalt,
    createCryptoProvider,
    type EncryptionKeys,
    type CryptoProvider,
} from "./crypto-provider.ts";
import { encryptString, decryptString } from "./envelope.ts";

/** Known-plaintext token used to verify that a passphrase derives the
 *  correct contentKey. Stored encrypted in `vault:meta.encryption.keyCheck`;
 *  a Clone device decrypts it on unlock and matches against this constant
 *  before attempting to touch real content. */
const KEY_CHECK_PLAINTEXT = "couchsync-e2e-v1";

/** Build the encrypted key-check token. Returns the base64-wrapped
 *  envelope produced by `encryptString` — the same self-describing
 *  format every other encrypted string in the vault uses. */
export async function createKeyCheck(keys: EncryptionKeys): Promise<string> {
    return encryptString(KEY_CHECK_PLAINTEXT, createCryptoProvider(keys));
}

export async function verifyKeyCheck(
    keys: EncryptionKeys,
    keyCheck: string,
): Promise<boolean> {
    try {
        const decrypted = await decryptString(keyCheck, createCryptoProvider(keys));
        return decrypted === KEY_CHECK_PLAINTEXT;
    } catch {
        return false;
    }
}

export const VAULT_META_DOC_ID = "vault:meta";
export const CONFIG_META_DOC_ID = "config:meta";

/** Schema for the `vault:meta` doc in v2. */
export interface VaultMetaDoc {
    _id: typeof VAULT_META_DOC_ID;
    _rev?: string;
    type: "vault-meta";
    /** Doc-shape version. Bumped when the structure of *this* doc
     *  changes (independent of cipher/compression algorithm versions). */
    schemaVersion: 2;

    /** Encryption section. `enabled: false` means the salt/keyCheck
     *  fields are absent (and the vault is plaintext). */
    encryption:
        | {
            enabled: false;
        }
        | {
            enabled: true;
            /** Key-derivation algorithm version. v1 = PBKDF2 600k SHA-256. */
            kdfVersion: 1;
            /** Cipher / envelope version.
             *  - v2: `IV(12B) || AES-GCM(plain)` attachment blobs; file/config
             *        doc bodies were plaintext with only the path encrypted
             *        (`encryptedPath`).
             *  - v3: file/config doc bodies are compressed-then-encrypted into a
             *        single `encBody`, GCM-bound to the `_id` (AAD). Attachment
             *        framing is unchanged. (#2 — authenticated, confidential body.) */
            cipherVersion: 2 | 3;
            salt: string; // base64
            keyCheck: string; // encrypted token
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
}

export async function fetchVaultMeta(
    client: ICouchClient,
): Promise<VaultMetaDoc | null> {
    return client.getDoc<VaultMetaDoc>(VAULT_META_DOC_ID);
}

/**
 * Schema for the `config:meta` doc — self-describing meta for the
 * separate config DB.
 *
 * **Phase 2 (v0.26) — independent crypto principal.** Each `<db>:meta`
 * is its own crypto root: own salt, own keyCheck. The
 * structural shape mirrors VaultMetaDoc so a single generic helper
 * (`buildInitialMeta` / `unlockMeta`) can build and unlock both, but
 * the crypto material is not shared — same passphrase + different salts
 * → different keys → vault HMAC and config HMAC live in disjoint id
 * spaces. Invariant 17 (this doc is authority for config DB codec
 * state) and invariant 18 (cryptoProvider is per-DB) hold simultaneously.
 *
 * `schemaVersion: 2` — bumped from the Phase 1 in-progress shape (which
 * was a clone of vault:meta and therefore not a real crypto root).
 * Readers that see schemaVersion 1 surface "Config Init required" so the
 * Phase 1 → Phase 2 transition lands cleanly on a fresh own-salt write.
 */
export interface ConfigMetaDoc {
    _id: typeof CONFIG_META_DOC_ID;
    _rev?: string;
    type: "config-meta";
    schemaVersion: 2;
    encryption: VaultMetaDoc["encryption"];
    compression: VaultMetaDoc["compression"];
}

/** Union of self-describing meta docs. Helpers below are generic over
 *  this — `buildInitialMeta` / `unlockMeta` / `pushMeta` all accept
 *  either kind, dispatched on `docType`. */
export type DbMetaDoc = VaultMetaDoc | ConfigMetaDoc;

export async function fetchConfigMeta(
    client: ICouchClient,
): Promise<ConfigMetaDoc | null> {
    return client.getDoc<ConfigMetaDoc>(CONFIG_META_DOC_ID);
}

/**
 * Build an initial config:meta doc as a self-contained crypto root.
 * Mirrors `buildInitialVaultMeta`'s shape: fresh salt → derive keys →
 * compute keyCheck. The returned `crypto` is what the host pipes into
 * `wrapConfigClient` and `configChunkHasher`.
 *
 * Phase 2 signature change: previously this cloned from `vault:meta`
 * (`buildInitialConfigMeta(vaultMeta)`). That coupling broke
 * cross-vault config sharing (Android decrypt failure, 2026-05-29).
 * The new shape takes the same `{encryption, passphrase, compression}`
 * triple as the vault builder and produces a fully independent root.
 */
export async function buildInitialConfigMeta(opts: {
    encryption: boolean;
    passphrase?: string;
    compression: boolean;
}): Promise<{ meta: ConfigMetaDoc; keys: EncryptionKeys | null; crypto: CryptoProvider | null }> {
    const inner = await buildInitialMeta({
        docId: CONFIG_META_DOC_ID,
        docType: "config-meta",
        encryption: opts.encryption,
        passphrase: opts.passphrase,
        compression: opts.compression,
    });
    return inner as { meta: ConfigMetaDoc; keys: EncryptionKeys | null; crypto: CryptoProvider | null };
}

export async function pushConfigMeta(
    client: ICouchClient,
    meta: ConfigMetaDoc,
): Promise<void> {
    return pushMeta(client, meta);
}

/** Unlock a config:meta with `passphrase`. Symmetric with
 *  `unlockVaultMeta`. Returns null on passphrase mismatch (caller
 *  surfaces a prompt or Notice). */
export async function unlockConfigMeta(
    meta: ConfigMetaDoc,
    passphrase: string,
): Promise<{ keys: EncryptionKeys; crypto: CryptoProvider } | null> {
    return unlockMeta(meta, passphrase);
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

/** Build a fresh vault:meta. Thin wrapper over the generic `buildInitialMeta`. */
export async function buildInitialVaultMeta(opts: {
    encryption: boolean;
    passphrase?: string;
    compression: boolean;
}): Promise<DeriveResult | { meta: VaultMetaDoc; keys: null; crypto: null }> {
    const inner = await buildInitialMeta({
        docId: VAULT_META_DOC_ID,
        docType: "vault-meta",
        encryption: opts.encryption,
        passphrase: opts.passphrase,
        compression: opts.compression,
    });
    return inner as DeriveResult | { meta: VaultMetaDoc; keys: null; crypto: null };
}

export async function pushVaultMeta(
    client: ICouchClient,
    meta: VaultMetaDoc,
): Promise<void> {
    return pushMeta(client, meta);
}

/** Clone-side: derive crypto keys from passphrase against the vault:meta's
 *  stored salt + keyCheck. Thin wrapper over the generic `unlockMeta`. */
export async function unlockVaultMeta(
    meta: VaultMetaDoc,
    passphrase: string,
): Promise<{ keys: EncryptionKeys; crypto: CryptoProvider } | null> {
    return unlockMeta(meta, passphrase);
}

// ── Generic meta helpers (Phase 2) ─────────────────────────

/** Schema version stamped on freshly-built meta docs of each kind. */
const META_SCHEMA_VERSION = {
    "vault-meta": 2,
    "config-meta": 2,
} as const satisfies Record<DbMetaDoc["type"], number>;

interface BuildMetaOpts {
    docId: typeof VAULT_META_DOC_ID | typeof CONFIG_META_DOC_ID;
    docType: DbMetaDoc["type"];
    encryption: boolean;
    passphrase?: string;
    compression: boolean;
}

interface BuildMetaResult<T extends DbMetaDoc> {
    meta: T;
    keys: EncryptionKeys | null;
    crypto: CryptoProvider | null;
}

/**
 * Build any `*:meta` doc as a self-contained crypto root. Dispatched by
 * `docType`. Encryption-enabled path generates fresh salt → keyCheck so
 * the resulting meta is decryptable on any device that holds the
 * passphrase. Plaintext path skips the crypto lifecycle and returns
 * `keys/crypto: null`.
 *
 * Two metas built from the same passphrase but different `docId` produce
 * **different** salts (and therefore different keys) — that is the
 * structural mechanism of Phase 2's invariant 18.
 */
export async function buildInitialMeta(opts: BuildMetaOpts): Promise<BuildMetaResult<DbMetaDoc>> {
    if (opts.encryption) {
        if (!opts.passphrase) {
            throw new Error(
                `buildInitialMeta: passphrase required when encryption=true (${opts.docId})`,
            );
        }
        const salt = generateSalt();
        const keys = await deriveKeys(opts.passphrase, salt);
        const keyCheck = await createKeyCheck(keys);
        const saltB64 = uint8ToBase64(salt);
        const meta = {
            _id: opts.docId,
            type: opts.docType,
            schemaVersion: META_SCHEMA_VERSION[opts.docType],
            encryption: {
                enabled: true,
                kdfVersion: 1,
                cipherVersion: 3,
                salt: saltB64,
                keyCheck,
            },
            compression: opts.compression
                ? { enabled: true, algorithm: "gzip", version: 1 }
                : { enabled: false },
        } as DbMetaDoc;
        return { meta, keys, crypto: createCryptoProvider(keys) };
    }
    const meta = {
        _id: opts.docId,
        type: opts.docType,
        schemaVersion: META_SCHEMA_VERSION[opts.docType],
        encryption: { enabled: false },
        compression: opts.compression
            ? { enabled: true, algorithm: "gzip", version: 1 }
            : { enabled: false },
    } as DbMetaDoc;
    return { meta, keys: null, crypto: null };
}

/** Unlock any `*:meta` against a passphrase. Returns null on keyCheck
 *  failure (decrypt produced unexpected plaintext — likely a wrong
 *  passphrase, since the AES-GCM auth tag fails). keyCheck is the sole
 *  passphrase verifier: it is authenticated and costs a full PBKDF2
 *  derivation per guess, so there is no faster offline oracle. Symmetric
 *  for both vault and config DBs — invariant 17 means each meta carries
 *  everything needed to verify itself. */
export async function unlockMeta(
    meta: DbMetaDoc,
    passphrase: string,
): Promise<{ keys: EncryptionKeys; crypto: CryptoProvider } | null> {
    if (!meta.encryption.enabled) return null;
    const enc = meta.encryption;
    const salt = base64ToUint8(enc.salt);
    const keys = await deriveKeys(passphrase, salt);
    const ok = await verifyKeyCheck(keys, enc.keyCheck);
    if (!ok) return null;
    return { keys, crypto: createCryptoProvider(keys) };
}

/** Push a meta doc (vault or config) via the supplied client. Strips
 *  `_rev` because the bulkDocs call expects a fresh body — the remote
 *  rev tree is owned by the DB, not the caller. */
export async function pushMeta(
    client: ICouchClient,
    meta: DbMetaDoc,
): Promise<void> {
    const { _rev, ...withoutRev } = meta;
    void _rev;
    await client.bulkDocs([withoutRev]);
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
