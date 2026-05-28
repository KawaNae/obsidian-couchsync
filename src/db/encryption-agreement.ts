/**
 * Vault codec agreement check — compares local codec settings (encryption,
 * compression) with the remote vault DB's `vault:meta` document.
 *
 * Used at startup (main.ts) and per-session (SyncEngine pre-catchup hook)
 * to ensure no data flows until both sides agree on codec state. Always
 * fetches via a RAW client (not EncryptingCouchClient / CompressingCouchClient)
 * because `vault:meta` is never itself encrypted or compressed.
 *
 * Naming note: the file/exports retain "Encryption" prefixes for back-compat
 * with the v1 API surface; v2 generalises the check to both codec axes.
 */

import type { ICouchClient } from "./interfaces.ts";
import {
    fetchVaultMeta,
    fetchLegacyEncryptionMeta,
    type VaultMetaDoc,
} from "./vault-meta.ts";

export type EncryptionAgreement =
    | { status: "agreed-encrypted"; meta: VaultMetaDoc }
    | { status: "agreed-plaintext"; meta: VaultMetaDoc | null }
    | { status: "remote-encrypted"; meta: VaultMetaDoc }
    | { status: "remote-plaintext"; meta: VaultMetaDoc | null }
    /** Legacy `encryption:meta` doc found on remote but no `vault:meta`.
     *  Triggers a migration prompt in main.ts. */
    | { status: "legacy-meta-only" };

export async function checkEncryptionAgreement(
    rawClient: ICouchClient,
    localEncryptionEnabled: boolean,
): Promise<EncryptionAgreement> {
    const meta = await fetchVaultMeta(rawClient);
    if (meta) {
        const remoteEncrypted = meta.encryption.enabled;
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
    // No vault:meta on the server — check whether an older v1
    // `encryption:meta` doc exists so main.ts can route the user to
    // the v2 migration flow.
    const legacy = await fetchLegacyEncryptionMeta(rawClient);
    if (legacy) {
        return { status: "legacy-meta-only" };
    }
    // No meta of any kind, no local encryption configured — fresh plaintext.
    if (!localEncryptionEnabled) {
        return { status: "agreed-plaintext", meta: null };
    }
    return { status: "remote-plaintext", meta: null };
}
