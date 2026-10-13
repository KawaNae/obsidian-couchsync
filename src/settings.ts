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
 * Clone, before the destructive `localDb.destroy()`, so that setup is
 * atomic. It is persisted pessimistically so that a setup which fails
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

/**
 * The part of a config binding that must outlive its local store. Keyed by
 * `configBindingKey`.
 *
 * Whether the device is attached, the codec it syncs with and the root it
 * joined live INSIDE the binding's local store (`ConfigAttachment`), so
 * deleting the store detaches the device. What stays here is what deleting
 * the store must not reset: the trust floor, an interrupted Create, and the
 * passphrase of the DB.
 */
export interface ConfigBindingRecord {
    /** Locally-anchored cipherVersion floor for this DB (TOFU). Set by
     *  Create / Join, ratcheted up by later unlocks, never lowered by a
     *  sync op. `undefined` for a plaintext DB. */
    cipherFloor?: number;
    /** This device's Create is in progress; true between the destructive
     *  wipe and the commit, so an interrupted Create is detectable. */
    settingUp: boolean;
    /** The passphrase that unlocks this DB's encrypted root: the one Create
     *  encrypted with, or the one Join unlocked with. Written only by those
     *  two, and every op on this DB unlocks with it alone. Kept per binding
     *  so DBs with different passphrases do not overwrite each other's.
     *  `undefined` for a plaintext DB. */
    passphrase?: string;
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

    /** v0.26: config-side codec overrides. Each field is
     *  optional — `undefined` means "inherit from the vault setting
     *  above". Concrete values let advanced users decouple config
     *  crypto/compression from vault, e.g. share a plaintext config
     *  DB across pools while keeping notes encrypted. Set from Step 1
     *  of the Config Sync tab; the codec paths honour them because the
     *  config DB has its own cryptoProvider, independent of the vault's. */
    configEncryptionEnabled?: boolean;
    /** The passphrase the NEXT Create encrypts the config DB with; empty
     *  inherits the vault passphrase. Also one of the values Join tries.
     *  The passphrase of a DB this device joined is on its binding entry
     *  (`ConfigBindingRecord.passphrase`), not here. */
    configEncryptionPassphrase?: string;
    configCompressionEnabled?: boolean;

    /** Locally-anchored cipherVersion policy floor (TOFU — trust on first
     *  unlock). Recorded the first time this device trust-unlocks the vault
     *  (Init/Clone/first-unlock) and ratcheted up on re-init; it never
     *  decreases. The decode layer refuses any file/config doc that is not a
     *  sealed `encBody` once the floor is >= 3, and the encryption-agreement
     *  check refuses a remote `vault:meta` whose cipherVersion is below it.
     *  Sourced from client-local state, never re-read live from the
     *  server-writable meta, so a curious server cannot lower the floor by
     *  rewriting meta (closes the cipherVersion-3 downgrade hole). `undefined` on a
     *  not-yet-observed or plaintext vault — permissive (legacy dual-read). */
    vaultCipherVersion?: number;
    /** Per-config-DB cipher floor and Create-interrupted flag, keyed by
     *  `configBindingKey` (normalised server URI + config DB name).
     *  Replaces the former global `configCipherVersion` / `configSettingUp`,
     *  which ignored the DB name and leaked from one config DB to another.
     *  Attachment itself is recorded in the binding's local store. */
    configBindings: Record<string, ConfigBindingRecord>;

    // Internal
    /** Server reachable + auth verified (CouchDB tab Test+Apply). */
    serverTested: boolean;
    connectionState: ConnectionState;
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

    serverTested: false,
    connectionState: "editing",
    configBindings: {},
    deviceId: "",
    previousDeviceIds: [],
};
