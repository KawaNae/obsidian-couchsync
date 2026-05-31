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

/**
 * Structural fingerprint of a resolved config codec. Captures only the
 * SHAPE of the codec (encryption on/off, compression on/off, passphrase
 * blank/non-blank) — never the passphrase value, which must not be widened
 * beyond settings. A passphrase value change (A → B) at the same shape is
 * caught separately by the onload early-derive keyCheck, not here.
 *
 * Used to detect when the live codec policy has drifted from what the last
 * Config Init applied to the remote (see `isConfigCodecDirty`).
 */
export function codecFingerprint(p: ConfigCodecPolicy): string {
    return `${p.encryption ? 1 : 0}:${p.compression ? 1 : 0}:${p.passphrase ? 1 : 0}`;
}

/**
 * True when the resolved config codec no longer matches the fingerprint the
 * last successful Config Init recorded — i.e. the user changed an encryption /
 * passphrase / compression knob but has not re-run Init & Push, so a live
 * push/pull would encode/decode against a codec the remote doesn't share.
 *
 * `configCodecApplied === undefined` (never Init'd, or a pre-v0.27.2 install)
 * is NOT dirty: no recorded baseline to drift from, so existing users keep the
 * prior permissive behaviour.
 */
export function isConfigCodecDirty(s: CouchSyncSettings): boolean {
    if (s.configCodecApplied === undefined) return false;
    return s.configCodecApplied !== codecFingerprint(resolveConfigCodec(s));
}
