import { buildPolicyFromLegacyPaths } from "./sync/config-policy/migrate.ts";
import { normalizeUnitDefaults } from "./sync/config-policy/policy.ts";

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

    // Infer serverTested from connectionState (pre-v0.30).
    // Any state beyond "editing" required a working server connection.
    if (data.serverTested === undefined) {
        data.serverTested = data.connectionState !== "editing";
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

    // v0.23: persistent log buffer settings. Defaults are picked up from
    // DEFAULT_SETTINGS, but explicit migration keeps the data file's
    // schema obvious on inspection.
    if (data.logRetentionDays === undefined) data.logRetentionDays = 7;
    if (data.logMaxStorageMB === undefined) data.logMaxStorageMB = 50;

    // v0.26.2: config-setup atomicity flag (#err-9). Default false is also
    // supplied by DEFAULT_SETTINGS; explicit migration keeps the schema obvious.
    if (data.configSettingUp === undefined) data.configSettingUp = false;

    // configSyncPaths (string[] receive-only allowlist) → configSyncPolicy
    // (meaning-unit policy, symmetric send/receive). Safe-side: plugin code
    // stops syncing (blockPluginCode forced true inside the builder). The host
    // shows a one-time notice (configSyncPolicyMigrated) after this runs.
    if (data.configSyncPolicy === undefined) {
        const legacy: string[] = Array.isArray(data.configSyncPaths)
            ? data.configSyncPaths
            : [];
        data.configSyncPolicy = buildPolicyFromLegacyPaths(legacy);
        data.configSyncPolicyMigrated = true;
        delete data.configSyncPaths;
    } else {
        // Forward-compat: backfill any unit added in a later build so an
        // older persisted policy still has a decision for it. Idempotent.
        data.configSyncPolicy.unitDefaults = normalizeUnitDefaults(
            data.configSyncPolicy.unitDefaults,
        );
        if (typeof data.configSyncPolicy.blockPluginCode !== "boolean") {
            data.configSyncPolicy.blockPluginCode = true;
        }
        if (data.configSyncPolicy.overrides === undefined) {
            data.configSyncPolicy.overrides = {};
        }
    }
}
