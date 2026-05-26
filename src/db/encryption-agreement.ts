/**
 * Encryption agreement check — compares local encryption state with the
 * remote vault DB's `encryption:meta` document.
 *
 * Used at startup (main.ts) and per-session (SyncEngine pre-catchup hook)
 * to ensure no data flows until both sides agree on encryption state.
 * Always fetches via a RAW client (not EncryptingCouchClient) because
 * `encryption:meta` is never itself encrypted.
 */

import type { ICouchClient } from "./interfaces.ts";
import { fetchEncryptionMeta, type EncryptionMetaDoc } from "./encryption-meta.ts";

export type EncryptionAgreement =
    | { status: "agreed-encrypted"; meta: EncryptionMetaDoc }
    | { status: "agreed-plaintext" }
    | { status: "remote-encrypted"; meta: EncryptionMetaDoc }
    | { status: "remote-plaintext" };

export async function checkEncryptionAgreement(
    rawClient: ICouchClient,
    localEncryptionEnabled: boolean,
): Promise<EncryptionAgreement> {
    const meta = await fetchEncryptionMeta(rawClient);
    if (meta && localEncryptionEnabled) {
        return { status: "agreed-encrypted", meta };
    }
    if (!meta && !localEncryptionEnabled) {
        return { status: "agreed-plaintext" };
    }
    if (meta && !localEncryptionEnabled) {
        return { status: "remote-encrypted", meta };
    }
    return { status: "remote-plaintext" };
}
