/**
 * A config op that reloads Obsidian (Pull & Reload, Pull & Overwrite,
 * Share again) and an operation a reload would stop half-way (vault Init
 * and Clone, config Create) never run together. Either one started while
 * the other runs is refused, changes nothing and is not recorded; once the
 * other ends it can start. A Pull that reloads keeps the others out until
 * the app goes down. Push neither reloads nor breaks when stopped, and
 * runs beside a vault Init.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { ReloadGuard } from "../src/sync/reload-guard.ts";
import { ConfigSync } from "../src/sync/config-sync.ts";
import { ConfigLocalDB } from "../src/db/config-local-db.ts";
import { AuthGate } from "../src/db/sync/auth-gate.ts";
import { ALWAYS_VISIBLE } from "../src/db/visibility-gate.ts";
import { NoopReconnectBridge } from "../src/sync/reconnect-bridge.ts";
import { VaultBinding } from "../src/sync/vault-binding.ts";
import type { ConfigShareAgainPreview } from "../src/types/modal-presenter.ts";
import type { CouchSyncSettings } from "../src/settings.ts";
import { DOC_ID } from "../src/types/doc-id.ts";
import { FakeCouchClient } from "./helpers/fake-couch-client.ts";
import { FakeVaultIO } from "./helpers/fake-vault-io.ts";
import { FakeModalPresenter } from "./helpers/fake-modal-presenter.ts";
import { makeSettings } from "./helpers/settings-factory.ts";
import { attachPlain } from "./helpers/config-attach.ts";
import { makeConfigFixture, seedRemoteConfig } from "./helpers/config-fixture.ts";

describe("ReloadGuard", () => {
    it("refuses the other role while a lease is held, never the same role", () => {
        const g = new ReloadGuard();
        const lease = g.enter("Config Pull", "reloads");
        expect(g.blocker("uninterruptible")).toBe("Config Pull is running — wait for it to finish.");
        expect(g.blocker("reloads")).toBeNull();
        expect(() => g.enter("Vault Init", "uninterruptible")).toThrow();
        lease.release();
        expect(g.blocker("uninterruptible")).toBeNull();
    });

    it("a lease held for the reload keeps refusing, with the reload named", () => {
        const g = new ReloadGuard();
        const seen: (string | null)[] = [];
        g.onChange(() => seen.push(g.blocker("uninterruptible")));
        const lease = g.enter("Config Pull", "reloads");
        lease.holdForReload();
        lease.release();
        expect(g.blocker("uninterruptible")).toMatch(/^Obsidian is about to reload after Config Pull/);
        expect(seen).toEqual([
            "Config Pull is running — wait for it to finish.",
            expect.stringMatching(/^Obsidian is about to reload/),
        ]);
    });
});

let counter = 0;
function uniqueName() { return `cs-reload-guard-${Date.now()}-${counter++}`; }

/** A dialog that stays open until the test answers it. */
class Held<T> {
    private answer!: (v: T) => void;
    open = false;
    show(): Promise<T> {
        this.open = true;
        return new Promise<T>((r) => { this.answer = r; });
    }
    close(v: T): void {
        this.open = false;
        this.answer(v);
    }
}

class HeldModalPresenter extends FakeModalPresenter {
    readonly shareAgain = new Held<boolean>();
    async showConfigShareAgainModal(preview: ConfigShareAgainPreview): Promise<boolean> {
        this.shareAgainCalls.push(preview);
        return this.shareAgain.show();
    }
}

describe("config ops that reload and vault Init / Clone exclude each other", () => {
    let guard: ReloadGuard;
    let settings: CouchSyncSettings;
    let vaultIO: FakeVaultIO;
    let configDb: ConfigLocalDB;
    let configRemote: FakeCouchClient;
    let modal: HeldModalPresenter;
    let reloads: number;
    let cs: ConfigSync;
    let vaultRemote: FakeCouchClient;
    let vb: VaultBinding;
    /** The destructive step of Init / Clone waits for it. */
    let setupGate: Promise<void>;
    let openSetup: () => void;
    let setupStarted: boolean;
    let vaultFailures: unknown[];

    beforeEach(async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        guard = new ReloadGuard();
        settings = makeSettings({
            deviceId: "dev-A",
            couchdbUri: "http://localhost:5984",
            couchdbDbName: "vault",
            couchdbConfigDbName: "config-test",
            connectionState: "setupDone",
            serverTested: true,
            compressionEnabled: false,
        });

        vaultIO = new FakeVaultIO();
        configDb = new ConfigLocalDB(uniqueName());
        configDb.open();
        configRemote = new FakeCouchClient();
        modal = new HeldModalPresenter();
        reloads = 0;
        cs = new ConfigSync(
            vaultIO, modal, "test-vault", new AuthGate(), ALWAYS_VISIBLE, NoopReconnectBridge,
            () => settings,
            {
                storeFactory: () => configDb,
                clientFactory: () => configRemote,
                rawClientFactory: () => configRemote,
                reload: () => { reloads++; },
                reloadGuard: guard,
            },
        );
        await attachPlain(settings, configRemote, configDb);
        await cs.rebind("config-test");

        vaultRemote = new FakeCouchClient();
        setupGate = Promise.resolve();
        openSetup = () => {};
        setupStarted = false;
        vaultFailures = [];
        const result = { vaultFiles: 0, totalDocs: 0 };
        vb = new VaultBinding({
            getSettings: () => settings,
            saveSettings: async () => {},
            auth: new AuthGate(),
            makeRawClient: () => vaultRemote,
            setup: () => ({
                init: async (_p, publishMeta) => {
                    setupStarted = true;
                    await publishMeta();
                    await setupGate;
                    return result;
                },
                clone: async () => {
                    setupStarted = true;
                    await setupGate;
                    return result;
                },
            }),
            checkDatabase: async () => ({ status: "exists", docCount: 0 }),
            stopLive: () => {},
            startLive: async () => {},
            openProgress: () => ({ update: () => {}, done: () => {}, fail: (e) => { vaultFailures.push(e); } }),
            askPassphrase: async () => null,
            confirmSetup: async () => true,
            reloadGuard: guard,
        });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await cs.close().catch(() => {});
        await configDb.destroy().catch(() => {});
    });

    /** Hold the vault Init in its destructive step. Resolves with the
     *  running Init, wrapped so that awaiting this does not await it. */
    async function holdInit(): Promise<{ running: Promise<void> }> {
        setupGate = new Promise<void>((r) => { openSetup = r; });
        const running = vb.init();
        await vi.waitFor(() => expect(setupStarted).toBe(true));
        return { running };
    }

    async function serve(path: string, content: string): Promise<void> {
        await seedRemoteConfig(configRemote, [
            await makeConfigFixture(path, content, { vclock: { "dev-Z": 1 } }),
        ]);
    }

    it("while a vault Init runs, the config ops that reload and Create are refused as busy and change nothing", async () => {
        await serve(".obsidian/app.json", `{"theme":"dark"}`);
        const { running: initing } = await holdInit();

        expect(cs.reloadConflict("pull")).toBe("Vault Init is running — wait for it to finish.");
        expect(cs.reloadConflict("create")).toBeNull();
        expect(cs.reloadConflict("join")).toBeNull();
        for (const op of [
            () => cs.pull(),
            () => cs.overwrite(),
            () => cs.shareAgain(".obsidian/app.json", "/theme"),
        ]) {
            await expect(op()).rejects.toMatchObject({
                name: "BusyError",
                message: "Vault Init is running — wait for it to finish.",
            });
        }
        expect(await vaultIO.exists(".obsidian/app.json")).toBe(false);
        expect(modal.shareAgainCalls).toEqual([]);
        expect(reloads).toBe(0);
        // Not an outcome of the config relation: nothing ran.
        expect(cs.currentBinding()!.relation().lastOp).toBeNull();

        openSetup();
        await initing;
        expect(cs.reloadConflict("pull")).toBeNull();
        expect(await cs.pull()).toBe(1);
        expect(reloads).toBe(1);
    });

    it("a config Push runs beside a vault Init", async () => {
        vaultIO.addFile(".obsidian/app.json", `{"theme":"dark"}`);
        modal.pushResponder = (review) => review.items.map((i) => i.id);
        const { running: initing } = await holdInit();

        expect(cs.reloadConflict("push")).toBeNull();
        await expect(cs.push()).resolves.toBe(1);
        expect(await configRemote.getDoc(`${DOC_ID.CONFIG}.obsidian/app.json`)).not.toBeNull();

        openSetup();
        await initing;
    });

    it("while a config Pull runs, vault Init and Clone are refused and not recorded", async () => {
        const sharing = cs.shareAgain(".obsidian/app.json", "/theme");
        await vi.waitFor(() => expect(modal.shareAgain.open).toBe(true));

        expect(vb.reloadConflict()).toBe("Config Share again is running — wait for it to finish.");
        await expect(vb.init()).rejects.toThrow("Config Share again is running — wait for it to finish.");
        await expect(vb.clone()).rejects.toThrow("Config Share again is running — wait for it to finish.");
        expect(setupStarted).toBe(false);
        expect(vaultFailures).toHaveLength(2);
        expect(vb.relation().lastOp).toBeNull();
        expect(vb.relation().busy).toBeNull();

        modal.shareAgain.close(false);
        await expect(sharing).rejects.toMatchObject({ name: "AbortError" });
        expect(vb.reloadConflict()).toBeNull();
        await vb.init();
        expect(setupStarted).toBe(true);
        expect(vb.relation().lastOp).toMatchObject({ op: "init", error: null });
    });

    it("after a Pull that reloads, Init, Clone, Create and Join stay refused until the app goes down", async () => {
        await serve(".obsidian/app.json", `{"theme":"dark"}`);
        expect(await cs.pull()).toBe(1);
        expect(reloads).toBe(1);

        const reloading = /^Obsidian is about to reload after Config Pull/;
        expect(vb.reloadConflict()).toMatch(reloading);
        await expect(vb.init()).rejects.toThrow(reloading);
        await expect(vb.clone()).rejects.toThrow(reloading);
        await expect(cs.create()).rejects.toMatchObject({ name: "BusyError", message: expect.stringMatching(reloading) });
        await expect(cs.join()).rejects.toMatchObject({ name: "BusyError", message: expect.stringMatching(reloading) });
        expect(modal.createCalls).toEqual([]);
        expect(setupStarted).toBe(false);
    });

    it("after a Pull that writes nothing, Init can start", async () => {
        expect(await cs.pull()).toBe(0);
        expect(reloads).toBe(0);
        expect(vb.reloadConflict()).toBeNull();
        await vb.init();
        expect(setupStarted).toBe(true);
    });
});
