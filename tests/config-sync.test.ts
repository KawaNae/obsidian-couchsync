/**
 * Tests for ConfigSync on one device: configuration gates, what Push sends
 * and what Pull writes (policy, exclusions, unchanged files), against a
 * FakeCouchClient. Multi-device merges are in
 * tests/integration/config-three-way.integ.test.ts.
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
import { makeConfigFixture, seedRemoteConfig } from "./helpers/config-fixture.ts";
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

        it("pull throws not-configured when unbound", async () => {
            const unbound = makeCs();
            await expect(unbound.pull()).rejects.toMatchObject({
                name: "ConfigNotReadyError",
                kind: "not-configured",
                message: expect.stringMatching(/not configured/),
            });
            // A name in settings without an open binding (the last rebind
            // failed) says so instead of pretending nothing is configured.
            settings.couchdbConfigDbName = "vault-config";
            await expect(unbound.pull()).rejects.toMatchObject({
                kind: "not-configured",
                message: expect.stringMatching(/not active on this device/),
            });
        });

        it("push throws when no config DB is applied but local has docs", async () => {
            vault.addFile(".obsidian/app.json", "{}");
            await expect(makeCs().push()).rejects.toThrow(/not configured/);
        });
    });

    // ── Push and Pull against a fake server ─────────────

    describe("Push and Pull against a server", () => {
        let remote: FakeCouchClient;
        let bound: ConfigSync;

        async function attach(opts: ConfigSyncOptions = {}): Promise<ConfigSync> {
            const c = await makeBoundCs({ rawClientFactory: () => remote, ...opts });
            await attachPlain(settings, remote, db);
            // The binding read its attachment when it opened: re-open it.
            await c.rebind(null);
            await c.rebind("vault-config");
            return c;
        }

        beforeEach(async () => {
            settings.couchdbUri = "http://localhost:5984";
            settings.couchdbConfigDbName = "vault-config";
            settings.compressionEnabled = false;
            remote = new FakeCouchClient();
            bound = await attach();
        });

        const onServer = async (path: string) => remote.getDoc<any>(makeConfigId(path));

        describe("Push: what is sent", () => {
            it("sends a config file and records it as the shared version and the base", async () => {
                vault.addFile(".obsidian/app.json", `{"theme":"dark"}`);

                expect(await bound.push()).toBe(1);

                const doc = await onServer(".obsidian/app.json");
                expect(doc.vclock).toEqual({ "dev-A": 1 });
                expect((await db.get(makeConfigId(".obsidian/app.json")))!.vclock).toEqual({ "dev-A": 1 });
                expect(bound.currentBinding()!.lastSynced.get(".obsidian/app.json")!.chunks).toEqual(doc.chunks);
            });

            it("sends nothing for a file unchanged since the last Push", async () => {
                vault.addFile(".obsidian/app.json", `{"theme":"dark"}`);
                await bound.push();
                const rev = (await onServer(".obsidian/app.json"))._rev;

                expect(await bound.push()).toBe(0);

                expect((await onServer(".obsidian/app.json"))._rev).toBe(rev);
            });

            it("sends a changed file with the base's vclock advanced", async () => {
                vault.addFile(".obsidian/app.json", "abc");
                await bound.push();
                vault.addFile(".obsidian/app.json", "xyz"); // same size, other bytes

                expect(await bound.push()).toBe(1);

                expect((await onServer(".obsidian/app.json")).vclock).toEqual({ "dev-A": 2 });
            });

            it("skips layout files, .git, node_modules and files over 5MB", async () => {
                vault.addFile(".obsidian/workspace.json", "layout");
                vault.addFile(".obsidian/workspace-mobile.json", "layout");
                vault.addFile(".obsidian/.git/HEAD", "ref: refs/heads/main");
                vault.addFile(".obsidian/node_modules/pkg/file.json", "{}");
                vault.addFile(".obsidian/big.json", "x".repeat(6 * 1024 * 1024));
                vault.addFile(".obsidian/app.json", "{}");

                expect(await bound.push()).toBe(1);
                expect(await onServer(".obsidian/app.json")).not.toBeNull();
            });

            it("never sends this plugin's data.json or backups, even under a renamed folder", async () => {
                // BRAT / manual install can put the plugin under its repo
                // name, so a hardcoded folder literal would miss the
                // data.json (which holds the plaintext password +
                // passphrase) and push it to the config server.
                const dir = ".obsidian/plugins/KawaNae-obsidian-couchsync";
                const renamed = await attach({ pluginDir: dir });
                vault.addFile(`${dir}/data.json`, `{"couchdbPassword":"SECRET"}`);
                vault.addFile(`${dir}/backups/config/2026-01-01_00-00-00/plugins/x/data.json`, `{"token":"SECRET"}`);
                vault.addFile(".obsidian/app.json", `{"theme":"dark"}`);

                expect(await renamed.push()).toBe(1);

                expect(await onServer(`${dir}/data.json`)).toBeNull();
                expect((await renamed.listLocalConfigPaths()).some((p) => p.startsWith(dir))).toBe(false);
            });

            it("the policy keeps theme CSS and drops plugin code", async () => {
                vault.addFile(".obsidian/plugins/foo/main.js", "code");
                vault.addFile(".obsidian/themes/bar/theme.css", "css");

                expect(await bound.push()).toBe(1);

                expect(await onServer(".obsidian/themes/bar/theme.css")).not.toBeNull();
                expect(await onServer(".obsidian/plugins/foo/main.js")).toBeNull();
            });
        });

        describe("Pull: what is written", () => {
            async function serve(path: string, content: string, n = 1): Promise<void> {
                await seedRemoteConfig(remote, [
                    await makeConfigFixture(path, content, { vclock: { "dev-Z": n } }),
                ]);
            }

            it("writes portable settings (app.json) by default", async () => {
                await serve(".obsidian/app.json", `{"theme":"dark"}`);

                expect(await bound.pull()).toBe(1);

                expect(vault.readText(".obsidian/app.json")).toBe(`{"theme":"dark"}`);
            });

            it("does NOT write plugin code (install-state) by default — JS safety", async () => {
                await serve(".obsidian/plugins/foo/main.js", "code-a");
                await serve(".obsidian/plugins/foo/manifest.json", "{}");

                expect(await bound.pull()).toBe(0);

                expect(vault.files.has(".obsidian/plugins/foo/main.js")).toBe(false);
                expect(vault.files.has(".obsidian/plugins/foo/manifest.json")).toBe(false);
            });

            it("writes a plugin's data.json only when the plugin is present locally", async () => {
                await serve(".obsidian/plugins/foo/data.json", `{"k":1}`);

                expect(await bound.pull()).toBe(0);
                expect(vault.files.has(".obsidian/plugins/foo/data.json")).toBe(false);

                vault.addFile(".obsidian/plugins/foo/manifest.json", `{"id":"foo"}`);
                expect(await bound.pull()).toBe(1);
                expect(vault.readText(".obsidian/plugins/foo/data.json")).toBe(`{"k":1}`);
            });

            it("never writes this plugin's own data.json", async () => {
                vault.addFile(".obsidian/plugins/obsidian-couchsync/manifest.json", "{}");
                await serve(".obsidian/plugins/obsidian-couchsync/data.json", "{}");

                expect(await bound.pull()).toBe(0);

                expect(vault.files.has(".obsidian/plugins/obsidian-couchsync/data.json")).toBe(false);
            });

            it("an explicit override enables a single main.js when safety is off", async () => {
                settings.configSyncPolicy = {
                    ...settings.configSyncPolicy,
                    blockPluginCode: false,
                    overrides: { ".obsidian/plugins/foo/main.js": true },
                };
                await serve(".obsidian/plugins/foo/main.js", "code");

                expect(await bound.pull()).toBe(1);

                expect(vault.readText(".obsidian/plugins/foo/main.js")).toBe("code");
            });

            it("does not materialise a desktop-only plugin's data.json on mobile", async () => {
                const mobile = await attach({ getIsMobile: () => true });
                vault.addFile(".obsidian/plugins/term/manifest.json", `{"id":"term","isDesktopOnly":true}`);
                await serve(".obsidian/plugins/term/data.json", `{"k":1}`);

                expect(await mobile.pull()).toBe(0);
                expect(vault.files.has(".obsidian/plugins/term/data.json")).toBe(false);

                vault.addFile(".obsidian/plugins/dv/manifest.json", `{"id":"dv","isDesktopOnly":false}`);
                await serve(".obsidian/plugins/dv/data.json", `{"k":2}`);
                expect(await mobile.pull()).toBe(1);
                expect(vault.readText(".obsidian/plugins/dv/data.json")).toBe(`{"k":2}`);
            });

            it("leaves a file whose content already matches untouched", async () => {
                vault.addFile(".obsidian/app.json", `{"theme":"dark"}`, { mtime: 1000 });
                await serve(".obsidian/app.json", `{"theme":"dark"}`);
                const writes: string[] = [];
                const writeBinary = vault.writeBinary.bind(vault);
                const createBinary = vault.createBinary.bind(vault);
                vault.writeBinary = async (p, d) => { writes.push(p); return writeBinary(p, d); };
                vault.createBinary = async (p, d) => { writes.push(p); return createBinary(p, d); };

                expect(await bound.pull()).toBe(0);

                expect(writes).toEqual([]);
                // An unchanged mtime is what keeps Obsidian from re-reading it.
                expect((await vault.stat(".obsidian/app.json"))!.mtime).toBe(1000);
            });

            it("writes only the files that differ, and a second Pull reads no file", async () => {
                vault.addFile(".obsidian/app.json", "{}");
                vault.addFile(".obsidian/hotkeys.json", "old");
                await serve(".obsidian/app.json", "{}");
                await serve(".obsidian/hotkeys.json", "new");
                await serve(".obsidian/appearance.json", `{"x":1}`);

                expect(await bound.pull()).toBe(2);
                expect(vault.readText(".obsidian/hotkeys.json")).toBe("new");
                expect(vault.readText(".obsidian/appearance.json")).toBe(`{"x":1}`);

                const reads: string[] = [];
                const readBinary = vault.readBinary.bind(vault);
                vault.readBinary = async (p) => { reads.push(p); return readBinary(p); };
                expect(await bound.pull()).toBe(0);
                expect(reads.filter((p) => !p.endsWith("manifest.json"))).toEqual([]);
            });

            it("calls the host's reload only when it wrote a file", async () => {
                let reloads = 0;
                const withReload = await attach({ reload: () => { reloads++; } });
                await serve(".obsidian/app.json", `{"a":1}`);

                expect(await withReload.pull()).toBe(1);
                expect(reloads).toBe(1);
                expect(await withReload.pull()).toBe(0);
                expect(reloads).toBe(1);
            });
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
