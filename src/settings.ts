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
    hiddenSyncMode: "off" | "push" | "pull" | "sync";
    pluginSyncMode: "off" | "push" | "pull" | "sync";
    deviceName: string;
    hiddenSyncIgnore: string;
    pluginSyncList: Record<string, boolean>;

    // History
    historyRetentionDays: number;
    historyDebounceMs: number;
    historyMinIntervalMs: number;
    historyMaxStorageMB: number;

    // Maintenance
    showVerboseLog: boolean;

    // Internal
    connectionTested: boolean;
    setupComplete: boolean;
    syncEnabled: boolean;
}

export const DEFAULT_SETTINGS: CouchSyncSettings = {
    couchdbUri: "",
    couchdbUser: "",
    couchdbPassword: "",
    couchdbDbName: "obsidian",

    syncFilter: "",
    syncIgnore: "",
    maxFileSizeMB: 50,
    hiddenSyncMode: "off",
    pluginSyncMode: "off",
    deviceName: "",
    hiddenSyncIgnore: "\\.git/",
    pluginSyncList: {},

    historyRetentionDays: 30,
    historyDebounceMs: 5000,
    historyMinIntervalMs: 60000,
    historyMaxStorageMB: 500,

    showVerboseLog: false,

    connectionTested: false,
    setupComplete: false,
    syncEnabled: false,
};
