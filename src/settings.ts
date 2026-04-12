export type ConnectionState = "editing" | "tested" | "setupDone" | "syncing";

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
    mobileStatusAlign: "left" | "right";
    mobileStatusBottom: number;
    mobileStatusOffset: number;

    // History
    historyExcludePatterns: string[];

    // Maintenance
    showVerboseLog: boolean;

    // Internal
    connectionState: ConnectionState;
    /** Human-readable device name used as the vclock key (e.g. "desktop", "iphone"). */
    deviceId: string;
    /** Old deviceIds this device has used (UUIDs from pre-v0.12, renamed names). */
    previousDeviceIds: string[];
    /**
     * Fingerprint of the Obsidian installation this vault was last opened on.
     * Compared against `localStorage["couchsync.installMarker"]` at startup.
     * Mismatch triggers a warning notice (advisory only — deviceId is not changed).
     */
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

    mobileStatusAlign: "left",
    mobileStatusBottom: 50,
    mobileStatusOffset: 8,

    historyExcludePatterns: [],

    showVerboseLog: false,

    connectionState: "editing",
    deviceId: "",
    previousDeviceIds: [],
};
