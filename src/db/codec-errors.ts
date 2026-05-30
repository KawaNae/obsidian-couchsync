/**
 * codec-errors.ts — low-level codec error types.
 *
 * Home for the error classes the codec layer throws (`EncryptingCouchClient`,
 * `envelope`). It is a leaf module with NO imports, so any module — including
 * the sync stack — can classify a codec failure without compile-depending on a
 * specific decorator implementation. This keeps the decorator an invisible
 * codec layer (the sync stack operates on plaintext): `push-pipeline` /
 * `pull-pipeline` recognise a transient decrypt failure by importing
 * `EncryptionError` from here, not from `encrypting-couch-client.ts`.
 *
 * The original modules (`encrypting-couch-client.ts`, `envelope.ts`) re-export
 * these for back-compat, so existing import sites keep working.
 */

/** Thrown by the encrypting decorator when a doc/attachment body cannot be
 *  decrypted (wrong key, missing IV, failed GCM tag) or when the vault's
 *  cipherVersion policy floor refuses an unsealed body (#1/#3). */
export class EncryptionError extends Error {
    constructor(
        message: string,
        public readonly cause?: unknown,
        /** `false` for policy/security violations (cipherVersion downgrade
         *  gate, encBody id/path HMAC mismatch) that retrying never fixes —
         *  they route to a terminal hard-error. `true` (default) for transient
         *  decrypt failures (key not yet distributed, partial write) that
         *  survive backoff. Read by `classifyError` (#enc-1). */
        public readonly retriable: boolean = true,
    ) {
        super(message);
        this.name = "EncryptionError";
    }
}

/** Thrown when a codec envelope is structurally malformed — empty, reserved
 *  bits set, extension flag set, or an encrypted envelope shorter than its
 *  declared IV. Distinct from a content/hash mismatch. */
export class EnvelopeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "EnvelopeError";
    }
}
