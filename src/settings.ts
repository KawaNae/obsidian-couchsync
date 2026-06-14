import type { ConfigSyncPolicy } from "./sync/config-policy/policy.ts";
import { defaultConfigSyncPolicy } from "./sync/config-policy/policy.ts";

/** Keep only the N most recent previous device IDs. */
export const MAX_PREVIOUS_DEVICE_IDS = 10;

/**
 * Vault-sync setup state machine.
 *
 *   editing → tested → setupDone → syncing
 *
 * `settingUp` is a non-syncable transient entered at the START of Init/
 * Clone, before the destructive `localDb.destroy()` (Invariant C — setup
 * atomicity). It is persisted pessimistically so that a setup which fails
 * (or whose process dies) mid-flight can never leave the prior
 * `setupDone`/`syncing` state behind — which would let the user start
 * sync against a half-built local DB. Only a confirmed-successful setup
 * advances to `setupDone`; a failure stays in `settingUp` (Init/Clone
 * remain enabled to retry, Live Sync stays disabled).
 */
export type ConnectionState =
    | "editing" | "tested" | "settingUp" | "setupDone" | "syncing";

export interface MobileStatusPosition {
    align: "left" | "right";
    bottom: number;
    offset: number;
}

export interface CouchSyncSettings {
    // Connection (shared between vault and config sync)
    couchdbUri: string;
    couchdbUser: string;
    couchdbPassword: string;
    /** Vault database name — holds FileDoc + ChunkDoc */
    couchdbDbName: string;
    /**
     * Config database name (v0.11.0+) — holds ConfigDoc only.
     *
     * Empty string disables config sync entirely. Distinct values across
     * device pools (e.g. `obsidian-dev-config-mobile` vs `-desktop`) let
     * a vault be shared while `.obsidian/` configurations stay independent.
     * Lives on the same CouchDB server as the vault DB — credentials are
     * shared with vault sync.
     */
    couchdbConfigDbName: string;

    // Files
    syncFilter: string;
    syncIgnore: string;
    maxFileSizeMB: number;
    /** Config-sync filter: a single meaning-unit policy enforced symmetrically
     *  on send (scan) and receive (write). Replaces the legacy
     *  `configSyncPaths: string[]` receive-only allowlist (migrated in
     *  settings-migration). Device-local — never synced. */
    configSyncPolicy: ConfigSyncPolicy;
    /** Set true by the legacy→policy migration; the host shows a one-time
     *  notice on next load and clears it. */
    configSyncPolicyMigrated?: boolean;

    // Sync timing
    syncDebounceMs: number;
    syncMinIntervalMs: number;

    // History
    historyRetentionDays: number;
    historyDebounceMs: number;
    historyMinIntervalMs: number;
    historyMaxStorageMB: number;

    // Mobile status position
    mobileStatus: MobileStatusPosition;

    // History
    historyExcludePatterns: string[];

    // Maintenance
    verboseNotice: boolean;

    // Persistent log buffer (LogManager)
    /** Days of log history kept in IndexedDB. Required; must be >= 1. */
    logRetentionDays: number;
    /** Maximum log storage budget in MB. `0` disables the size cap
     *  (only the day-based retention applies). */
    logMaxStorageMB: number;

    // E2E Encryption (vault DB)
    encryptionEnabled: boolean;
    encryptionPassphrase: string;
    /** v2: enable gzip compression of attachment bodies. Outermost
     *  decorator in the client stack; transparent to the sync layer.
     *  Recorded in `vault:meta` at Init time and read by Clone — local
     *  toggling after the vault is initialised is allowed but the new
     *  value only takes effect for *future* chunk pushes (existing
     *  chunks keep whatever encoding they were stored with). */
    compressionEnabled: boolean;

    /** Phase 2 (v0.26): config-side codec overrides. Each field is
     *  optional — `undefined` means "inherit from the vault setting
     *  above". Concrete values let advanced users decouple config
     *  crypto/compression from vault, e.g. share a plaintext config
     *  DB across pools while keeping notes encrypted. The settings UI
     *  surfaces these in a Phase 3 follow-up; the internal code paths
     *  already honour them today (invariant 18: cryptoProvider is
     *  per-DB). */
    configEncryptionEnabled?: boolean;
    configEncryptionPassphrase?: string;
    configCompressionEnabled?: boolean;

    /** Structural fingerprint of the config codec that the last successful
     *  Config Init actually applied to the remote (see
     *  `codecFingerprint` / `isConfigCodecDirty`). When the live resolved
     *  codec no longer matches this, the config DB on the server was built
     *  with a different codec and live push/pull/write are refused until a
     *  fresh Config Init re-applies the new policy — symmetric with vault
     *  sync, where a codec change demands a destructive re-init (#config-codec).
     *  `undefined` = never Init'd (or a pre-v0.27.2 install): permissive, no
     *  baseline to drift from. */
    configCodecApplied?: string;

    /** Locally-anchored cipherVersion policy floor (TOFU — trust on first
     *  unlock). Recorded the first time this device trust-unlocks the vault
     *  (Init/Clone/first-unlock) and ratcheted up on re-init; it never
     *  decreases. The decode layer refuses any file/config doc that is not a
     *  sealed `encBody` once the floor is >= 3, and the encryption-agreement
     *  check refuses a remote `vault:meta` whose cipherVersion is below it.
     *  Sourced from client-local state, never re-read live from the
     *  server-writable meta, so a curious server cannot lower the floor by
     *  rewriting meta (closes the v3 downgrade hole, #1/#3). `undefined` on a
     *  not-yet-observed or plaintext vault — permissive (legacy dual-read). */
    vaultCipherVersion?: number;
    /** Config-DB equivalent of `vaultCipherVersion` (invariant 18: each DB is
     *  its own crypto root). */
    configCipherVersion?: number;

    // Internal
    connectionState: ConnectionState;
    /** Config-sync equivalent of `connectionState`'s `settingUp` transient
     *  (Invariant C). Set true before ConfigSetupService destroys the local
     *  config DB and cleared only on a fully-successful init; if init dies
     *  mid-flight it stays true, so config push/pull/write refuse to run
     *  against a half-built config DB until a fresh Config Init completes
     *  (#err-9). */
    configSettingUp: boolean;
    /** Human-readable device name used as the vclock key (e.g. "desktop", "iphone"). */
    deviceId: string;
    /** Old deviceIds this device has used (UUIDs from pre-v0.12, renamed names).
     *  Capped at MAX_PREVIOUS_DEVICE_IDS to avoid unbounded growth. */
    previousDeviceIds: string[];
    /** Fingerprint of the Obsidian installation this vault was last opened on.
     *  Compared at startup against `localStorage["couchsync.installMarker"]`;
     *  mismatch triggers a warning notice (advisory only). */
    lastInstallMarker?: string;
}

export const DEFAULT_SETTINGS: CouchSyncSettings = {
    couchdbUri: "",
    couchdbUser: "",
    couchdbPassword: "",
    couchdbDbName: "obsidian",
    couchdbConfigDbName: "",

    syncFilter: "",
    syncIgnore: "",
    maxFileSizeMB: 50,
    configSyncPolicy: defaultConfigSyncPolicy(),

    syncDebounceMs: 2000,
    syncMinIntervalMs: 0,

    historyRetentionDays: 30,
    historyDebounceMs: 5000,
    historyMinIntervalMs: 60000,
    historyMaxStorageMB: 500,

    mobileStatus: { align: "left", bottom: 50, offset: 8 },

    historyExcludePatterns: [],

    verboseNotice: false,

    logRetentionDays: 7,
    logMaxStorageMB: 50,

    encryptionEnabled: false,
    encryptionPassphrase: "",
    compressionEnabled: true,

    connectionState: "editing",
    configSettingUp: false,
    deviceId: "",
    previousDeviceIds: [],
};
