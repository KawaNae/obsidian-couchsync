/** Keep only the N most recent previous device IDs. */
export const MAX_PREVIOUS_DEVICE_IDS = 10;

export type ConnectionState = "editing" | "tested" | "setupDone" | "syncing";

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
    configSyncPaths: string[];

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

    // Internal
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
    configSyncPaths: [],

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
    deviceId: "",
    previousDeviceIds: [],
};
