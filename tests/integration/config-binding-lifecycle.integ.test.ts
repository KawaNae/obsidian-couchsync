/**
 * Config binding lifecycle.
 *
 * The config DB name, its local store, cursors, lastSynced cache, key and
 * this device's participation record are one binding owned by ConfigSync.
 * Apply calls `rebind`; Create / Join attach the device; every Push / Pull /
 * listing runs the binding's preflight on the raw client first. So:
 *
 *   - a DB name applied after startup works without a reload, and a device
 *     that has not joined is told to Join instead of doing nothing (the
 *     reproduced bug: Pull did nothing, then "Re-run Config Init");
 *   - the config key never depends on the vault's connection state, and
 *     only Push needs a device name;
 *   - a reset on another device (new salt) stops sync until the device
 *     Joins again;
 *   - switching A → B never uses A's store / checkpoint / lastSynced / key /
 *     attachment against B; switching back to A re-opens A's store; the
 *     same holds for switching SERVERS (X → Y → X);
 *   - settings and binding change together: a server or DB change refused
 *     while an op runs saves nothing, so Create's preview, Create itself
 *     and the filter tree all use the server the settings name;
 *   - the passphrase is resolved once, at Create / Join, and kept on the
 *     binding: later Step 1 or vault-side changes do not stop config sync,
 *     and DBs with different passphrases keep their own; Join tries the
 *     values at hand and asks only when none unlocks;
 *   - Push / Pull use the joined DB's codec: a Step 1 or vault codec change
 *     (e.g. a Vault Clone) never stops config sync;
 *   - an op's key and chunk hasher are fixed for its run — the filter tree
 *     cannot change them;
 *   - an encrypted root that turned plaintext is its own failure, and Join
 *     asks before adopting a weaker codec;
 *   - a rebind (or a local maintenance task) while an op runs is refused.
 *
 * Real ConfigSync + ConfigBinding + ConfigLocalDB (fake-indexeddb) +
 * FakeCouchClient, and the real `binding.wrapClient` codec stack (no
 * `clientFactory` override), so the encrypted cases run through the real
 * EncryptingCouchClient.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ConfigSync } from "../../src/sync/config-sync.ts";
import type { AskConfigPassphrase, ConfigStoreFactory } from "../../src/sync/config-binding.ts";
import { ConfigLocalDB } from "../../src/db/config-local-db.ts";
import { AuthGate } from "../../src/db/sync/auth-gate.ts";
import { ALWAYS_VISIBLE } from "../../src/db/visibility-gate.ts";
import { NoopReconnectBridge } from "../../src/sync/reconnect-bridge.ts";
import {
    CONFIG_META_DOC_ID,
    type ConfigMetaDoc,
} from "../../src/db/vault-meta.ts";
import { makeConfigId } from "../../src/types/doc-id.ts";
import type { DbInfo } from "../../src/db/interfaces.ts";
import type { CouchSyncSettings } from "../../src/settings.ts";
import { FakeCouchClient } from "../helpers/fake-couch-client.ts";
import { FakeVaultIO } from "../helpers/fake-vault-io.ts";
import { FakeModalPresenter } from "../helpers/fake-modal-presenter.ts";
import { makeSettings } from "../helpers/settings-factory.ts";
import { clearLog, getLogEntries } from "../../src/ui/log.ts";
import {
    getAttachment,
    getEntry,
    putAttachment,
    putEntry,
} from "../helpers/config-attach.ts";
import { resolveConfigCodec } from "../../src/sync/config-codec-policy.ts";
import { sameCodec } from "../../src/sync/config-binding-record.ts";
import { configRelationView } from "../../src/settings-tab/config-relation-view.ts";
import {
    applyServerSettings,
    type ConfigServerSwitch,
} from "../../src/settings-tab/server-apply.ts";

let counter = 0;
const unique = () => `${Date.now()}-${counter++}`;

/** FakeCouchClient whose reachability probe parks until released. */
class ParkedCouchClient extends FakeCouchClient {
    private release: (() => void) | null = null;
    parked = false;
    park(): void {
        this.parked = false;
        const gate = new Promise<void>((r) => { this.release = r; });
        const orig = FakeCouchClient.prototype.info;
        this.info = async (signal?: AbortSignal): Promise<DbInfo> => {
            this.parked = true;
            await gate;
            this.info = orig;
            return orig.call(this, signal);
        };
    }
    unpark(): void { this.release?.(); }
}

describe("config binding lifecycle", () => {
    /** Remote config DBs by server + name — the raw client factory routes by
     *  the server and DB name ConfigSync pins from its current binding. */
    let remotes: Map<string, ParkedCouchClient>;
    /** Every store any device opened, for cleanup and identity checks. */
    let opened: { name: string; store: ConfigLocalDB }[];
    const SERVER = "http://localhost:5984";
    const PASS = "config-pass-123";
    const ENC = {
        configEncryptionEnabled: true,
        configEncryptionPassphrase: PASS,
        configCompressionEnabled: false,
    } as const;

    const storeFactory: ConfigStoreFactory = (name) => {
        const store = new ConfigLocalDB(name);
        opened.push({ name, store });
        return store;
    };

    function remote(dbName: string, server: string = SERVER): ParkedCouchClient {
        const k = `${server}|${dbName}`;
        let r = remotes.get(k);
        if (!r) { r = new ParkedCouchClient(); remotes.set(k, r); }
        return r;
    }

    interface Device {
        cs: ConfigSync;
        vault: FakeVaultIO;
        settings: CouchSyncSettings;
        modal: FakeModalPresenter;
        vaultName: string;
        saves: number;
    }

    function makeDevice(
        deviceId: string,
        overrides: Partial<CouchSyncSettings> = {},
        askPassphrase?: AskConfigPassphrase,
        reuse?: { vault: FakeVaultIO; vaultName: string; settings: CouchSyncSettings },
    ): Device {
        const vault = reuse?.vault ?? new FakeVaultIO();
        const settings = reuse?.settings ?? makeSettings({
            deviceId,
            couchdbUri: SERVER,
            couchdbConfigDbName: "",
            encryptionEnabled: false,
            compressionEnabled: false,
            ...overrides,
        });
        const modal = new FakeModalPresenter();
        const vaultName = reuse?.vaultName ?? `vault-${deviceId}-${unique()}`;
        const dev: Device = {
            cs: undefined as unknown as ConfigSync, vault, settings, modal, vaultName, saves: 0,
        };
        dev.cs = new ConfigSync(
            vault, modal, vaultName, new AuthGate(),
            ALWAYS_VISIBLE, NoopReconnectBridge, () => settings,
            {
                storeFactory,
                rawClientFactory: (s) => remote(s.couchdbConfigDbName, s.couchdbUri),
                saveSettings: async () => { dev.saves++; },
                askPassphrase,
            },
        );
        return dev;
    }

    /** The attachment in the device's current store. */
    async function attachmentOf(d: Device) {
        return getAttachment(d.cs.currentStore()!);
    }

    /** Apply as the Config Sync tab does: rebind, persisting the name
     *  inside it. */
    async function apply(d: Device, dbName: string): Promise<void> {
        await d.cs.rebind(dbName || null, {
            commit: async () => { d.settings.couchdbConfigDbName = dbName; },
        });
    }

    /** Apply a server as the CouchDB tab does (`applyServerSettings` with
     *  the index.ts wiring): the settings are saved inside the rebind. */
    function serverSwitch(d: Device): ConfigServerSwitch {
        return {
            changeBlocker: () => d.cs.bindingChangeBlocker(),
            switchServer: (serverUri, commit) => d.cs.rebind(
                d.settings.couchdbConfigDbName || null, { serverUri, commit },
            ),
        };
    }
    async function applyServer(d: Device, uri: string) {
        return applyServerSettings({
            configBinding: serverSwitch(d),
            oldUri: d.settings.couchdbUri,
            newUri: uri,
            save: async () => { d.settings.couchdbUri = uri; },
        });
    }

    /** A device that Creates `dbName` and Pushes `files` to it. Returned
     *  open, so a test can Create again from it. */
    async function creator(
        dbName: string,
        files: Record<string, string>,
        codec: Partial<CouchSyncSettings> = {},
    ): Promise<Device> {
        const a = makeDevice(`seed-${unique()}`, { configCompressionEnabled: false, ...codec });
        await apply(a, dbName);
        for (const [p, c] of Object.entries(files)) a.vault.addFile(p, c);
        await a.cs.create();
        await a.cs.push();
        return a;
    }

    async function seed(
        dbName: string,
        files: Record<string, string>,
        codec: Partial<CouchSyncSettings> = {},
    ): Promise<void> {
        await (await creator(dbName, files, codec)).cs.close();
    }

    beforeEach(() => {
        remotes = new Map();
        opened = [];
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        const seen = new Set<string>();
        for (const o of opened) {
            if (seen.has(o.name)) continue;
            seen.add(o.name);
            await o.store.destroy().catch(() => {});
        }
    });

    describe("a DB name applied after startup (no reload)", () => {
        it("started with an empty DB name: rebind, Join, Pull", async () => {
            await seed("cfg-shared", { ".obsidian/app.json": `{"theme":"dark"}` });

            const dev = makeDevice("dev-B");
            await dev.cs.rebind(null); // onload with an empty name
            expect(dev.cs.currentStore()).toBeNull();
            // Before Apply the Pull is refused loudly, not silently.
            await expect(dev.cs.pull()).rejects.toMatchObject({ kind: "not-configured" });

            await apply(dev, "cfg-shared");
            expect(dev.cs.currentStore()).not.toBeNull();
            // Applied but not joined: Pull says to Join (never "Init"), and
            // does not join by itself.
            const err = await dev.cs.pull().catch((e) => e);
            expect(err).toMatchObject({ kind: "unattached" });
            expect(err.message).toMatch(/Join/);
            expect(err.message).not.toMatch(/Create|Init/);
            expect(await attachmentOf(dev)).toBeNull();

            await dev.cs.join();
            expect(await dev.cs.pull()).toBe(1);
            expect(dev.vault.readText(".obsidian/app.json")).toBe(`{"theme":"dark"}`);
        });

        it("encrypted: A Creates + Pushes; B starts unnamed, rebinds, Joins and Pulls without a reload", async () => {
            await seed("cfg-enc", { ".obsidian/app.json": `{"enc":true}` }, ENC);

            const dev = makeDevice("dev-B", ENC);
            await dev.cs.rebind(null);
            await apply(dev, "cfg-enc");

            // Pull before Join stops as unattached.
            await expect(dev.cs.pull()).rejects.toMatchObject({ kind: "unattached" });

            await dev.cs.join();
            const binding = dev.cs.currentBinding()!;
            // The attachment (in the store): the meta's codec, the root pinned.
            const att = (await attachmentOf(dev))!;
            expect(att.codec).toEqual({ encryption: true, compression: false });
            expect(att.metaFingerprint).toMatch(/^sha256:/);
            expect(binding.attachment).toEqual(att);
            // The settings entry: cipher floor SET from the meta.
            expect(getEntry(dev.settings)).toEqual({ cipherFloor: 3, settingUp: false, passphrase: PASS });
            expect(dev.saves).toBeGreaterThan(0);

            expect(await dev.cs.pull()).toBe(1);
            expect(dev.vault.readText(".obsidian/app.json")).toBe(`{"enc":true}`);
            // PBKDF2 ran once for this binding (Join); the Pull's preflight
            // used the cached key.
            expect(binding.keyDerivations).toBe(1);
            expect(await dev.cs.pull()).toBe(1);
            expect(binding.keyDerivations).toBe(1);
            expect(binding.relation().last).toMatchObject({ op: "pull", error: null });
        });
    });

    describe("reverse order: config before the vault", () => {
        it("vault not connected and no device name: Join and Pull succeed; Push asks for a device name", async () => {
            await seed("cfg-enc", { ".obsidian/app.json": `{"k":1}` }, ENC);

            const dev = makeDevice("", {
                ...ENC,
                connectionState: "editing", // vault never set up / not syncing
            });
            expect(dev.settings.deviceId).toBe("");
            await apply(dev, "cfg-enc");

            await dev.cs.join();
            expect(await dev.cs.pull()).toBe(1);
            expect(dev.vault.readText(".obsidian/app.json")).toBe(`{"k":1}`);

            dev.vault.addFile(".obsidian/hotkeys.json", "{}");
            await expect(dev.cs.push()).rejects.toMatchObject({
                kind: "device-id-missing",
            });
        });
    });

    describe("a reset on another device", () => {
        it("encrypted: a new root stops B as root-changed until B Joins again", async () => {
            const a = await creator("cfg-enc", { ".obsidian/app.json": `{"v":1}` }, ENC);
            const b = makeDevice("dev-B", ENC);
            await apply(b, "cfg-enc");
            await b.cs.join();
            expect(await b.cs.pull()).toBe(1);
            const before = (await attachmentOf(b))!.metaFingerprint;

            // A re-creates the DB (fresh salt) and pushes again.
            a.vault.addFile(".obsidian/app.json", `{"v":2}`);
            await a.cs.create();
            await a.cs.push();

            const err = await b.cs.pull().catch((e) => e);
            expect(err).toMatchObject({ kind: "root-changed" });
            expect(err.message).toMatch(/Join/);
            expect(err.message).not.toMatch(/Create/);
            // Nothing is joined automatically.
            expect((await attachmentOf(b))!.metaFingerprint).toBe(before);

            await b.cs.join();
            expect((await attachmentOf(b))!.metaFingerprint).not.toBe(before);
            expect(await b.cs.pull()).toBe(1);
            expect(b.vault.readText(".obsidian/app.json")).toBe(`{"v":2}`);
            await a.cs.close();
        });
    });

    describe("a reset on another device — plaintext and older metas", () => {
        it("plaintext: a re-Create is detected (generation id) and a Join recovers", async () => {
            const a = await creator("cfg-plain", { ".obsidian/app.json": `{"v":1}` });
            const firstMeta = (await remote("cfg-plain").getDoc<ConfigMetaDoc>(CONFIG_META_DOC_ID))!;
            expect(firstMeta.encryption.enabled).toBe(false);
            expect(firstMeta.generationId).toMatch(/^[0-9a-f]{32}$/);

            const b = makeDevice("dev-B");
            await apply(b, "cfg-plain");
            await b.cs.join();
            expect(await b.cs.pull()).toBe(1);
            const before = (await attachmentOf(b))!.metaFingerprint;

            // Same codec (plaintext, uncompressed) — only the generation differs.
            a.vault.addFile(".obsidian/app.json", `{"v":2}`);
            await a.cs.create();
            await a.cs.push();
            const secondMeta = (await remote("cfg-plain").getDoc<ConfigMetaDoc>(CONFIG_META_DOC_ID))!;
            expect(secondMeta.generationId).not.toBe(firstMeta.generationId);

            const err = await b.cs.pull().catch((e) => e);
            expect(err).toMatchObject({ kind: "root-changed" });
            expect(err.message).toMatch(/Join/);
            expect(err.message).not.toMatch(/Create/);
            expect(b.vault.readText(".obsidian/app.json")).toBe(`{"v":1}`);

            await b.cs.join();
            expect((await attachmentOf(b))!.metaFingerprint).not.toBe(before);
            expect(await b.cs.pull()).toBe(1);
            expect(b.vault.readText(".obsidian/app.json")).toBe(`{"v":2}`);
            await a.cs.close();
        });

        /** Rewrite the remote meta as an older build would have written it:
         *  no generation id. */
        async function stripGeneration(dbName: string): Promise<void> {
            const meta = (await remote(dbName).getDoc<ConfigMetaDoc>(CONFIG_META_DOC_ID))!;
            const { generationId, ...old } = meta;
            void generationId;
            await remote(dbName).bulkDocs([old]);
        }

        it("a meta without a generation id (older build) still joins and syncs as before", async () => {
            await seed("cfg-old", { ".obsidian/app.json": `{"old":1}` }, ENC);
            await stripGeneration("cfg-old");

            const b = makeDevice("dev-B", ENC);
            await apply(b, "cfg-old");
            await b.cs.join();
            const fp = (await attachmentOf(b))!.metaFingerprint;
            expect(fp).toMatch(/^sha256:/);
            // Repeated ops against the same old meta never read as a reset.
            expect(await b.cs.pull()).toBe(1);
            expect(await b.cs.pull()).toBe(1);
            expect((await attachmentOf(b))!.metaFingerprint).toBe(fp);
            expect(b.vault.readText(".obsidian/app.json")).toBe(`{"old":1}`);
        });

        it("a record anchored to an older meta: a re-Create (with or without a generation id) is detected", async () => {
            const a = await creator("cfg-old", { ".obsidian/app.json": `{"v":1}` }, ENC);
            await stripGeneration("cfg-old");
            const b = makeDevice("dev-B", ENC);
            await apply(b, "cfg-old");
            await b.cs.join();
            expect(await b.cs.pull()).toBe(1);

            // An older build re-creates it: fresh salt, still no generation id.
            await a.cs.create();
            await stripGeneration("cfg-old");
            await expect(b.cs.pull()).rejects.toMatchObject({ kind: "root-changed" });
            await b.cs.join();
            expect(await b.cs.pull()).toBe(0);

            // This build re-creates it: a generation id appears.
            await a.cs.create();
            await expect(b.cs.pull()).rejects.toMatchObject({ kind: "root-changed" });
            await a.cs.close();
        });
    });

    describe("Create preview (confirm dialog)", () => {
        it("reads the doc count and the meta; reports a missing DB and an unreadable server", async () => {
            await seed("cfg-enc", { ".obsidian/app.json": "{}" }, ENC);
            const b = makeDevice("dev-B");
            await apply(b, "cfg-enc");
            const p = await b.cs.previewCreate();
            expect(p).toMatchObject({
                kind: "read", meta: "present",
                codec: { encryption: true, compression: false, cipherVersion: 3 },
                bindingKey: b.cs.currentBinding()!.key,
            });
            expect(p.kind === "read" && p.docCount).toBeGreaterThan(1);

            await apply(b, "cfg-empty");
            expect(await b.cs.previewCreate()).toEqual({
                kind: "read", docCount: 0, meta: "absent", bindingKey: b.cs.currentBinding()!.key,
            });

            const gone = remote("cfg-gone");
            gone.info = async () => { throw Object.assign(new Error("not_found"), { status: 404 }); };
            await apply(b, "cfg-gone");
            expect(await b.cs.previewCreate()).toEqual({
                kind: "missing", bindingKey: b.cs.currentBinding()!.key,
            });

            const down = remote("cfg-down");
            down.info = async () => { throw new TypeError("Failed to fetch"); };
            await apply(b, "cfg-down");
            expect(await b.cs.previewCreate()).toMatchObject({ kind: "unreadable" });
        });
    });

    describe("Join", () => {
        it("syncs with the codec of config:meta and leaves Step 1 alone (invariant 17)", async () => {
            await seed("cfg-enc", { ".obsidian/app.json": `{"x":1}` }, ENC);
            // B's Step 1 says plaintext + compressed; the meta says encrypted, uncompressed.
            const b = makeDevice("dev-B", {
                configEncryptionEnabled: false,
                configEncryptionPassphrase: PASS,
                configCompressionEnabled: true,
            });
            await apply(b, "cfg-enc");
            await b.cs.join();
            // Step 1 is the next Create's input — Join does not rewrite it.
            expect(b.settings.configEncryptionEnabled).toBe(false);
            expect(b.settings.configCompressionEnabled).toBe(true);
            // The attachment carries the DB's codec, and sync uses it.
            const att = (await attachmentOf(b))!;
            expect(att.codec).toEqual({ encryption: true, compression: false });
            // What the settings tab shows as "differs from the current database".
            expect(sameCodec(att.codec, resolveConfigCodec(b.settings))).toBe(false);
            expect(await b.cs.pull()).toBe(1);
            expect(b.vault.readText(".obsidian/app.json")).toBe(`{"x":1}`);
        });

        it("asks for the passphrase when none is at hand, keeps it on the binding, and leaves Step 1 alone", async () => {
            await seed("cfg-enc", { ".obsidian/app.json": "{}" }, ENC);
            const answers: boolean[] = [];
            const ask = vi.fn<AskConfigPassphrase>(async (_reason, tryUnlock) => {
                // The modal re-asks on a wrong answer: first a typo, then the
                // right one.
                answers.push(await tryUnlock("typo"));
                answers.push(await tryUnlock(PASS));
                return PASS;
            });
            const b = makeDevice("dev-B", {
                configEncryptionEnabled: true, configEncryptionPassphrase: "", encryptionPassphrase: "",
            }, ask);
            await apply(b, "cfg-enc");
            await b.cs.join();
            expect(ask).toHaveBeenCalledTimes(1);
            expect(ask.mock.calls[0][0]).toBe("missing");
            expect(answers).toEqual([false, true]);
            expect(getEntry(b.settings)).toMatchObject({ passphrase: PASS });
            expect(b.settings.configEncryptionPassphrase).toBe("");
            expect(await b.cs.pull()).toBe(1);
        });

        it("tries the binding's passphrase, then Step 1, then the vault's — each once — before asking", async () => {
            await seed("cfg-enc", { ".obsidian/app.json": "{}" }, ENC);
            const ask = vi.fn<AskConfigPassphrase>(async () => null);
            const b = makeDevice("dev-B", {
                configEncryptionEnabled: true, configEncryptionPassphrase: "step1", encryptionPassphrase: PASS,
            }, ask);
            await apply(b, "cfg-enc");
            putEntry(b.settings, { settingUp: false, passphrase: "stale" });
            await b.cs.join();
            const binding = b.cs.currentBinding()!;
            // "stale", "step1", then the vault's: three derivations, no prompt.
            expect(binding.keyDerivations).toBe(3);
            expect(ask).not.toHaveBeenCalled();
            expect(getEntry(b.settings)).toMatchObject({ passphrase: PASS });
            expect(b.settings.configEncryptionPassphrase).toBe("step1");
        });

        it("the same value in two places is tried once; when none matches it asks with 'mismatch'", async () => {
            await seed("cfg-enc", { ".obsidian/app.json": "{}" }, ENC);
            const ask = vi.fn<AskConfigPassphrase>(async (_r, tryUnlock) =>
                (await tryUnlock(PASS)) ? PASS : null);
            const b = makeDevice("dev-B", {
                configEncryptionEnabled: true, configEncryptionPassphrase: "same", encryptionPassphrase: "same",
            }, ask);
            await apply(b, "cfg-enc");
            await b.cs.join();
            expect(ask.mock.calls[0][0]).toBe("mismatch");
            // One derivation for "same", one for the answer.
            expect(b.cs.currentBinding()!.keyDerivations).toBe(2);
        });

        it("cancelling the prompt: 'Join cancelled — nothing was changed', and nothing is", async () => {
            await seed("cfg-enc", { ".obsidian/app.json": "{}" }, ENC);
            const b = makeDevice("dev-B", {
                configEncryptionEnabled: true, configEncryptionPassphrase: "wrong",
            }, async () => null);
            await apply(b, "cfg-enc");
            const store = b.cs.currentStore()!;
            await store.runWriteTx({
                docs: [{ doc: {
                    _id: makeConfigId(".obsidian/local.json"), type: "config",
                    chunks: [], mtime: 1, size: 0, vclock: { "dev-B": 1 },
                } as any }],
            });
            clearLog();
            const err = await b.cs.join().catch((e) => e);
            expect(err).toMatchObject({ name: "AbortError", message: "Join cancelled — nothing was changed." });
            expect(await attachmentOf(b)).toBeNull();
            expect(getEntry(b.settings)).toBeUndefined();
            expect(b.settings.configEncryptionPassphrase).toBe("wrong");
            expect(await store.get(makeConfigId(".obsidian/local.json"))).not.toBeNull();
            // Not an outcome of the relation, and not an error.
            expect(b.cs.currentBinding()!.relation().last).toBeNull();
            const logs = getLogEntries();
            expect(logs.filter((e) => e.level === "error")).toEqual([]);
            expect(logs.some((e) => e.level === "warn"
                && e.message === "Config Join cancelled — nothing was changed.")).toBe(true);
        });

        it("without a passphrase and no prompt: passphrase-missing, nothing recorded", async () => {
            await seed("cfg-enc", { ".obsidian/app.json": "{}" }, ENC);
            const b = makeDevice("dev-B", { configEncryptionEnabled: true, configEncryptionPassphrase: "" });
            await apply(b, "cfg-enc");
            await expect(b.cs.join()).rejects.toMatchObject({ kind: "passphrase-missing" });
            expect(await attachmentOf(b)).toBeNull();
            expect(getEntry(b.settings)).toBeUndefined();
        });

        it("a wrong passphrase and no prompt: passphrase-mismatch, never suggests Create, records nothing, keeps the store", async () => {
            await seed("cfg-enc", { ".obsidian/app.json": "{}" }, ENC);
            const b = makeDevice("dev-B", { ...ENC, configEncryptionPassphrase: "wrong" });
            await apply(b, "cfg-enc");
            const store = b.cs.currentStore()!;
            await store.runWriteTx({
                docs: [{ doc: {
                    _id: makeConfigId(".obsidian/local.json"), type: "config",
                    chunks: [], mtime: 1, size: 0, vclock: { "dev-B": 1 },
                } as any }],
            });
            const err = await b.cs.join().catch((e) => e);
            expect(err).toMatchObject({ kind: "passphrase-mismatch" });
            expect(err.message).toMatch(/Join in Step 3/);
            expect(err.message).not.toMatch(/Create|Init/);
            expect(await attachmentOf(b)).toBeNull();
            expect(getEntry(b.settings)).toBeUndefined();
            // Invariant C: the store is emptied only after the unlock succeeded.
            expect(await store.get(makeConfigId(".obsidian/local.json"))).not.toBeNull();
        });
    });

    describe("preflight classification", () => {
        async function joined(dbName: string, over: Partial<CouchSyncSettings> = ENC): Promise<Device> {
            const b = makeDevice("dev-B", over);
            await apply(b, dbName);
            await b.cs.join();
            return b;
        }

        it("uninitialized: an empty DB (no meta, no docs) — Join and Pull recommend Create", async () => {
            const b = makeDevice("dev-B");
            await apply(b, "cfg-empty");
            await expect(b.cs.join()).rejects.toMatchObject({
                kind: "uninitialized", message: expect.stringMatching(/run Create in Step 3/),
            });
        });

        it("meta-missing: docs but no meta — the message names how many Create would delete", async () => {
            await remote("cfg-legacy").bulkDocs([
                { _id: "config:.obsidian/a.json", type: "config" },
                { _id: "config:.obsidian/b.json", type: "config" },
            ]);
            const b = makeDevice("dev-B");
            await apply(b, "cfg-legacy");
            const err = await b.cs.join().catch((e) => e);
            expect(err).toMatchObject({ kind: "meta-missing" });
            expect(err.message).toMatch(/2 document\(s\)/);
        });

        it("legacy-meta: schemaVersion 1", async () => {
            await remote("cfg-v1").bulkDocs([{
                _id: CONFIG_META_DOC_ID, type: "config-meta", schemaVersion: 1,
                encryption: { enabled: false }, compression: { enabled: false },
            }]);
            const b = makeDevice("dev-B");
            await apply(b, "cfg-v1");
            const err = await b.cs.join().catch((e) => e);
            expect(err).toMatchObject({ kind: "legacy-meta" });
            expect(err.message).toMatch(/Create in Step 3/);
            expect(err.message).toMatch(/Join again/);
        });

        it("db-missing: the probe's 404", async () => {
            const gone = remote("cfg-gone");
            gone.info = async () => { throw Object.assign(new Error("not_found"), { status: 404 }); };
            const b = makeDevice("dev-B");
            await apply(b, "cfg-gone");
            await putAttachment(b.cs.currentStore()!, {
                codec: { encryption: false, compression: false }, metaFingerprint: "sha256:00",
            });
            await expect(b.cs.pull()).rejects.toMatchObject({
                kind: "db-missing", message: expect.stringMatching(/run Create in Step 3/),
            });
        });

        it("the meta vanished after joining: uninitialized", async () => {
            await seed("cfg-enc", { ".obsidian/app.json": "{}" }, ENC);
            const b = await joined("cfg-enc");
            await remote("cfg-enc").destroy();
            await expect(b.cs.pull()).rejects.toMatchObject({ kind: "uninitialized" });
        });

        it("Step 1 is not the key after joining: changing or clearing it does not stop sync", async () => {
            await seed("cfg-enc", { ".obsidian/app.json": "{}" }, ENC);
            const b = await joined("cfg-enc");
            b.settings.configEncryptionPassphrase = "a-different-one";
            expect(await b.cs.pull()).toBe(1);
            b.settings.configEncryptionPassphrase = "";
            expect(await b.cs.pull()).toBe(1);
        });

        it("passphrase-mismatch after joining (the binding's passphrase no longer unlocks): Join, never Create", async () => {
            await seed("cfg-enc", { ".obsidian/app.json": "{}" }, ENC);
            const b = await joined("cfg-enc");
            putEntry(b.settings, { ...getEntry(b.settings)!, passphrase: "a-different-one" });
            const err = await b.cs.pull().catch((e) => e);
            expect(err).toMatchObject({ kind: "passphrase-mismatch" });
            expect(err.message).toMatch(/Join in Step 3/);
            expect(err.message).not.toMatch(/Create/);
        });

        it("passphrase-missing after joining: points to Join, which recovers from the values at hand", async () => {
            await seed("cfg-enc", { ".obsidian/app.json": "{}" }, ENC);
            const b = await joined("cfg-enc");
            // A device that joined before passphrases were kept per binding:
            // the entry has none, Step 1 holds the one it synced with.
            const { passphrase: _drop, ...rest } = getEntry(b.settings)!;
            putEntry(b.settings, rest);
            const err = await b.cs.pull().catch((e) => e);
            expect(err).toMatchObject({ kind: "passphrase-missing" });
            expect(err.message).toMatch(/Join in Step 3/);
            expect(err.message).not.toMatch(/Create|Init/);
            await b.cs.join();
            expect(getEntry(b.settings)).toMatchObject({ passphrase: PASS });
            expect(await b.cs.pull()).toBe(1);
        });

        it("cipher-downgrade: a server-lowered cipherVersion is refused below the floor", async () => {
            await seed("cfg-enc", { ".obsidian/app.json": "{}" }, ENC);
            const b = await joined("cfg-enc");
            expect(getEntry(b.settings)!.cipherFloor).toBe(3);
            const meta = (await remote("cfg-enc").getDoc<ConfigMetaDoc>(CONFIG_META_DOC_ID))!;
            await remote("cfg-enc").bulkDocs([{
                ...meta, encryption: { ...meta.encryption, cipherVersion: 2 },
            }]);
            const err = await b.cs.pull().catch((e) => e);
            expect(err).toMatchObject({ kind: "cipher-downgrade" });
            expect(err.message).not.toMatch(/Create/);
            expect(b.cs.currentBinding()!.relation().last).toMatchObject({
                op: "pull", error: { kind: "cipher-downgrade" },
            });
        });
    });

    describe("Step 1 / vault codec changes never stop sync — after Create AND after Join (#config-codec)", () => {
        it("after Create: Step 1 flipped, Push still succeeds with the created codec", async () => {
            const a = await creator("cfg-A", { ".obsidian/app.json": "{}" });
            a.settings.configCompressionEnabled = true;
            a.settings.configEncryptionEnabled = true;
            a.settings.configEncryptionPassphrase = "unused";
            a.vault.addFile(".obsidian/app.json", `{"v":2}`);
            expect(await a.cs.push()).toBe(1);
            // Another device reads it with the DB's (plaintext) codec.
            const b = makeDevice("dev-B");
            await apply(b, "cfg-A");
            await b.cs.join();
            expect(await b.cs.pull()).toBe(1);
            expect(b.vault.readText(".obsidian/app.json")).toBe(`{"v":2}`);
            await a.cs.close();
        });

        it("after Join: Step 1 flipped, Pull still succeeds", async () => {
            const a = await creator("cfg-A", { ".obsidian/app.json": `{"v":1}` });
            const b = makeDevice("dev-B");
            await apply(b, "cfg-A");
            await b.cs.join();
            expect(await b.cs.pull()).toBe(1);
            b.settings.configCompressionEnabled = true;
            a.vault.addFile(".obsidian/app.json", `{"v":2}`);
            await a.cs.push();
            expect(await b.cs.pull()).toBe(1);
            expect(b.vault.readText(".obsidian/app.json")).toBe(`{"v":2}`);
            await a.cs.close();
        });

        it("a Vault Clone that changes the inherited codec does not stop config Pull", async () => {
            // Config inherits the vault codec (no config overrides): plaintext,
            // uncompressed at Join time.
            const a = await creator("cfg-A", { ".obsidian/app.json": `{"v":1}` });
            const b = makeDevice("dev-B");
            expect(b.settings.configEncryptionEnabled).toBeUndefined();
            expect(b.settings.configCompressionEnabled).toBeUndefined();
            await apply(b, "cfg-A");
            await b.cs.join();
            expect(await b.cs.pull()).toBe(1);

            // B then Clones an encrypted, compressed VAULT: the vault codec —
            // which config's Step 1 inherits — changes under the config DB.
            b.settings.encryptionEnabled = true;
            b.settings.encryptionPassphrase = "vault-pass";
            b.settings.compressionEnabled = true;
            expect(sameCodec(
                (await attachmentOf(b))!.codec, resolveConfigCodec(b.settings),
            )).toBe(false);

            a.vault.addFile(".obsidian/app.json", `{"v":2}`);
            await a.cs.push();
            // Config Pull keeps going with the joined codec — no codec-changed,
            // no advice to Create.
            expect(await b.cs.pull()).toBe(1);
            expect(b.vault.readText(".obsidian/app.json")).toBe(`{"v":2}`);
            b.vault.addFile(".obsidian/hotkeys.json", `{"b":1}`);
            expect(await b.cs.push()).toBe(1);
            await a.cs.close();
        });
    });

    describe("the setup flag is per binding (#err-9)", () => {
        it("an interrupted Create on A blocks A only; B syncs", async () => {
            await seed("cfg-A", { ".obsidian/app.json": `{"a":1}` });
            await seed("cfg-B", { ".obsidian/app.json": `{"b":1}` });
            const dev = makeDevice("dev-X");
            await apply(dev, "cfg-B");
            await dev.cs.join();
            putEntry(dev.settings, { settingUp: true }, "cfg-A");

            expect(await dev.cs.pull()).toBe(1);
            expect(dev.vault.readText(".obsidian/app.json")).toBe(`{"b":1}`);

            await apply(dev, "cfg-A");
            await expect(dev.cs.pull()).rejects.toMatchObject({
                kind: "setup-interrupted", message: expect.stringMatching(/run Create in Step 3/),
            });
        });

        it("a Create that dies after the wipe leaves only its own binding flagged", async () => {
            const dev = makeDevice("dev-X");
            await apply(dev, "cfg-A");
            vi.spyOn(remote("cfg-A"), "bulkDocs").mockRejectedValueOnce(new Error("network down"));
            await expect(dev.cs.create()).rejects.toThrow(/network down/);
            expect(getEntry(dev.settings, "cfg-A")).toMatchObject({ settingUp: true });
            expect(getEntry(dev.settings, "cfg-B")).toBeUndefined();
            // The wipe emptied the store: no attachment either.
            expect(await attachmentOf(dev)).toBeNull();
            // The failure is recorded; the status line shows the unfinished
            // Create first (the setup flag), which is what the user must fix.
            expect(dev.cs.currentBinding()!.relation()).toMatchObject({
                settingUp: true, attachment: null,
                last: { op: "create", error: { message: "network down" } },
            });
        });
    });

    describe("filter tree listing", () => {
        it("encrypted DB: not listed (nor contacted) before Join, decrypted paths after", async () => {
            await seed("cfg-enc", { ".obsidian/app.json": "{}", ".obsidian/hotkeys.json": "{}" }, ENC);
            const b = makeDevice("dev-B", ENC);
            await apply(b, "cfg-enc");

            const getDoc = vi.spyOn(remote("cfg-enc"), "getDoc");
            const before = await b.cs.listRemoteConfigPathsQuiet();
            expect(before).toMatchObject({ paths: [], ok: false });
            expect(getDoc).not.toHaveBeenCalled();

            await b.cs.join();
            const after = await b.cs.listRemoteConfigPathsQuiet();
            expect(after.ok).toBe(true);
            expect(after.paths.sort()).toEqual([".obsidian/app.json", ".obsidian/hotkeys.json"]);
            expect(b.cs.currentBinding()!.relation().last).toMatchObject({ op: "check", error: null });
        });
    });

    describe("switching A → B → A", () => {
        const A_FILES = {
            ".obsidian/app.json": `{"from":"A"}`,
            ".obsidian/appearance.json": `{"a":1}`,
            ".obsidian/hotkeys.json": `{"a":2}`,
            ".obsidian/snippets/a.css": "a{}",
        };

        it("B never sees A's store, checkpoint, lastSynced, key or attachment; back on A, A's store is reused", async () => {
            // A's remote carries more history (higher seq) than B's, so
            // reusing A's pull cursor on B would skip B's only doc.
            await seed("cfg-A", A_FILES);
            await seed("cfg-B", { ".obsidian/snippets/b.css": "body{}" });

            const dev = makeDevice("dev-X");
            await apply(dev, "cfg-A");
            await dev.cs.join();
            expect(await dev.cs.pull()).toBe(4);
            const bindingA = dev.cs.currentBinding()!;
            const storeA = dev.cs.currentStore()!;
            const pullSeqA = bindingA.checkpoints.getPullSeq();
            expect(Number(pullSeqA)).toBeGreaterThan(1);
            await dev.cs.scan(); // populate A's lastSynced from disk
            expect(bindingA.lastSynced.get(".obsidian/app.json")).toBeDefined();

            // ── A → B ──
            await apply(dev, "cfg-B");
            const bindingB = dev.cs.currentBinding()!;
            expect(bindingB).not.toBe(bindingA);
            expect(bindingB.dbName).toBe("cfg-B");
            // Attachment: A's does not attach B.
            expect(bindingB.attachment).toBeNull();
            await expect(dev.cs.pull()).rejects.toMatchObject({ kind: "unattached" });
            // Store: a different IndexedDB store, empty of A's docs.
            expect(dev.cs.currentStore()).not.toBe(storeA);
            expect(opened.filter((o) => o.store === dev.cs.currentStore())[0].name)
                .not.toBe(opened.filter((o) => o.store === storeA)[0].name);
            expect(await dev.cs.currentStore()!.get(makeConfigId(".obsidian/app.json"))).toBeNull();
            // A's binding (and its key memo) is closed.
            expect(bindingA.isClosed()).toBe(true);
            // lastSynced: B's cache knows nothing of A's paths.
            expect(bindingB.lastSynced.get(".obsidian/app.json")).toBeUndefined();
            // Checkpoint: B starts from its own cursor, so its single doc arrives.
            await dev.cs.join();
            await bindingB.ensureCheckpointsLoaded();
            expect(bindingB.checkpoints.getPullSeq()).toBe(0);
            expect(await dev.cs.pull()).toBeGreaterThanOrEqual(1);
            expect(dev.vault.readText(".obsidian/snippets/b.css")).toBe("body{}");

            // ── B → A ──
            await apply(dev, "cfg-A");
            const bindingA2 = dev.cs.currentBinding()!;
            expect(bindingA2).not.toBe(bindingA);
            // A's attachment (in A's store) still attaches A — no second Join.
            expect(bindingA2.attachment).not.toBeNull();
            // Same IndexedDB store as before (name identity), with A's docs and cursor.
            const nameA = opened.find((o) => o.store === storeA)!.name;
            expect(opened.find((o) => o.store === dev.cs.currentStore())!.name).toBe(nameA);
            expect(await dev.cs.currentStore()!.get(makeConfigId(".obsidian/app.json"))).not.toBeNull();
            await bindingA2.ensureCheckpointsLoaded();
            expect(bindingA2.checkpoints.getPullSeq()).toBe(pullSeqA);
            // And A pulls cleanly from its own cursor (nothing new).
            expect(await dev.cs.pull()).toBeGreaterThanOrEqual(0);
        });

        it("rebinding to the current name is a no-op (binding and key kept)", async () => {
            await seed("cfg-enc", { ".obsidian/app.json": "{}" }, ENC);
            const dev = makeDevice("dev-X", ENC);
            await apply(dev, "cfg-enc");
            await dev.cs.join();
            const binding = dev.cs.currentBinding()!;
            expect(binding.keyDerivations).toBe(1);
            await apply(dev, "cfg-enc");
            expect(dev.cs.currentBinding()).toBe(binding);
            // The unlocked key survives: no second PBKDF2.
            expect(await dev.cs.pull()).toBe(1);
            expect(binding.keyDerivations).toBe(1);
        });
    });

    describe("rebind vs a running op", () => {
        it("is refused while an op is in flight, and the op keeps its store", async () => {
            await seed("cfg-A", { ".obsidian/app.json": "{}" });
            const dev = makeDevice("dev-X");
            await apply(dev, "cfg-A");
            await dev.cs.join();
            const storeA = dev.cs.currentStore();

            remote("cfg-A").park();
            const running = dev.cs.pull();
            await vi.waitFor(() => expect(remote("cfg-A").parked).toBe(true));

            await expect(dev.cs.rebind("cfg-B")).rejects.toMatchObject({
                name: "ConfigNotReadyError",
                kind: "busy",
            });
            await expect(dev.cs.rebind(null)).rejects.toMatchObject({ kind: "busy" });
            // Local maintenance (GC, Delete local config DB) is refused too.
            const task = vi.fn(async () => 1);
            await expect(dev.cs.runExclusive(task)).rejects.toMatchObject({ kind: "busy" });
            expect(task).not.toHaveBeenCalled();
            expect(dev.cs.currentStore()).toBe(storeA);
            expect(dev.cs.currentBinding()!.isClosed()).toBe(false);

            remote("cfg-A").unpark();
            expect(await running).toBe(1);

            // Once idle the switch goes through.
            expect(await dev.cs.runExclusive(task)).toBe(1);
            await dev.cs.rebind("cfg-B");
            expect(dev.cs.currentBinding()!.dbName).toBe("cfg-B");
        });

        it("an op started while a rebind is switching stores is refused as busy", async () => {
            const dev = makeDevice("dev-X");
            const switching = dev.cs.rebind("cfg-A");
            await expect(dev.cs.pull()).rejects.toMatchObject({ kind: "busy" });
            await expect(dev.cs.rebind("cfg-B")).rejects.toMatchObject({ kind: "busy" });
            await switching;
            expect(dev.cs.currentBinding()!.dbName).toBe("cfg-A");
        });

        it("an op started while a local maintenance task runs is refused as busy", async () => {
            await seed("cfg-A", { ".obsidian/app.json": "{}" });
            const dev = makeDevice("dev-X");
            await apply(dev, "cfg-A");
            let release!: () => void;
            const held = dev.cs.runExclusive(() => new Promise<void>((r) => { release = r; }));
            await expect(dev.cs.join()).rejects.toMatchObject({ kind: "busy" });
            release();
            await held;
            await dev.cs.join();
        });
    });
    describe("switching servers X → Y → X", () => {
        const X = "http://x.example:5984";
        const Y = "http://y.example:5984";

        it("no loss and no mixing: each server keeps its own store, cursor and attachment", async () => {
            // Same DB name on both servers. Y carries more history (higher
            // seq), so reusing Y's pull cursor on X would skip X's changes.
            const ax = await creator("cfg", { ".obsidian/app.json": `{"x":1}` }, { couchdbUri: X });
            await seed("cfg", {
                ".obsidian/appearance.json": `{"y":1}`,
                ".obsidian/hotkeys.json": `{"y":2}`,
                ".obsidian/snippets/y.css": "y{}",
                ".obsidian/snippets/y2.css": "y2{}",
            }, { couchdbUri: Y });

            const dev = makeDevice("dev", { couchdbUri: X });
            await apply(dev, "cfg");
            await dev.cs.join();
            expect(await dev.cs.pull()).toBe(1);
            const storeX = dev.cs.currentStore()!;
            const nameX = opened.find((o) => o.store === storeX)!.name;

            // ── X → Y: the server is changed in the CouchDB tab.
            expect(await applyServer(dev, Y)).toEqual({ kind: "saved" });
            expect(dev.settings.couchdbUri).toBe(Y);
            await expect(dev.cs.pull()).rejects.toMatchObject({ kind: "unattached" });
            const storeY = dev.cs.currentStore()!;
            expect(storeY).not.toBe(storeX);
            expect(opened.find((o) => o.store === storeY)!.name).not.toBe(nameX);
            await dev.cs.join();
            expect(await dev.cs.pull()).toBe(4);
            expect(dev.vault.readText(".obsidian/snippets/y.css")).toBe("y{}");

            // Meanwhile another device changes X.
            ax.vault.addFile(".obsidian/snippets/x.css", "x{}");
            expect(await ax.cs.push()).toBe(1);

            // ── Y → X.
            expect(await applyServer(dev, X)).toEqual({ kind: "saved" });
            const storeX2 = dev.cs.currentStore()!;
            expect(opened.find((o) => o.store === storeX2)!.name).toBe(nameX);
            // X's attachment is in X's store: no second Join.
            expect(dev.cs.currentBinding()!.attachment).not.toBeNull();
            // Remove Y's files locally: a Pull from X must not bring them back.
            await dev.vault.delete(".obsidian/snippets/y.css");
            await dev.vault.delete(".obsidian/snippets/y2.css");

            // Nothing of X is skipped, and nothing of Y is written.
            expect(await dev.cs.pull()).toBe(2);
            expect(dev.vault.readText(".obsidian/snippets/x.css")).toBe("x{}");
            expect(dev.vault.readText(".obsidian/app.json")).toBe(`{"x":1}`);
            expect(await dev.vault.exists(".obsidian/snippets/y.css")).toBe(false);
            expect(await dev.vault.exists(".obsidian/snippets/y2.css")).toBe(false);
            expect(await storeX2.get(makeConfigId(".obsidian/snippets/y.css"))).toBeNull();
            await ax.cs.close();
        });

        it("the server a binding talks to is the one it was opened for", async () => {
            await seed("cfg", { ".obsidian/app.json": `{"x":1}` }, { couchdbUri: X });
            const dev = makeDevice("dev", { couchdbUri: X });
            await apply(dev, "cfg");
            const bindingX = dev.cs.currentBinding()!;
            expect(bindingX.serverUri).toBe(X);
            // The server Apply replaces the binding: X's is closed, never
            // pointed at Y, and the new one talks to Y.
            await applyServer(dev, Y);
            expect(bindingX.isClosed()).toBe(true);
            expect(dev.cs.currentBinding()!.serverUri).toBe(Y);
            await expect(dev.cs.join()).rejects.toMatchObject({ kind: "uninitialized" });
        });
    });

    describe("an op's keys are fixed for its run (filter tree vs a running Push)", () => {
        it("the tree does not list, change the key or flip the hasher while a Push runs", async () => {
            await seed("cfg-enc", { ".obsidian/app.json": "{}" }, ENC);
            const b = makeDevice("dev-B", ENC);
            await apply(b, "cfg-enc");
            await b.cs.join();
            b.vault.addFile(".obsidian/appearance.json", `{"b":1}`);
            b.vault.addFile(".obsidian/hotkeys.json", `{"b":2}`);

            // Park the Push inside its scan — after the preflight froze its keys.
            let release!: () => void;
            const gate = new Promise<void>((r) => { release = r; });
            let parked = false;
            const orig = b.vault.readBinary.bind(b.vault);
            b.vault.readBinary = async (path: string) => {
                if (!parked) { parked = true; await gate; }
                return orig(path);
            };
            const running = b.cs.push();
            await vi.waitFor(() => expect(parked).toBe(true));
            const binding = b.cs.currentBinding()!;

            // A wrong passphrase now. The tree used to run a preflight outside
            // the op lock and drop the key on failure — mid-scan.
            putEntry(b.settings, { ...getEntry(b.settings)!, passphrase: "wrong" });
            const getDoc = vi.spyOn(remote("cfg-enc"), "getDoc");
            const lastBefore = binding.relation().last;
            const listing = await b.cs.listRemoteConfigPathsQuiet();
            expect(listing).toMatchObject({ paths: [], ok: false });
            expect(getDoc).not.toHaveBeenCalled();
            // Even the read-only check, failing, leaves the binding alone.
            await expect(binding.inspect(remote("cfg-enc"))).rejects.toMatchObject({
                kind: "passphrase-mismatch",
            });
            expect(binding.relation().last).toBe(lastBefore);

            release();
            expect(await running).toBe(2);
            // Every chunk this Push minted is an HMAC id — none in the
            // plaintext xxhash space, which would leak content hashes.
            const store = b.cs.currentStore()!;
            const x64 = await store.allDocs({ startkey: "chunk:x64:", endkey: "chunk:x64:\ufff0" });
            const hmac = await store.allDocs({ startkey: "chunk:hmac:", endkey: "chunk:hmac:\ufff0" });
            expect(x64.rows).toEqual([]);
            expect(hmac.rows.length).toBeGreaterThan(0);
        });
    });

    describe("an encrypted root that turned plaintext", () => {
        /** A Creates encrypted; B joins and pulls; A re-creates it PLAINTEXT. */
        async function decrypted(): Promise<{ a: Device; b: Device }> {
            const a = await creator("cfg-enc", { ".obsidian/app.json": `{"v":1}` }, ENC);
            const b = makeDevice("dev-B", ENC);
            await apply(b, "cfg-enc");
            await b.cs.join();
            expect(await b.cs.pull()).toBe(1);
            a.settings.configEncryptionEnabled = false;
            a.vault.addFile(".obsidian/app.json", `{"v":2}`);
            await a.cs.create();
            await a.cs.push();
            return { a, b };
        }

        it("is encryption-removed, not root-changed: verify the server, then Join — never Create", async () => {
            const { a, b } = await decrypted();
            const err = await b.cs.pull().catch((e) => e);
            expect(err).toMatchObject({ kind: "encryption-removed" });
            expect(err.message).toMatch(/verify the server/);
            expect(err.message).toMatch(/Join/);
            expect(err.message).not.toMatch(/Create/);
            expect(b.vault.readText(".obsidian/app.json")).toBe(`{"v":1}`);
            await a.cs.close();
        });

        it("Join asks first; cancelling changes nothing", async () => {
            const { a, b } = await decrypted();
            const store = b.cs.currentStore()!;
            const attBefore = await attachmentOf(b);
            const entryBefore = structuredClone(getEntry(b.settings));
            b.modal.confirmResponses = [false];

            await expect(b.cs.join()).rejects.toMatchObject({ name: "AbortError" });
            expect(b.modal.confirmCalls).toHaveLength(1);
            expect(b.modal.confirmCalls[0].title).toMatch(/unencrypted/);
            // Nothing moved: attachment, floor, store contents.
            expect(await attachmentOf(b)).toEqual(attBefore);
            expect(getEntry(b.settings)).toEqual(entryBefore);
            expect(await store.get(makeConfigId(".obsidian/app.json"))).not.toBeNull();
            await expect(b.cs.pull()).rejects.toMatchObject({ kind: "encryption-removed" });
            await a.cs.close();
        });

        it("Join, confirmed, adopts the plaintext root and syncs", async () => {
            const { a, b } = await decrypted();
            b.modal.confirmResponses = [true];
            await b.cs.join();
            expect((await attachmentOf(b))!.codec).toEqual({ encryption: false, compression: false });
            // The floor follows the joined root (none for plaintext).
            expect(getEntry(b.settings)).toEqual({ settingUp: false });
            expect(await b.cs.pull()).toBe(1);
            expect(b.vault.readText(".obsidian/app.json")).toBe(`{"v":2}`);
            await a.cs.close();
        });

        it("the floor outlives the local store: after deleting it, Join still asks", async () => {
            const { a, b } = await decrypted();
            // Maintenance → Delete local config database, then a restart.
            await b.cs.runExclusive((binding) => binding.store.destroy());
            await b.cs.close();
            const b2 = makeDevice("dev-B", {}, undefined, b);
            await b2.cs.rebind("cfg-enc");
            expect(await attachmentOf(b2)).toBeNull();
            await expect(b2.cs.pull()).rejects.toMatchObject({ kind: "unattached" });
            expect(getEntry(b2.settings)!.cipherFloor).toBe(3);

            b2.modal.confirmResponses = [false];
            await expect(b2.cs.join()).rejects.toMatchObject({ name: "AbortError" });
            expect(b2.modal.confirmCalls).toHaveLength(1);
            expect(await attachmentOf(b2)).toBeNull();
            await a.cs.close();
        });

        it("a cipherVersion below the floor: Join asks too, and a cancel keeps the floor", async () => {
            await seed("cfg-enc", { ".obsidian/app.json": "{}" }, ENC);
            const b = makeDevice("dev-B", ENC);
            await apply(b, "cfg-enc");
            await b.cs.join();
            const meta = (await remote("cfg-enc").getDoc<ConfigMetaDoc>(CONFIG_META_DOC_ID))!;
            await remote("cfg-enc").bulkDocs([{
                ...meta, encryption: { ...meta.encryption, cipherVersion: 2 },
            }]);
            b.modal.confirmResponses = [false];
            await expect(b.cs.join()).rejects.toMatchObject({ name: "AbortError" });
            expect(b.modal.confirmCalls[0].title).toMatch(/older cipher/);
            expect(getEntry(b.settings)!.cipherFloor).toBe(3);
        });
    });

    // The scenarios that broke while the passphrase was re-resolved on every
    // op and the server Apply was saved outside the rebind.
    describe("the passphrase belongs to the binding, and is resolved once at Create / Join", () => {
        /** Config inherits the vault codec and passphrase (no overrides). */
        const VAULT_ENC = { encryptionEnabled: true, encryptionPassphrase: "P" } as const;

        it("Join with the inherited vault passphrase keeps it on the binding; vault E2E off or a new vault passphrase does not stop Pull", async () => {
            const a = await creator("cfg", { ".obsidian/app.json": `{"v":1}` }, VAULT_ENC);
            // Create kept the (inherited) passphrase it encrypted with, and
            // left Step 1 alone.
            expect(getEntry(a.settings)).toMatchObject({ passphrase: "P" });
            expect(a.settings.configEncryptionPassphrase).toBeUndefined();
            const b = makeDevice("dev-B", VAULT_ENC);
            await apply(b, "cfg");
            await b.cs.join();
            expect(getEntry(b.settings)).toMatchObject({ passphrase: "P" });
            expect(b.settings.configEncryptionPassphrase).toBeUndefined();
            expect(await b.cs.pull()).toBe(1);

            // Vault Sync: E2E toggled off (the tab clears the vault passphrase).
            b.settings.encryptionEnabled = false;
            b.settings.encryptionPassphrase = "";
            a.vault.addFile(".obsidian/app.json", `{"v":2}`);
            expect(await a.cs.push()).toBe(1);
            expect(await b.cs.pull()).toBe(1);
            expect(b.vault.readText(".obsidian/app.json")).toBe(`{"v":2}`);

            // Vault re-Init with another passphrase.
            b.settings.encryptionEnabled = true;
            b.settings.encryptionPassphrase = "Q";
            a.vault.addFile(".obsidian/app.json", `{"v":3}`);
            expect(await a.cs.push()).toBe(1);
            expect(await b.cs.pull()).toBe(1);
            expect(b.vault.readText(".obsidian/app.json")).toBe(`{"v":3}`);
            expect(getEntry(b.settings)).toMatchObject({ passphrase: "P" });
            await a.cs.close();
        });

        it("a plaintext DB: Join and Create keep no passphrase", async () => {
            const a = await creator("cfg-plain", { ".obsidian/app.json": "{}" }, {
                encryptionPassphrase: "vault-only",
            });
            expect(getEntry(a.settings)?.passphrase).toBeUndefined();
            expect(a.settings.configEncryptionPassphrase).toBeUndefined();
            const b = makeDevice("dev-B", { encryptionPassphrase: "vault-only" });
            await apply(b, "cfg-plain");
            await b.cs.join();
            expect(getEntry(b.settings)?.passphrase).toBeUndefined();
            expect(b.settings.configEncryptionPassphrase).toBeUndefined();
            expect(await b.cs.pull()).toBe(1);
            await a.cs.close();
        });

        it("the passphrase is saved in the same settings save as the entry, before the attachment commit", async () => {
            await seed("cfg", { ".obsidian/app.json": "{}" }, VAULT_ENC);
            const b = makeDevice("dev-B", VAULT_ENC);
            await apply(b, "cfg");
            const store = b.cs.currentStore()!;
            const writeTx = vi.spyOn(store, "runWriteTx").mockRejectedValueOnce(new Error("disk full"));
            await expect(b.cs.join()).rejects.toThrow(/disk full/);
            expect(writeTx).toHaveBeenCalled();
            // Settings committed first (passphrase + floor), attachment not:
            // Unattached, and a second Join needs no prompt.
            expect(getEntry(b.settings)).toEqual({ cipherFloor: 3, settingUp: false, passphrase: "P" });
            expect(await attachmentOf(b)).toBeNull();
            await b.cs.join();
            expect(await b.cs.pull()).toBe(1);
        });

        it("an encrypting Create with no passphrase at all stops before anything is destroyed, and says Step 1", async () => {
            await seed("cfg", { ".obsidian/app.json": "{}" });
            const a = makeDevice("dev-A", {
                configEncryptionEnabled: true, configEncryptionPassphrase: "", encryptionPassphrase: "",
            });
            await apply(a, "cfg");
            const destroy = vi.spyOn(remote("cfg"), "destroy");
            const err = await a.cs.create().catch((e) => e);
            expect(err).toMatchObject({ kind: "create-passphrase-missing" });
            expect(err.message).toMatch(/Step 1/);
            expect(destroy).not.toHaveBeenCalled();
            expect(getEntry(a.settings)).toBeUndefined();
        });

        it("two DBs with different passphrases: switching between them keeps each one's passphrase", async () => {
            await seed("cfg-one", { ".obsidian/app.json": `{"db":1}` }, {
                configEncryptionEnabled: true, configEncryptionPassphrase: "one",
            });
            await seed("cfg-two", { ".obsidian/app.json": `{"db":2}` }, {
                configEncryptionEnabled: true, configEncryptionPassphrase: "two",
            });
            const answers: Record<string, string> = { "cfg-one": "one", "cfg-two": "two" };
            const asked: string[] = [];
            const d: Device = makeDevice("dev", { configEncryptionEnabled: true }, async (_r, tryUnlock) => {
                const db = d.settings.couchdbConfigDbName;
                asked.push(db);
                return (await tryUnlock(answers[db])) ? answers[db] : null;
            });

            await apply(d, "cfg-one");
            await d.cs.join();
            await apply(d, "cfg-two");
            await d.cs.join();
            expect(asked).toEqual(["cfg-one", "cfg-two"]);
            expect(getEntry(d.settings, "cfg-one")).toMatchObject({ passphrase: "one" });
            expect(getEntry(d.settings, "cfg-two")).toMatchObject({ passphrase: "two" });

            // Back and forth: each DB still unlocks with its own passphrase,
            // with no prompt.
            for (const db of ["cfg-one", "cfg-two", "cfg-one"]) {
                await apply(d, db);
                expect(await d.cs.pull()).toBe(1);
                expect(d.vault.readText(".obsidian/app.json")).toBe(`{"db":${db === "cfg-one" ? 1 : 2}}`);
            }
            expect(asked).toEqual(["cfg-one", "cfg-two"]);
        });
    });

    describe("a server Apply while a config op runs", () => {
        const X = "http://x.example:5984";
        const Y = "http://y.example:5984";

        it("refused and nothing saved; Create's preview and Create both hit the server the settings name", async () => {
            // Y holds a shared config DB.
            const y = await creator("cfg", {
                ".obsidian/app.json": "{}", ".obsidian/hotkeys.json": "{}",
            }, { couchdbUri: Y });
            const yCount = (await remote("cfg", Y).info()).doc_count;
            expect(yCount).toBeGreaterThan(1);

            // This device is on X (an empty DB) and runs a Join there.
            const d = makeDevice("dev", { couchdbUri: X });
            await apply(d, "cfg");
            await remote("cfg", X).ensureDb();
            remote("cfg", X).park();
            const running = d.cs.join().catch(() => {});
            await vi.waitFor(() => expect(remote("cfg", X).parked).toBe(true));

            // The CouchDB tab's Apply is disabled, with the reason...
            expect(d.cs.bindingChangeBlocker()).toMatch(/config operation is running/);
            // ...and one that gets through anyway changes nothing.
            expect(await applyServer(d, Y)).toEqual({ kind: "refused-busy" });
            expect(d.settings.couchdbUri).toBe(X);
            remote("cfg", X).unpark();
            await running;
            expect(d.cs.bindingChangeBlocker()).toBeNull();

            // Settings and binding agree on X: the preview reads X, and
            // Create wipes X — the DB the dialog described. Y is untouched.
            const preview = await d.cs.previewCreate();
            expect(preview).toMatchObject({
                kind: "read", docCount: 0, bindingKey: d.cs.currentBinding()!.key,
            });
            expect(d.cs.currentBinding()!.serverUri).toBe(X);
            await d.cs.create();
            expect((await remote("cfg", Y).info()).doc_count).toBe(yCount);
            expect((await remote("cfg", X).info()).doc_count).toBe(1); // X's new meta

            // Once idle, the same Apply goes through and moves both.
            expect(await applyServer(d, Y)).toEqual({ kind: "saved" });
            expect(d.settings.couchdbUri).toBe(Y);
            expect(d.cs.currentBinding()!.serverUri).toBe(Y);
            expect(await d.cs.previewCreate()).toMatchObject({ kind: "read", docCount: yCount });
            await y.cs.close();
        });

        it("the filter tree lists the server the settings name, and a listing read for a replaced binding is marked", async () => {
            await seed("cfg", { ".obsidian/app.json": "{}" }, { couchdbUri: X });
            await seed("cfg", { ".obsidian/hotkeys.json": "{}" }, { couchdbUri: Y });
            const d = makeDevice("dev", { couchdbUri: X });
            await apply(d, "cfg");
            await d.cs.join();

            remote("cfg", X).park();
            const running = d.cs.pull().catch(() => {});
            await vi.waitFor(() => expect(remote("cfg", X).parked).toBe(true));
            expect(await applyServer(d, Y)).toEqual({ kind: "refused-busy" });
            remote("cfg", X).unpark();
            await running;

            const listing = await d.cs.listRemoteConfigPathsQuiet();
            expect(d.settings.couchdbUri).toBe(X);
            expect(listing).toEqual({
                paths: [".obsidian/app.json"], ok: true,
                bindingKey: d.cs.currentBinding()!.key,
            });

            // A listing in flight while the server Apply goes through names
            // the binding it read — the tab drops it (bindingKey ≠ current).
            const before = d.cs.currentBinding()!.key;
            const pending = d.cs.listRemoteConfigPathsQuiet();
            expect(await applyServer(d, Y)).toEqual({ kind: "saved" });
            const stale = await pending;
            expect(stale.bindingKey).toBe(before);
            expect(d.cs.currentBinding()!.key).not.toBe(before);
        });

        it("a DB-name Apply refused as busy saves nothing either", async () => {
            await seed("cfg-A", { ".obsidian/app.json": "{}" });
            const d = makeDevice("dev");
            await apply(d, "cfg-A");
            await d.cs.join();
            remote("cfg-A").park();
            const running = d.cs.pull().catch(() => {});
            await vi.waitFor(() => expect(remote("cfg-A").parked).toBe(true));
            const commit = vi.fn(async () => { d.settings.couchdbConfigDbName = "cfg-B"; });
            await expect(d.cs.rebind("cfg-B", { commit })).rejects.toMatchObject({ kind: "busy" });
            expect(commit).not.toHaveBeenCalled();
            expect(d.settings.couchdbConfigDbName).toBe("cfg-A");
            remote("cfg-A").unpark();
            await running;
        });

        it("a store that fails to open still saves the server, leaving config sync unbound", async () => {
            const settings = makeSettings({ deviceId: "dev", couchdbUri: X, couchdbConfigDbName: "cfg" });
            let fail = false;
            const cs = new ConfigSync(
                new FakeVaultIO(), new FakeModalPresenter(), `vault-dev-${unique()}`, new AuthGate(),
                ALWAYS_VISIBLE, NoopReconnectBridge, () => settings,
                {
                    storeFactory: (name) => {
                        if (fail) throw new Error("schema stamp mismatch");
                        return storeFactory(name);
                    },
                    rawClientFactory: (s) => remote(s.couchdbConfigDbName, s.couchdbUri),
                },
            );
            await cs.rebind("cfg");
            fail = true;
            const r = await applyServerSettings({
                configBinding: {
                    changeBlocker: () => cs.bindingChangeBlocker(),
                    switchServer: (serverUri, commit) => cs.rebind("cfg", { serverUri, commit }),
                },
                oldUri: X, newUri: Y,
                save: async () => { settings.couchdbUri = Y; },
            });
            expect(r.kind).toBe("saved-config-unbound");
            expect(settings.couchdbUri).toBe(Y);
            expect(cs.currentBinding()).toBeNull();
            await expect(cs.pull()).rejects.toMatchObject({ kind: "not-configured" });
        });
    });

    describe("the Step 3 status line follows the relation", () => {
        const view = (d: Device) => configRelationView(
            { enabled: true, relation: d.cs.currentBinding()!.relation() }, null,
        );

        it("a failed Join on a device that has not joined says why, not 'Not joined yet'", async () => {
            await seed("cfg-enc", { ".obsidian/app.json": "{}" }, ENC);
            const b = makeDevice("dev-B", { ...ENC, configEncryptionPassphrase: "wrong" });
            await apply(b, "cfg-enc");
            expect(view(b).text).toMatch(/^Not joined yet/);

            await expect(b.cs.join()).rejects.toMatchObject({ kind: "passphrase-mismatch" });
            expect(b.cs.currentBinding()!.relation()).toMatchObject({
                attachment: null, last: { op: "join", against: null },
            });
            const v = view(b);
            expect(v.tone).toBe("error");
            expect(v.text).toMatch(/^Last Join: The passphrase this device has does not unlock/);
            expect(v.text).not.toMatch(/\bCreate\b/);
        });

        it("a result about another root is dropped once the device joins a new one", async () => {
            const a = await creator("cfg-A", { ".obsidian/app.json": "{}" });
            const b = makeDevice("dev-B");
            await apply(b, "cfg-A");
            await b.cs.join();
            // A re-creates: B's Pull fails against the root it joined.
            await a.cs.create();
            await expect(b.cs.pull()).rejects.toMatchObject({ kind: "root-changed" });
            expect(view(b).text).toMatch(/^Last Pull: .*re-created on another device/);
            // Joining the new root replaces the attachment; the old failure
            // no longer describes the relation.
            await b.cs.join();
            expect(view(b)).toEqual({ text: 'Joined "cfg-A" — ready to Push and Pull.', tone: "ok" });
            await a.cs.close();
        });
    });

    describe("a bare scan() on an encrypted DB (fail-closed hasher)", () => {
        it("without an unlocked key: key-missing, never xxhash64 chunk ids", async () => {
            await seed("cfg-enc", { ".obsidian/app.json": "{}" }, ENC);
            const b = makeDevice("dev-B", ENC);
            await apply(b, "cfg-enc");
            await b.cs.join();
            await b.cs.close();
            // A new session: the store says encrypted, no key unlocked yet.
            const b2 = makeDevice("dev-B", {}, undefined, b);
            await b2.cs.rebind("cfg-enc");
            b2.vault.addFile(".obsidian/hotkeys.json", "{}");
            await expect(b2.cs.scan()).rejects.toMatchObject({ kind: "key-missing" });
            const store = b2.cs.currentStore()!;
            const x64 = () => store.allDocs({ startkey: "chunk:x64:", endkey: "chunk:x64:￰" });
            expect((await x64()).rows).toEqual([]);
            // After an op unlocked it this session, scan mints HMAC ids.
            expect(await b2.cs.pull()).toBe(1);
            await b2.cs.scan();
            const hmac = await store.allDocs({ startkey: "chunk:hmac:", endkey: "chunk:hmac:￰" });
            expect(hmac.rows.length).toBeGreaterThan(0);
            expect((await x64()).rows).toEqual([]);
        });
    });
});
