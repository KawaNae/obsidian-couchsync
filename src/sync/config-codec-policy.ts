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
 *     would fail (this was a real on-device bug — the `?? → ||` fix). The
 *     inheritance applies to the input of Create / Join only; after joining,
 *     ops use the explicit value those saved (`joinedConfigPassphrase`).
 *
 * Every call site that needs the effective config codec MUST go through
 * `resolveConfigCodec` rather than re-deriving the `?? / ||` pairing inline,
 * so the operator choice lives in exactly one place.
 */
import type { CouchSyncSettings } from "../settings.ts";

export interface ConfigCodecPolicy {
    encryption: boolean;
    /** Passphrase for the NEXT Create or Join: the config override if set,
     *  else the inherited vault passphrase. Empty string means "none" only
     *  when both are blank. Never used after joining — see
     *  `joinedConfigPassphrase`. */
    passphrase: string;
    compression: boolean;
}

/** Resolve the Step 1 config-DB codec from settings, applying the
 *  field-specific inherit rules in one place.
 *
 *  Everything here is the input of the NEXT Create or Join only:
 *  `encryption` / `compression` are what Create builds the DB with, and
 *  `passphrase` is what Create encrypts with and Join unlocks with (the
 *  vault passphrase is inherited HERE, and only here). Push and Pull use the
 *  codec recorded when this device created or joined the DB
 *  (`ConfigAttachment.codec`) and the passphrase saved at that moment
 *  (`joinedConfigPassphrase`), so neither a Step 1 change nor a vault-side
 *  change (E2E off, a new vault passphrase) stops config sync. */
export function resolveConfigCodec(s: CouchSyncSettings): ConfigCodecPolicy {
    return {
        encryption: s.configEncryptionEnabled ?? s.encryptionEnabled,
        // "" = inherit the vault passphrase (|| not ?? — see module doc).
        passphrase: s.configEncryptionPassphrase || s.encryptionPassphrase,
        compression: s.configCompressionEnabled ?? s.compressionEnabled,
    };
}

/** The passphrase every op on a JOINED encrypted config DB unlocks with:
 *  the explicit config value only, never the vault's. Create and Join store
 *  the passphrase they actually used here when they succeed, so the
 *  inheritance is resolved once, at joining time. "" = none (the op stops
 *  as `passphrase-missing`). */
export function joinedConfigPassphrase(s: CouchSyncSettings): string {
    return s.configEncryptionPassphrase ?? "";
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
