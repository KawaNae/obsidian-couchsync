/**
 * Codec agreement check — compares local codec settings (encryption,
 * compression) with a remote DB's self-describing meta doc.
 *
 * Generic over the meta kind: `vault:meta` for the vault DB,
 * `config:meta` for the config DB. Phase 2 (invariant 17/18) treats
 * each meta as an independent crypto root, so this check runs once
 * per DB — once at vault startup against vault:meta, once at config
 * startup against config:meta. Both call paths share this function via
 * the `metaDocId` parameter.
 *
 * Used at startup (main.ts) and per-session (SyncEngine pre-catchup hook)
 * to ensure no data flows until both sides agree on codec state. Always
 * fetches via a RAW client (not EncryptingCouchClient / CompressingCouchClient)
 * because the meta doc is never itself encrypted or compressed.
 *
 * Naming note: the file/exports retain "Encryption" prefixes for back-compat
 * with the v1 API surface; v2 generalises the check to both codec axes.
 */

import type { ICouchClient } from "./interfaces.ts";
import {
    fetchVaultMeta,
    fetchConfigMeta,
    fetchLegacyEncryptionMeta,
    VAULT_META_DOC_ID,
    CONFIG_META_DOC_ID,
    type VaultMetaDoc,
    type ConfigMetaDoc,
    type DbMetaDoc,
} from "./vault-meta.ts";

export type EncryptionAgreement =
    | { status: "agreed-encrypted"; meta: DbMetaDoc }
    | { status: "agreed-plaintext"; meta: DbMetaDoc | null }
    | { status: "remote-encrypted"; meta: DbMetaDoc }
    | { status: "remote-plaintext"; meta: DbMetaDoc | null }
    /** Legacy `encryption:meta` doc found on remote but no `vault:meta`.
     *  Triggers a migration prompt in main.ts. Vault-DB-only — config
     *  DB never carried a legacy meta. */
    | { status: "legacy-meta-only" }
    /** The remote meta declares a cipherVersion BELOW this device's locally
     *  recorded floor (`settings.vaultCipherVersion` / `configCipherVersion`).
     *  Because the meta doc is server-writable, a curious server can rewrite
     *  cipherVersion 3 → 2 to re-enable the unauthenticated legacy/plaintext
     *  decode path (#1/#3). Refusing it here, before any data flows, keeps the
     *  TOFU floor monotonic. Surfaced like a wrong-passphrase / tamper error. */
    | { status: "cipher-downgrade-detected"; meta: DbMetaDoc; localFloor: number };

/**
 * Check codec agreement against a specific meta doc id.
 *
 * - `"vault:meta"` (default): vault DB. Legacy `encryption:meta` fallback
 *   triggers a v1 → v2 migration prompt.
 * - `"config:meta"`: config DB. No legacy fallback — config:meta was
 *   introduced in v0.26 alongside chunking.
 */
export async function checkEncryptionAgreement(
    rawClient: ICouchClient,
    localEncryptionEnabled: boolean,
    metaDocId: typeof VAULT_META_DOC_ID | typeof CONFIG_META_DOC_ID = VAULT_META_DOC_ID,
    /** This device's locally-recorded cipherVersion floor (TOFU). When set and
     *  the remote meta is encrypted with a LOWER cipherVersion, the result is
     *  `cipher-downgrade-detected` — a server cannot lower the floor by
     *  rewriting the (server-writable) meta. `undefined` skips the gate (first
     *  observation / plaintext vault). */
    localCipherFloor?: number,
): Promise<EncryptionAgreement> {
    const meta = metaDocId === VAULT_META_DOC_ID
        ? await fetchVaultMeta(rawClient)
        : await fetchConfigMeta(rawClient);
    if (meta) {
        const remoteEncrypted = meta.encryption.enabled;
        if (
            meta.encryption.enabled && localCipherFloor !== undefined
            && meta.encryption.cipherVersion < localCipherFloor
        ) {
            return {
                status: "cipher-downgrade-detected",
                meta,
                localFloor: localCipherFloor,
            };
        }
        if (remoteEncrypted && localEncryptionEnabled) {
            return { status: "agreed-encrypted", meta };
        }
        if (!remoteEncrypted && !localEncryptionEnabled) {
            return { status: "agreed-plaintext", meta };
        }
        if (remoteEncrypted && !localEncryptionEnabled) {
            return { status: "remote-encrypted", meta };
        }
        return { status: "remote-plaintext", meta };
    }
    // Vault-only legacy check: an older v1 `encryption:meta` doc may
    // exist on the server, signalling the v2 migration is needed.
    // Config DB never had a legacy meta — skip the probe there to
    // avoid a wasted round-trip.
    if (metaDocId === VAULT_META_DOC_ID) {
        const legacy = await fetchLegacyEncryptionMeta(rawClient);
        if (legacy) {
            return { status: "legacy-meta-only" };
        }
    }
    // No meta of any kind, no local encryption configured — fresh plaintext.
    if (!localEncryptionEnabled) {
        return { status: "agreed-plaintext", meta: null };
    }
    return { status: "remote-plaintext", meta: null };
}
