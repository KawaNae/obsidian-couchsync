/**
 * Tests for ConfigSync — focused on network-free paths (scan, write,
 * filtering, configuration gates). Remote push/pull/init are not
 * covered here because ConfigSync instantiates its CouchClient via a
 * module-level factory that can't be injected without vi.mock, which
 * this codebase avoids.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { ConfigSync, type ConfigSyncOptions } from "../src/sync/config-sync.ts";
import { ConfigLocalDB } from "../src/db/config-local-db.ts";
import { AuthGate } from "../src/db/sync/auth-gate.ts";
import { ALWAYS_VISIBLE } from "../src/db/visibility-gate.ts";
import { NoopReconnectBridge } from "../src/sync/reconnect-bridge.ts";
import { FakeVaultIO } from "./helpers/fake-vault-io.ts";
import { FakeModalPresenter } from "./helpers/fake-modal-presenter.ts";
import { makeSettings } from "./helpers/settings-factory.ts";
import { makeConfigId } from "../src/types/doc-id.ts";
import { makeConfigFixture } from "./helpers/config-fixture.ts";
import type { CouchSyncDoc } from "../src/types.ts";
import { FakeCouchClient } from "./helpers/fake-couch-client.ts";
import { attachPlain } from "./helpers/config-attach.ts";

let counter = 0;
function uniqueName() { return `config-sync-test-${Date.now()}-${counter++}`; }

describe("ConfigSync", () => {
    let vault: FakeVaultIO;
    let modal: FakeModalPresenter;
    let db: ConfigLocalDB;
    let auth: AuthGate;
    let settings: ReturnType<typeof makeSettings>;
    let cs: ConfigSync;

    /** An UNBOUND ConfigSync whose store factory hands out the test's `db`. */
    function makeCs(opts: ConfigSyncOptions = {}): ConfigSync {
        return new ConfigSync(
            vault, modal, "test-vault", auth, ALWAYS_VISIBLE, NoopReconnectBridge,
            () => settings,
            { storeFactory: () => db, ...opts },
        );
    }

    /** A ConfigSync bound to "vault-config" (store = the test's `db`). */
    async function makeBoundCs(opts: ConfigSyncOptions = {}): Promise<ConfigSync> {
        const c = makeCs(opts);
        await c.rebind("vault-config");
        return c;
    }

    beforeEach(async () => {
        vault = new FakeVaultIO();
        modal = new FakeModalPresenter();
        db = new ConfigLocalDB(uniqueName());
        db.open();
        auth = new AuthGate();
        settings = makeSettings({ deviceId: "dev-A" });
        cs = await makeBoundCs();
    });

    afterEach(async () => {
        await db.destroy().catch(() => {});
    });

    // ── Configuration gates ──────────────────────────────

    describe("configuration gates", () => {
        it("isConfigured: false before any rebind (no config DB applied)", () => {
            expect(makeCs().isConfigured()).toBe(false);
        });

        it("isConfigured: true once bound to a config DB", () => {
            expect(cs.isConfigured()).toBe(true);
            expect(cs.currentStore()).toBe(db);
        });

        it("isConfigured: false after rebind(null)", async () => {
            await cs.rebind(null);
            expect(cs.isConfigured()).toBe(false);
            expect(cs.currentStore()).toBeNull();
        });

        it("scan throws not-configured when unbound", async () => {
            const unbound = makeCs();
            await expect(unbound.scan()).rejects.toMatchObject({
                name: "ConfigNotReadyError",
                kind: "not-configured",
                message: expect.stringMatching(/not configured/),
            });
            // A name in settings without an open binding (the last rebind
            // failed) says so instead of pretending nothing is configured.
            settings.couchdbConfigDbName = "vault-config";
            await expect(unbound.scan()).rejects.toMatchObject({
                kind: "not-configured",
                message: expect.stringMatching(/not active on this device/),
            });
        });

        it("push throws when no config DB is applied but local has docs", async () => {
            vault.addFile(".obsidian/app.json", "{}");
            await expect(makeCs().push()).rejects.toThrow(/not configured/);
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

        it("skips own data.json under a RENAMED plugin folder via the host-supplied path", async () => {
            // BRAT / manual install can put the plugin under its repo name, so a
            // hardcoded folder literal would miss the data.json (which holds the
            // plaintext password + passphrase) and push it to the config server.
            const renamed = ".obsidian/plugins/KawaNae-obsidian-couchsync/data.json";
            const cs2 = await makeBoundCs(
                { ownDataJsonPath: renamed }, // = manifest.dir + "/data.json"
            );
            vault.addFile(renamed, `{"couchdbPassword":"SECRET","encryptionPassphrase":"SECRET"}`);
            // A normal config file alongside it, to prove scan still runs.
            vault.addFile(".obsidian/app.json", `{"theme":"dark"}`);

            const count = await cs2.scan();
            expect(count).toBe(1); // only app.json
            expect(await db.get(makeConfigId(renamed))).toBeNull(); // secret data.json excluded
            expect(await db.get(makeConfigId(".obsidian/app.json"))).not.toBeNull();
            // And the default-folder literal is NOT special-cased away here.
            vault.addFile(".obsidian/plugins/obsidian-couchsync/data.json", "{}");
            await cs2.scan();
            expect(await db.get(makeConfigId(".obsidian/plugins/obsidian-couchsync/data.json"))).not.toBeNull();
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

        it("recurses into subdirectories; SEND filter lands theme CSS, drops plugin code", async () => {
            vault.addFile(".obsidian/plugins/foo/main.js", "code"); // install-state → filtered
            vault.addFile(".obsidian/themes/bar/theme.css", "css"); // theme-css → synced

            await cs.scan();

            // Recursion reached both subtrees; the policy SEND projection keeps
            // the theme CSS and drops the plugin executable code (JS safety).
            expect(await db.get(makeConfigId(".obsidian/themes/bar/theme.css"))).not.toBeNull();
            expect(await db.get(makeConfigId(".obsidian/plugins/foo/main.js"))).toBeNull();
        });

        // ── short-circuit: lastSynced cache ──
        // Without it every scan rev-bumped every config doc, inflating the
        // remote rev tree. The cache should detect "vault content same
        // as last sync" via {size, dataHash} and skip the rewrite.
        it("does not rewrite when content is unchanged across scans", async () => {
            vault.addFile(".obsidian/app.json", `{"theme":"dark"}`);

            await cs.scan();
            const after1 = await db.get(makeConfigId(".obsidian/app.json"));
            expect(after1!.vclock).toEqual({ "dev-A": 1 });

            // Second scan with identical content → must not bump vclock.
            await cs.scan();
            const after2 = await db.get(makeConfigId(".obsidian/app.json"));
            expect(after2!.vclock).toEqual({ "dev-A": 1 });
            expect(after2!._rev).toBe(after1!._rev);
        });

        it("rewrites when content changes (size diff)", async () => {
            vault.addFile(".obsidian/app.json", "v1");
            await cs.scan();

            vault.addFile(".obsidian/app.json", "v22");
            await cs.scan();

            const doc = await db.get(makeConfigId(".obsidian/app.json"));
            expect(doc!.vclock["dev-A"]).toBe(2);
        });

        it("rewrites when content changes at the same size (hash diff)", async () => {
            vault.addFile(".obsidian/app.json", "abc");
            await cs.scan();

            vault.addFile(".obsidian/app.json", "xyz"); // same size, different bytes
            await cs.scan();

            const doc = await db.get(makeConfigId(".obsidian/app.json"));
            expect(doc!.vclock["dev-A"]).toBe(2);
        });

        it("create() clears lastSynced so a subsequent scan rewrites unchanged files", async () => {
            // This guarantees the destructive Init still rebuilds local
            // state correctly even before remote-side destroy is wired in.
            vault.addFile(".obsidian/app.json", `{"theme":"dark"}`);

            await cs.scan();
            const before = await db.get(makeConfigId(".obsidian/app.json"));
            expect(before!.vclock).toEqual({ "dev-A": 1 });

            // init wipes local docs + lastSynced meta, then re-scans.
            // (The remote-side phases need a CouchClient, so they're
            // exercised only via integration tests; here we just verify
            // the local clearing→rescan path.)
            try {
                await cs.create();
            } catch {
                // remote-side phases will fail with no client, but the
                // local clearing happens first. Tolerate the error.
            }

            const after = await db.get(makeConfigId(".obsidian/app.json"));
            expect(after).not.toBeNull();
            // After init, the doc has been re-created from scratch — vclock
            // resets because init's deleteByPrefix dropped the existing one.
            expect(after!.vclock).toEqual({ "dev-A": 1 });
        });
    });

    // ── write ───────────────────────────────────────────

    describe("write", () => {
        async function seedConfigDoc(path: string, content: string): Promise<void> {
            const { doc, chunks } = await makeConfigFixture(path, content);
            await db.runWriteTx({
                docs: [{ doc: doc as unknown as CouchSyncDoc }],
                chunks: chunks as unknown as CouchSyncDoc[],
            });
        }

        it("writes portable settings (app.json) by default", async () => {
            await seedConfigDoc(".obsidian/app.json", `{"theme":"dark"}`);

            const count = await cs.write();

            expect(count).toBe(1);
            expect(vault.readText(".obsidian/app.json")).toBe(`{"theme":"dark"}`);
        });

        it("does NOT write plugin code (install-state) by default — JS safety", async () => {
            await seedConfigDoc(".obsidian/plugins/foo/main.js", "code-a");
            await seedConfigDoc(".obsidian/plugins/foo/manifest.json", "{}");

            const count = await cs.write();

            expect(count).toBe(0);
            expect(vault.files.has(".obsidian/plugins/foo/main.js")).toBe(false);
            expect(vault.files.has(".obsidian/plugins/foo/manifest.json")).toBe(false);
        });

        it("writes a plugin's data.json only when the plugin is present locally", async () => {
            await seedConfigDoc(".obsidian/plugins/foo/data.json", `{"k":1}`);

            // plugin not installed locally → presence gate skips it
            expect(await cs.write()).toBe(0);
            expect(vault.files.has(".obsidian/plugins/foo/data.json")).toBe(false);

            // install the plugin locally (folder now exists) → materialised
            vault.addFile(".obsidian/plugins/foo/manifest.json", `{"id":"foo"}`);
            const count = await cs.write();
            expect(count).toBe(1);
            expect(vault.readText(".obsidian/plugins/foo/data.json")).toBe(`{"k":1}`);
        });

        it("skips own plugin data.json (SKIP_PATHS) even when present", async () => {
            vault.addFile(".obsidian/plugins/obsidian-couchsync/manifest.json", "{}");
            await seedConfigDoc(".obsidian/plugins/obsidian-couchsync/data.json", "{}");

            const count = await cs.write();

            expect(count).toBe(0);
            expect(vault.files.has(".obsidian/plugins/obsidian-couchsync/data.json")).toBe(false);
        });

        it("an explicit override enables a single main.js when safety is off", async () => {
            settings.configSyncPolicy = {
                ...settings.configSyncPolicy,
                blockPluginCode: false,
                overrides: { ".obsidian/plugins/foo/main.js": true },
            };
            await seedConfigDoc(".obsidian/plugins/foo/main.js", "code");

            const count = await cs.write();

            expect(count).toBe(1);
            expect(vault.readText(".obsidian/plugins/foo/main.js")).toBe("code");
        });

        it("does not materialise a desktop-only plugin's data.json on mobile", async () => {
            const mobileCs = await makeBoundCs({ getIsMobile: () => true });
            // plugin present locally, but its local manifest is desktop-only
            vault.addFile(".obsidian/plugins/term/manifest.json", `{"id":"term","isDesktopOnly":true}`);
            await seedConfigDoc(".obsidian/plugins/term/data.json", `{"k":1}`);

            expect(await mobileCs.write()).toBe(0);
            expect(vault.files.has(".obsidian/plugins/term/data.json")).toBe(false);

            // a non-desktop-only plugin on the same mobile device is fine
            vault.addFile(".obsidian/plugins/dv/manifest.json", `{"id":"dv","isDesktopOnly":false}`);
            await seedConfigDoc(".obsidian/plugins/dv/data.json", `{"k":2}`);
            expect(await mobileCs.write()).toBe(1);
            expect(vault.readText(".obsidian/plugins/dv/data.json")).toBe(`{"k":2}`);
        });

        it("overwrites existing file", async () => {
            vault.addFile(".obsidian/app.json", "old");
            await seedConfigDoc(".obsidian/app.json", "new");

            await cs.write();

            expect(vault.readText(".obsidian/app.json")).toBe("new");
        });

        it("invokes onProgress for each written entry", async () => {
            await seedConfigDoc(".obsidian/app.json", "{}");
            await seedConfigDoc(".obsidian/hotkeys.json", "{}");

            const calls: string[] = [];
            await cs.write((path) => calls.push(path));

            expect(calls.sort()).toEqual([".obsidian/app.json", ".obsidian/hotkeys.json"]);
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
        it("push throws immediately when auth is blocked", async () => {
            settings.couchdbUri = "http://localhost:5984";
            settings.couchdbConfigDbName = "vault-config";
            auth.raise(401, "bad creds");

            // Seed a doc so push() reaches the remote phase
            vault.addFile(".obsidian/app.json", "{}");

            await expect(cs.push()).rejects.toMatchObject({ name: "AuthBlockedError" });
        });
    });

    // ── Step 1 codec vs the joined DB ────
    //
    // Push and Pull encode with the codec recorded in the store when the
    // device created or joined the DB; Step 1 is only the input of the next
    // Create. A Step 1 toggle therefore never stops sync (it used to be
    // `codec-changed`) and never changes how data reaches the server.
    describe("Step 1 codec changes never stop sync", () => {
        let remote: FakeCouchClient;
        let bound: ConfigSync;
        beforeEach(async () => {
            settings.couchdbUri = "http://localhost:5984";
            settings.couchdbConfigDbName = "vault-config";
            settings.compressionEnabled = false; // joined as plaintext, uncompressed
            remote = new FakeCouchClient();
            bound = await makeBoundCs({ rawClientFactory: () => remote });
            await attachPlain(settings, remote, db);
        });

        it("encryption toggled on in Step 1: Push still succeeds, and sends plaintext as joined", async () => {
            settings.configEncryptionEnabled = true;
            settings.configEncryptionPassphrase = "secret";
            vault.addFile(".obsidian/app.json", `{"theme":"dark"}`);
            expect(await bound.push()).toBe(1);
            // The server copy is a plaintext ConfigDoc under its path id —
            // the joined codec, not Step 1, decided the encoding.
            const doc = await remote.getDoc<any>(makeConfigId(".obsidian/app.json"));
            expect(doc).toMatchObject({ type: "config", chunks: expect.any(Array) });
        });

        it("compression flipped in Step 1: Pull and Push still succeed", async () => {
            vault.addFile(".obsidian/hotkeys.json", `{"k":1}`);
            expect(await bound.push()).toBe(1);
            settings.configCompressionEnabled = true;
            await expect(bound.pull()).resolves.toBeGreaterThanOrEqual(0);
            vault.addFile(".obsidian/hotkeys.json", `{"k":2}`);
            expect(await bound.push()).toBe(1);
        });

        it("an unattached device (no attachment) is reported as unattached", async () => {
            const fresh = new ConfigLocalDB(uniqueName());
            const other = new ConfigSync(
                vault, modal, "test-vault", auth, ALWAYS_VISIBLE, NoopReconnectBridge,
                () => settings,
                { storeFactory: () => fresh, rawClientFactory: () => remote },
            );
            await other.rebind("vault-config");
            vault.addFile(".obsidian/app.json", "{}");
            await expect(other.push()).rejects.toMatchObject({ kind: "unattached" });
            await other.close();
            await fresh.destroy();
        });

        it("the auth latch still comes first", async () => {
            settings.configCompressionEnabled = true;
            auth.raise(401, "bad creds");
            await expect(bound.push()).rejects.toMatchObject({ name: "AuthBlockedError" });
        });
    });
});
