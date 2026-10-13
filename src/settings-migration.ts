import { buildPolicyFromLegacyPaths } from "./sync/config-policy/migrate.ts";
import { normalizeUnitDefaults } from "./sync/config-policy/policy.ts";
import Dexie from "dexie";
import { configBindingKey } from "./sync/config-binding-record.ts";
import type { ConfigBindingRecord } from "./settings.ts";

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

    // Config binding. What a device recorded about its config DB used to be
    // GLOBAL (`configCodecApplied` / `configCipherVersion` /
    // `configSettingUp`) and ignored which DB it belonged to. Now:
    //   - attachment (codec, joined root) lives in the binding's local
    //     store, which settings cannot reach — a recorded codec is dropped,
    //     and the device is Unattached until it Joins once;
    //   - the cipher floor, the Create-interrupted flag and the DB's
    //     passphrase stay in settings, per binding
    //     (`configBindings[configBindingKey(server, db)]`).
    //
    // Same result from every starting state (idempotent, and safe after a
    // downgrade + upgrade, when an older build wrote the globals again next
    // to an existing map):
    //   1. normalise the map (or start one);
    //   2. MERGE any global values into the entry of the config DB applied
    //      now — the floor takes the higher value (a floor is never lowered
    //      by a migration), the setup flag is kept if either side has it
    //      (an interrupted Create must not be forgotten);
    //   3. remove the globals.
    // Entries written by a pre-release build of the binding also carried
    // the attachment (`codecFingerprint`, `metaFingerprint`); those move to
    // the store and cannot be carried over, so they are dropped. An entry
    // left with nothing to keep is removed.
    const bindings: Record<string, ConfigBindingRecord> = {};
    if (data.configBindings && typeof data.configBindings === "object") {
        for (const [key, rec] of Object.entries(data.configBindings as Record<string, any>)) {
            if (!rec || typeof rec !== "object") continue;
            const cipherFloor = typeof rec.cipherFloor === "number" ? rec.cipherFloor : undefined;
            const settingUp = rec.settingUp === true;
            const passphrase = typeof rec.passphrase === "string" && rec.passphrase !== ""
                ? rec.passphrase : undefined;
            if (cipherFloor === undefined && !settingUp && passphrase === undefined) continue;
            bindings[key] = {
                ...(cipherFloor !== undefined ? { cipherFloor } : {}),
                settingUp,
                ...(passphrase !== undefined ? { passphrase } : {}),
            };
        }
    }
    const legacyFloor = typeof data.configCipherVersion === "number"
        ? data.configCipherVersion : undefined;
    const legacySettingUp = data.configSettingUp === true;
    const appliedDb = data.couchdbConfigDbName;
    if ((legacyFloor !== undefined || legacySettingUp)
        && typeof appliedDb === "string" && appliedDb !== "") {
        const key = configBindingKey(String(data.couchdbUri ?? ""), appliedDb);
        const prev = bindings[key];
        const floors = [prev?.cipherFloor, legacyFloor].filter((v): v is number => v !== undefined);
        bindings[key] = {
            ...(floors.length > 0 ? { cipherFloor: Math.max(...floors) } : {}),
            settingUp: (prev?.settingUp ?? false) || legacySettingUp,
            ...(prev?.passphrase !== undefined ? { passphrase: prev.passphrase } : {}),
        };
    }
    data.configBindings = bindings;
    delete data.configCodecApplied;
    delete data.configCipherVersion;
    delete data.configSettingUp;

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

// ── Legacy local config store ──────────────────────────

/**
 * Name of the local config store the layout before config bindings used
 * for the config DB applied now: `couchsync-<vault>-config-<db>` (no hash
 * suffix). Null when no config DB is applied.
 *
 * Deliberately ONE exact name derived from the settings, never a pattern
 * over the device's IndexedDB names: a pattern cannot tell a legacy config
 * store from another vault's own store (a vault named `<vault>-config-<x>`
 * has its vault store at `couchsync-<vault>-config-<x>`). Stores of config
 * DB names used earlier are left alone: a store of another DB name may
 * still be the one a later Apply switches back to, and nothing here can tell
 * an abandoned store from one that is merely not applied now.
 */
export function legacyConfigStoreName(vaultName: string, configDbName: string): string | null {
    if (!configDbName) return null;
    return `couchsync-${vaultName}-config-${configDbName}`;
}

/**
 * Delete the legacy local config store of the applied config DB (see
 * `legacyConfigStoreName`). Its contents can never be used again — stores
 * are now named per (server, DB), and the old one holds no attachment —
 * and every device Joins once after this update anyway.
 *
 * Runs on every plugin load, after `migrateSettings` (the settings side of
 * the same migration) and before the config binding opens. Deleting a name
 * that does not exist is a no-op success (IndexedDB `deleteDatabase`, and
 * `Dexie.delete` over it), so no enumeration is needed and it is
 * idempotent; it also removes a legacy store an older build re-created
 * after a downgrade. Resolves with the name it deleted (or found absent),
 * or null when no config DB is applied.
 */
export async function deleteLegacyConfigStore(
    vaultName: string,
    configDbName: string,
    deleteDb: (name: string) => Promise<void> = (name) => Dexie.delete(name),
): Promise<string | null> {
    const name = legacyConfigStoreName(vaultName, configDbName);
    if (name === null) return null;
    await deleteDb(name);
    return name;
}
