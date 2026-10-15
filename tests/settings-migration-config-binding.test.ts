/**
 * Settings migration: the former GLOBAL config-sync state
 * (`configCodecApplied`, `configCipherVersion`, `configSettingUp`) and the
 * per-DB records of a pre-release binding build.
 *
 * The attachment (codec, joined root) now lives in the binding's local
 * store, which the migration cannot reach: a recorded codec or root is
 * dropped and the device Joins once. The cipher floor and the
 * Create-interrupted flag stay in settings, per binding.
 */
import { describe, it, expect } from "vitest";
import { migrateSettings } from "../src/settings-migration.ts";
import {
    configBindingKey,
    normalizeServerUri,
} from "../src/sync/config-binding-record.ts";

function legacy(extra: Record<string, unknown>): Record<string, any> {
    return {
        connectionState: "syncing",
        serverTested: true,
        couchdbUri: "https://couch.example.com:6984/",
        couchdbConfigDbName: "obsidian-config",
        configSyncPolicy: { unitDefaults: {}, blockPluginCode: true, overrides: {} },
        ...extra,
    };
}

const KEY = configBindingKey("https://couch.example.com:6984", "obsidian-config");

describe("migrateSettings — config bindings from the global values", () => {
    it("moves the floor into the current DB's entry, drops the codec, removes the globals", () => {
        const data = legacy({
            configCodecApplied: "1:1:1",
            configCipherVersion: 3,
            configSettingUp: false,
        });
        migrateSettings(data);
        // No codec: the attachment is the store's; the device Joins once.
        expect(data.configBindings).toEqual({ [KEY]: { cipherFloor: 3, settingUp: false } });
        expect("configCodecApplied" in data).toBe(false);
        expect("configCipherVersion" in data).toBe(false);
        expect("configSettingUp" in data).toBe(false);
    });

    it("carries an interrupted setup flag over to the entry", () => {
        const data = legacy({ configCodecApplied: "0:1:0", configSettingUp: true });
        migrateSettings(data);
        expect(data.configBindings).toEqual({ [KEY]: { settingUp: true } });
    });

    it("keeps the floor even when no codec was recorded (the device only pulled)", () => {
        const data = legacy({ configCipherVersion: 3, configSettingUp: false });
        migrateSettings(data);
        expect(data.configBindings).toEqual({ [KEY]: { cipherFloor: 3, settingUp: false } });
    });

    it("nothing worth keeping (plaintext, not mid-Create): no entry", () => {
        const data = legacy({ configCodecApplied: "0:1:0", configSettingUp: false });
        migrateSettings(data);
        expect(data.configBindings).toEqual({});
    });

    it("config sync disabled (no DB name): no entry", () => {
        const data = legacy({
            couchdbConfigDbName: "", configCodecApplied: "1:0:1", configCipherVersion: 3,
        });
        migrateSettings(data);
        expect(data.configBindings).toEqual({});
        expect("configCipherVersion" in data).toBe(false);
    });

    it("is idempotent", () => {
        const data = legacy({ configCodecApplied: "1:1:1", configCipherVersion: 3, configSettingUp: true });
        migrateSettings(data);
        const once = structuredClone(data);
        migrateSettings(data);
        expect(data).toEqual(once);
    });
});

describe("migrateSettings — entries written by a pre-release binding build", () => {
    it("drops codecFingerprint / metaFingerprint, keeps floor and setting-up, idempotently", () => {
        const data = legacy({
            configBindings: {
                "https://a|cfg": { codecFingerprint: "1:0:1", cipherFloor: 3, metaFingerprint: "sha256:x", settingUp: false },
                "https://a|cfg2": { codecFingerprint: "0:1", metaFingerprint: "sha256:y", settingUp: false },
                "https://a|cfg3": { codecFingerprint: "1:1", settingUp: true },
                "https://a|cfg4": { settingUp: true },
                "https://a|junk": null,
            },
        });
        migrateSettings(data);
        const expected = {
            "https://a|cfg": { cipherFloor: 3, settingUp: false },
            // Nothing left to keep: removed (it is Unattached either way).
            "https://a|cfg3": { settingUp: true },
            "https://a|cfg4": { settingUp: true },
        };
        expect(data.configBindings).toEqual(expected);
        migrateSettings(data);
        expect(data.configBindings).toEqual(expected);
    });

    it("global values next to an existing map merge into it: the higher floor wins", () => {
        const data = legacy({
            configBindings: { [KEY]: { cipherFloor: 4, settingUp: false } },
            configCodecApplied: "1:0",
            configCipherVersion: 2,
        });
        migrateSettings(data);
        expect(data.configBindings).toEqual({ [KEY]: { cipherFloor: 4, settingUp: false } });
        expect("configCodecApplied" in data).toBe(false);
        expect("configCipherVersion" in data).toBe(false);
    });
});

describe("migrateSettings — downgrade, then upgrade again (any starting state)", () => {
    it("a setup flag an older build set next to an existing map is kept, not dropped", () => {
        // New build wrote the map; the user went back to an older build,
        // whose Config Init died mid-way (global flag true); now upgraded.
        const data = legacy({
            configBindings: { [KEY]: { cipherFloor: 3, settingUp: false } },
            configSettingUp: true,
        });
        migrateSettings(data);
        expect(data.configBindings).toEqual({ [KEY]: { cipherFloor: 3, settingUp: true } });
        expect("configSettingUp" in data).toBe(false);
    });

    it("a higher floor from the older build is taken; an entry's flag survives a false global", () => {
        const data = legacy({
            configBindings: { [KEY]: { cipherFloor: 2, settingUp: true } },
            configCipherVersion: 3,
            configSettingUp: false,
        });
        migrateSettings(data);
        expect(data.configBindings).toEqual({ [KEY]: { cipherFloor: 3, settingUp: true } });
    });

    it("globals for a DB with no entry yet create one; other entries are untouched", () => {
        const other = configBindingKey("https://b.example.com", "x");
        const data = legacy({
            configBindings: { [other]: { settingUp: true } },
            configCipherVersion: 3,
        });
        migrateSettings(data);
        expect(data.configBindings).toEqual({
            [other]: { settingUp: true },
            [KEY]: { cipherFloor: 3, settingUp: false },
        });
    });

    it("the same result whether or not the map existed, and stable on re-run", () => {
        const a = legacy({ configCipherVersion: 3, configSettingUp: true });
        const b = legacy({ configBindings: {}, configCipherVersion: 3, configSettingUp: true });
        migrateSettings(a);
        migrateSettings(b);
        expect(a.configBindings).toEqual(b.configBindings);
        const once = structuredClone(a);
        migrateSettings(a);
        expect(a).toEqual(once);
    });
});

describe("configBindingKey normalisation", () => {
    it("treats spellings of the same server as one key", () => {
        const k = configBindingKey("https://couch.example.com:6984", "cfg");
        for (const uri of [
            "https://couch.example.com:6984/",
            "HTTPS://Couch.Example.com:6984//",
            "  https://couch.example.com:6984  ",
            "https://admin:secret@couch.example.com:6984/?x=1#frag",
        ]) {
            expect(configBindingKey(uri, "cfg")).toBe(k);
        }
        // A default port is dropped.
        expect(normalizeServerUri("http://h:80/")).toBe("http://h");
    });

    it("separates servers, paths and DB names", () => {
        const k = configBindingKey("https://a.example.com", "cfg");
        expect(configBindingKey("https://b.example.com", "cfg")).not.toBe(k);
        expect(configBindingKey("https://a.example.com/couch", "cfg")).not.toBe(k);
        expect(configBindingKey("https://a.example.com", "cfg2")).not.toBe(k);
        expect(configBindingKey("http://a.example.com", "cfg")).not.toBe(k);
    });

    it("falls back to trimming for an unparsable URI", () => {
        expect(normalizeServerUri(" not a url/ ")).toBe("not a url");
    });
});

describe("migrateSettings — a binding's passphrase", () => {
    it("keeps it, also on an entry that has nothing else", () => {
        const other = configBindingKey("https://couch.example.com:6984", "other-config");
        const data = legacy({
            configBindings: {
                [KEY]: { cipherFloor: 3, settingUp: false, passphrase: "p1" },
                [other]: { settingUp: false, passphrase: "p2" },
            },
        });
        migrateSettings(data);
        expect(data.configBindings).toEqual({
            [KEY]: { cipherFloor: 3, settingUp: false, passphrase: "p1" },
            [other]: { settingUp: false, passphrase: "p2" },
        });
    });

    it("keeps it when the global floor is merged into the same entry", () => {
        const data = legacy({
            configCipherVersion: 3,
            configBindings: { [KEY]: { settingUp: false, passphrase: "p1" } },
        });
        migrateSettings(data);
        expect(data.configBindings).toEqual({
            [KEY]: { cipherFloor: 3, settingUp: false, passphrase: "p1" },
        });
    });

    it("drops an empty or non-string passphrase", () => {
        const data = legacy({
            configBindings: { [KEY]: { cipherFloor: 3, settingUp: false, passphrase: "" } },
        });
        migrateSettings(data);
        expect(data.configBindings).toEqual({ [KEY]: { cipherFloor: 3, settingUp: false } });
    });
});
