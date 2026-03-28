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
    enableHiddenSync: boolean;
    enablePluginSync: boolean;
    deviceName: string;
    hiddenSyncIgnore: string;

    // History
    historyRetentionDays: number;
    historyDebounceMs: number;
    historyMinIntervalMs: number;
    historyMaxStorageMB: number;

    // Maintenance
    showVerboseLog: boolean;

    // Internal
    isConfigured: boolean;
}

export const DEFAULT_SETTINGS: CouchSyncSettings = {
    couchdbUri: "",
    couchdbUser: "",
    couchdbPassword: "",
    couchdbDbName: "obsidian",

    syncFilter: "",
    syncIgnore: "",
    maxFileSizeMB: 50,
    enableHiddenSync: false,
    enablePluginSync: false,
    deviceName: "",
    hiddenSyncIgnore: "\\.git/",

    historyRetentionDays: 30,
    historyDebounceMs: 5000,
    historyMinIntervalMs: 60000,
    historyMaxStorageMB: 500,

    showVerboseLog: false,

    isConfigured: false,
};
