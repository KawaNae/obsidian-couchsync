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

    connectionState: "editing",
    deviceId: "",
    previousDeviceIds: [],
};
