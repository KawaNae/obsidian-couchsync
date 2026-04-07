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
    /** Bumped on schema-changing releases. v0.8.0 = 2 (all-binary chunker). */
    syncSchemaVersion: number;
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
    syncSchemaVersion: 0,
};
