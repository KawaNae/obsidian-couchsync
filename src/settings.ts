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

    // History
    historyRetentionDays: number;
    historyDebounceMs: number;
    historyMinIntervalMs: number;
    historyMaxStorageMB: number;

    // Mobile status position
    mobileStatusAlign: "left" | "right";
    mobileStatusBottom: number;
    mobileStatusOffset: number;

    // Maintenance
    showVerboseLog: boolean;

    // Internal
    connectionState: ConnectionState;
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

    historyRetentionDays: 30,
    historyDebounceMs: 5000,
    historyMinIntervalMs: 60000,
    historyMaxStorageMB: 500,

    mobileStatusAlign: "left",
    mobileStatusBottom: 50,
    mobileStatusOffset: 8,

    showVerboseLog: false,

    connectionState: "editing",
};
