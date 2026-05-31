/**
 * Config-DB codec policy — the single source of truth for how the config
 * (settings) sync resolves its encryption / passphrase / compression.
 *
 * The config DB is an independent crypto principal (invariant 18): each of
 * its three codec knobs can override the corresponding vault setting, or
 * inherit it. The inherit sentinel differs per field, which is exactly the
 * footgun this module exists to contain:
 *
 *   - `encryption` / `compression` are booleans. `undefined` = inherit, so
 *     they resolve with `??`. Writing `false` is a real, distinct value.
 *   - `passphrase` is a string. The UI stores `""` for "left blank", so the
 *     inherit sentinel is the empty string and it resolves with `||`. Using
 *     `??` here would treat `""` as an explicit empty passphrase and unlock
 *     would fail (this was a real on-device bug — the `?? → ||` fix).
 *
 * Every call site that needs the effective config codec MUST go through
 * `resolveConfigCodec` rather than re-deriving the `?? / ||` pairing inline,
 * so the operator choice lives in exactly one place.
 */
import type { CouchSyncSettings } from "../settings.ts";

export interface ConfigCodecPolicy {
    encryption: boolean;
    /** Effective passphrase. Empty string means "no passphrase" only when
     *  both config and vault passphrases are blank; otherwise it is the
     *  config override (if set) or the inherited vault passphrase. */
    passphrase: string;
    compression: boolean;
}

/** Resolve the effective config-DB codec from settings, applying the
 *  field-specific inherit rules in one place. */
export function resolveConfigCodec(s: CouchSyncSettings): ConfigCodecPolicy {
    return {
        encryption: s.configEncryptionEnabled ?? s.encryptionEnabled,
        // "" = inherit the vault passphrase (|| not ?? — see module doc).
        passphrase: s.configEncryptionPassphrase || s.encryptionPassphrase,
        compression: s.configCompressionEnabled ?? s.compressionEnabled,
    };
}

/** True when the config codec is currently inheriting a field from vault
 *  (the override is unset). Drives UI affordances like the "Inheriting Vault
 *  Sync (…)" descriptions — a distinct axis from the resolved value. */
export function isInheritingConfigEncryption(s: CouchSyncSettings): boolean {
    return s.configEncryptionEnabled === undefined;
}

export function isInheritingConfigCompression(s: CouchSyncSettings): boolean {
    return s.configCompressionEnabled === undefined;
}
