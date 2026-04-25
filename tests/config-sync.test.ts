/**
 * Tests for ConfigSync — focused on network-free paths (scan, write,
 * filtering, configuration gates). Remote push/pull/init are not
 * covered here because ConfigSync instantiates its CouchClient via a
 * module-level factory that can't be injected without vi.mock, which
 * this codebase avoids.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { ConfigSync } from "../src/sync/config-sync.ts";
import { ConfigLocalDB } from "../src/db/config-local-db.ts";
import { AuthGate } from "../src/db/sync/auth-gate.ts";
import { ALWAYS_VISIBLE } from "../src/db/visibility-gate.ts";
import { NoopReconnectBridge } from "../src/sync/reconnect-bridge.ts";
import { FakeVaultIO } from "./helpers/fake-vault-io.ts";
import { FakeModalPresenter } from "./helpers/fake-modal-presenter.ts";
import { makeSettings } from "./helpers/settings-factory.ts";
import { makeConfigId } from "../src/types/doc-id.ts";
import { arrayBufferToBase64 } from "../src/db/chunker.ts";
import type { ConfigDoc, CouchSyncDoc } from "../src/types.ts";

let counter = 0;
function uniqueName() { return `config-sync-test-${Date.now()}-${counter++}`; }

/** Encode a UTF-8 string to base64 for fixture ConfigDocs. */
function b64(s: string): string {
    return arrayBufferToBase64(new TextEncoder().encode(s).buffer);
}

describe("ConfigSync", () => {
    let vault: FakeVaultIO;
    let modal: FakeModalPresenter;
    let db: ConfigLocalDB;
    let auth: AuthGate;
    let settings: ReturnType<typeof makeSettings>;
    let cs: ConfigSync;

    beforeEach(() => {
        vault = new FakeVaultIO();
        modal = new FakeModalPresenter();
        db = new ConfigLocalDB(uniqueName());
        db.open();
        auth = new AuthGate();
        settings = makeSettings({ deviceId: "dev-A" });
        cs = new ConfigSync(vault, modal, db, auth, ALWAYS_VISIBLE, NoopReconnectBridge, () => settings);
    });

    afterEach(async () => {
        await db.destroy().catch(() => {});
    });

    // ── Configuration gates ──────────────────────────────

    describe("configuration gates", () => {
        it("isConfigured: false when couchdbConfigDbName empty", () => {
            expect(cs.isConfigured()).toBe(false);
        });

        it("isConfigured: true when dbName + configDb present", () => {
            settings.couchdbUri = "http://localhost:5984";
            settings.couchdbConfigDbName = "vault-config";
            expect(cs.isConfigured()).toBe(true);
        });

        it("isConfigured: false when configDb is null", () => {
            const nullDb = new ConfigSync(vault, modal, null, auth, ALWAYS_VISIBLE, NoopReconnectBridge, () => settings);
            settings.couchdbConfigDbName = "vault-config";
            expect(nullDb.isConfigured()).toBe(false);
        });

        it("scan throws when configDb is null", async () => {
            const nullDb = new ConfigSync(vault, modal, null, auth, ALWAYS_VISIBLE, NoopReconnectBridge, () => settings);
            await expect(nullDb.scan()).rejects.toThrow(/no local config DB/);
        });

        it("push throws when couchdbConfigDbName empty but local has docs", async () => {
            vault.addFile(".obsidian/app.json", "{}");
            await expect(cs.push()).rejects.toThrow(/not configured/);
        });
    });

    // ── scan ────────────────────────────────────────────

    describe("scan", () => {
        it("stores config files as base64 docs with incremented vclock", async () => {
            vault.addFile(".obsidian/app.json", `{"theme":"dark"}`);

            const count = await cs.scan();

            expect(count).toBe(1);
            const doc = await db.get(makeConfigId(".obsidian/app.json"));
            expect(doc).not.toBeNull();
            expect(doc!.type).toBe("config");
            expect(doc!.vclock).toEqual({ "dev-A": 1 });
        });

        it("increments vclock on re-scan with changed content", async () => {
            vault.addFile(".obsidian/app.json", "v1");
            await cs.scan();

            vault.addFile(".obsidian/app.json", "v2");
            await cs.scan();

            const doc = await db.get(makeConfigId(".obsidian/app.json"));
            expect(doc!.vclock["dev-A"]).toBe(2);
        });

        it("skips workspace.json (SKIP_FILES)", async () => {
            vault.addFile(".obsidian/workspace.json", "layout");

            const count = await cs.scan();

            expect(count).toBe(0);
            expect(await db.get(makeConfigId(".obsidian/workspace.json"))).toBeNull();
        });

        it("skips workspace-mobile.json (SKIP_FILES)", async () => {
            vault.addFile(".obsidian/workspace-mobile.json", "layout");
            const count = await cs.scan();
            expect(count).toBe(0);
        });

        it("skips own plugin data.json (SKIP_PATHS)", async () => {
            vault.addFile(".obsidian/plugins/obsidian-couchsync/data.json", "{}");
            const count = await cs.scan();
            expect(count).toBe(0);
            expect(await db.get(makeConfigId(".obsidian/plugins/obsidian-couchsync/data.json"))).toBeNull();
        });

        it("skips files exceeding MAX_CONFIG_SIZE (5MB)", async () => {
            const big = "x".repeat(6 * 1024 * 1024);
            vault.addFile(".obsidian/big.json", big);
            const count = await cs.scan();
            expect(count).toBe(0);
        });

        it("skips nested .git and node_modules dirs (SKIP_DIRS)", async () => {
            vault.addFile(".obsidian/.git/HEAD", "ref: refs/heads/main");
            vault.addFile(".obsidian/node_modules/pkg/file.json", "{}");
            vault.addFile(".obsidian/app.json", "{}");

            const count = await cs.scan();

            // Only app.json should be picked up
            expect(count).toBe(1);
            expect(await db.get(makeConfigId(".obsidian/.git/HEAD"))).toBeNull();
            expect(await db.get(makeConfigId(".obsidian/node_modules/pkg/file.json"))).toBeNull();
        });

        it("invokes onProgress for each scanned file", async () => {
            vault.addFile(".obsidian/app.json", "{}");
            vault.addFile(".obsidian/hotkeys.json", "{}");

            const calls: Array<{ path: string; i: number; total: number }> = [];
            await cs.scan((path, i, total) => calls.push({ path, i, total }));

            expect(calls.length).toBe(2);
            expect(calls[0].total).toBe(2);
        });

        it("recursively lists subdirectories", async () => {
            vault.addFile(".obsidian/plugins/foo/main.js", "code");
            vault.addFile(".obsidian/themes/bar/theme.css", "css");

            await cs.scan();

            expect(await db.get(makeConfigId(".obsidian/plugins/foo/main.js"))).not.toBeNull();
            expect(await db.get(makeConfigId(".obsidian/themes/bar/theme.css"))).not.toBeNull();
        });
    });

    // ── write ───────────────────────────────────────────

    describe("write", () => {
        async function seedConfigDoc(path: string, content: string): Promise<void> {
            const doc: ConfigDoc = {
                _id: makeConfigId(path),
                type: "config",
                data: b64(content),
                mtime: 1000,
                size: content.length,
                vclock: { "dev-A": 1 },
            };
            await db.runWriteTx({ docs: [{ doc: doc as unknown as CouchSyncDoc }] });
        }

        it("returns 0 when configSyncPaths is empty", async () => {
            settings.configSyncPaths = [];
            await seedConfigDoc(".obsidian/app.json", "{}");

            const count = await cs.write();

            expect(count).toBe(0);
            expect(vault.files.has(".obsidian/app.json")).toBe(false);
        });

        it("writes single-path entry to vault", async () => {
            settings.configSyncPaths = [".obsidian/app.json"];
            await seedConfigDoc(".obsidian/app.json", `{"theme":"dark"}`);

            const count = await cs.write();

            expect(count).toBe(1);
            expect(vault.readText(".obsidian/app.json")).toBe(`{"theme":"dark"}`);
        });

        it("writes all docs under a folder prefix (path ends with /)", async () => {
            settings.configSyncPaths = [".obsidian/plugins/foo/"];
            await seedConfigDoc(".obsidian/plugins/foo/main.js", "code-a");
            await seedConfigDoc(".obsidian/plugins/foo/styles.css", "css-b");
            await seedConfigDoc(".obsidian/plugins/bar/main.js", "code-c");

            const count = await cs.write();

            expect(count).toBe(2);
            expect(vault.readText(".obsidian/plugins/foo/main.js")).toBe("code-a");
            expect(vault.readText(".obsidian/plugins/foo/styles.css")).toBe("css-b");
            expect(vault.files.has(".obsidian/plugins/bar/main.js")).toBe(false);
        });

        it("skips own plugin data.json (SKIP_PATHS)", async () => {
            settings.configSyncPaths = [".obsidian/plugins/obsidian-couchsync/"];
            await seedConfigDoc(".obsidian/plugins/obsidian-couchsync/data.json", "{}");
            await seedConfigDoc(".obsidian/plugins/obsidian-couchsync/main.js", "code");

            const count = await cs.write();

            // data.json filtered, main.js written
            expect(count).toBe(1);
            expect(vault.files.has(".obsidian/plugins/obsidian-couchsync/data.json")).toBe(false);
            expect(vault.files.has(".obsidian/plugins/obsidian-couchsync/main.js")).toBe(true);
        });

        it("overwrites existing file", async () => {
            settings.configSyncPaths = [".obsidian/app.json"];
            vault.addFile(".obsidian/app.json", "old");
            await seedConfigDoc(".obsidian/app.json", "new");

            await cs.write();

            expect(vault.readText(".obsidian/app.json")).toBe("new");
        });

        it("silently drops missing single-path entry", async () => {
            settings.configSyncPaths = [".obsidian/missing.json"];

            const count = await cs.write();

            expect(count).toBe(0);
        });

        it("invokes onProgress for each written entry", async () => {
            settings.configSyncPaths = [".obsidian/app.json", ".obsidian/hotkeys.json"];
            await seedConfigDoc(".obsidian/app.json", "{}");
            await seedConfigDoc(".obsidian/hotkeys.json", "{}");

            const calls: string[] = [];
            await cs.write((path) => calls.push(path));

            expect(calls).toEqual([".obsidian/app.json", ".obsidian/hotkeys.json"]);
        });
    });

    // ── listPluginFolders ───────────────────────────────

    describe("listPluginFolders", () => {
        it("returns empty array when plugins dir missing", async () => {
            const folders = await cs.listPluginFolders();
            expect(folders).toEqual([]);
        });

        it("returns folder paths suffixed with /, sorted", async () => {
            vault.addFile(".obsidian/plugins/zebra/main.js", "code");
            vault.addFile(".obsidian/plugins/alpha/main.js", "code");
            vault.addFile(".obsidian/plugins/mike/main.js", "code");

            const folders = await cs.listPluginFolders();

            expect(folders).toEqual([
                ".obsidian/plugins/alpha/",
                ".obsidian/plugins/mike/",
                ".obsidian/plugins/zebra/",
            ]);
        });
    });

    // ── getCommonConfigPaths ────────────────────────────

    describe("getCommonConfigPaths", () => {
        it("returns a stable list of common obsidian config files", () => {
            const paths = cs.getCommonConfigPaths();
            expect(paths).toContain(".obsidian/app.json");
            expect(paths).toContain(".obsidian/hotkeys.json");
            expect(paths.every((p) => p.startsWith(".obsidian/"))).toBe(true);
        });
    });

    // ── withConfigRemote error gates ────────────────────

    describe("auth gate", () => {
        it("testConnection returns error message when not configured", async () => {
            const msg = await cs.testConnection();
            expect(msg).toBe("Config sync is not configured");
        });

        it("push throws immediately when auth is blocked", async () => {
            settings.couchdbUri = "http://localhost:5984";
            settings.couchdbConfigDbName = "vault-config";
            auth.raise(401, "bad creds");

            // Seed a doc so push() reaches the remote phase
            vault.addFile(".obsidian/app.json", "{}");

            await expect(cs.push()).rejects.toThrow(/Auth blocked/);
        });
    });
});
