import { describe, it, expect } from "vitest";
import { migrateSettings } from "../src/settings-migration.ts";
import { buildPolicyFromLegacyPaths } from "../src/sync/config-policy/migrate.ts";

describe("buildPolicyFromLegacyPaths", () => {
    it("empty list → safe default (portable on, code off)", () => {
        const p = buildPolicyFromLegacyPaths([]);
        expect(p.blockPluginCode).toBe(true);
        expect(p.unitDefaults["app-behavior"]).toBe(true);
        expect(p.unitDefaults["community-settings"]).toBe(true);
        expect(p.unitDefaults["install-state"]).toBe(false);
    });

    it('".obsidian/" (everything) → safe default, never code', () => {
        const p = buildPolicyFromLegacyPaths([".obsidian/"]);
        expect(p.blockPluginCode).toBe(true);
        expect(p.unitDefaults["install-state"]).toBe(false);
        expect(p.unitDefaults["theme-css"]).toBe(true);
    });

    it("selective list → only the implied portable units on", () => {
        // appearance.json now belongs to the merged "app-behavior" unit
        // (app/appearance/hotkeys), so selecting it turns that unit on and
        // leaves the unrelated units off.
        const p = buildPolicyFromLegacyPaths([".obsidian/appearance.json"]);
        expect(p.unitDefaults["app-behavior"]).toBe(true);
        expect(p.unitDefaults["community-settings"]).toBe(false);
        expect(p.unitDefaults["theme-css"]).toBe(false);
        expect(p.unitDefaults["install-state"]).toBe(false);
        expect(p.blockPluginCode).toBe(true);
    });

    it("plugin folder prefix → community-settings on, install-state still off", () => {
        const p = buildPolicyFromLegacyPaths([".obsidian/plugins/foo/"]);
        expect(p.unitDefaults["community-settings"]).toBe(true);
        expect(p.unitDefaults["install-state"]).toBe(false);
    });
});

describe("migrateSettings: configSyncPaths → configSyncPolicy", () => {
    it("converts legacy array, sets migrated flag, removes old field", () => {
        const data: Record<string, any> = { configSyncPaths: [".obsidian/"] };
        migrateSettings(data);
        expect(data.configSyncPaths).toBeUndefined();
        expect(data.configSyncPolicy).toBeDefined();
        expect(data.configSyncPolicy.blockPluginCode).toBe(true);
        expect(data.configSyncPolicyMigrated).toBe(true);
    });

    it("is idempotent — second run keeps the policy and backfills units", () => {
        const data: Record<string, any> = { configSyncPaths: [".obsidian/"] };
        migrateSettings(data);
        const first = JSON.parse(JSON.stringify(data.configSyncPolicy));
        // simulate host clearing the notice flag
        data.configSyncPolicyMigrated = false;
        migrateSettings(data);
        expect(data.configSyncPolicy.unitDefaults).toEqual(first.unitDefaults);
        expect(data.configSyncPolicyMigrated).toBe(false);
    });

    it("backfills a missing unit in an existing policy", () => {
        const data: Record<string, any> = {
            configSyncPolicy: {
                schemaVersion: 1,
                unitDefaults: { "app-behavior": false }, // partial
                overrides: {},
                blockPluginCode: true,
            },
        };
        migrateSettings(data);
        expect(data.configSyncPolicy.unitDefaults["app-behavior"]).toBe(false); // preserved
        expect(data.configSyncPolicy.unitDefaults["theme-css"]).toBe(true); // backfilled
    });
});
