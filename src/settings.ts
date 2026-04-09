export type ConnectionState = "editing" | "tested" | "setupDone" | "syncing";

export interface CouchSyncSettings {
    // Connection
    couchdbUri: string;
    couchdbUser: string;
    couchdbPassword: string;
    couchdbDbName: string;

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
    deviceId: string;
    /**
     * Fingerprint of the Obsidian installation this vault was last opened on.
     * Compared against `localStorage["couchsync.installMarker"]` at startup —
     * a mismatch means the vault (and its data.json) was copied to a new
     * install, so `deviceId` must be regenerated to preserve Vector Clock
     * uniqueness across peers. See main.ts onload for the check.
     */
    lastInstallMarker?: string;
}

export const DEFAULT_SETTINGS: CouchSyncSettings = {
    couchdbUri: "",
    couchdbUser: "",
    couchdbPassword: "",
    couchdbDbName: "obsidian",

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
};
