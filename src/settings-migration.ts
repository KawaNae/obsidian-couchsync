/**
 * Migrate legacy settings shapes to the current schema.
 *
 * Called once during loadSettings() before merging with DEFAULT_SETTINGS.
 * Each migration is idempotent — safe to run on already-migrated data.
 */
export function migrateSettings(data: Record<string, any>): void {
    // Migrate old boolean flags to connectionState enum (pre-v0.11)
    if (data.connectionState === undefined) {
        if (data.syncEnabled) data.connectionState = "syncing";
        else if (data.setupComplete) data.connectionState = "setupDone";
        else if (data.connectionTested) data.connectionState = "tested";
        else data.connectionState = "editing";
        delete data.connectionTested;
        delete data.setupComplete;
        delete data.syncEnabled;
    }

    // Ensure previousDeviceIds exists (pre-v0.12)
    if (!data.previousDeviceIds) {
        data.previousDeviceIds = [];
    }

    // Migrate flat mobileStatus* fields to nested object (pre-v0.14)
    if (data.mobileStatusAlign !== undefined || data.mobileStatusBottom !== undefined || data.mobileStatusOffset !== undefined) {
        data.mobileStatus = {
            align: data.mobileStatusAlign ?? "left",
            bottom: data.mobileStatusBottom ?? 50,
            offset: data.mobileStatusOffset ?? 8,
        };
        delete data.mobileStatusAlign;
        delete data.mobileStatusBottom;
        delete data.mobileStatusOffset;
    }
}
