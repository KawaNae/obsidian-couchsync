/**
 * Config Push and Pull across devices: the three-way merge end to end.
 *
 * Several devices share one FakeCouchClient config DB. Each has its own
 * vault (FakeVaultIO) and its own ConfigLocalDB, and runs the real
 * ConfigSync. The cases:
 *
 *   - an edit that was not pushed survives a Pull
 *   - a key one device never changed is not overwritten by its Push
 *   - a key both devices changed keeps the local value and is reported
 *   - without a base the shared value wins, keys only local has stay, and
 *     the overwritten file is backed up first
 *   - a file this device would not write is not sent either
 *   - community-plugins.json merges as a set
 *   - a Pull that writes nothing does not reload and shows one Notice
 *   - the Push list: what it selects is sent, what it leaves out is kept
 *     on this device (not sent, not taken in) until selected again
 *   - Share again: a key kept on this device takes the shared value
 *     through a Pull, other keys and files are pulled as usual
 *   - Pull & Overwrite: the disk becomes the shared state, files the
 *     shared state does not have are deleted, declarations are dropped,
 *     files that do not take part are left alone; Cancel changes nothing
 *   - the one-time migration of a store written by older builds
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ConfigSync } from "../../src/sync/config-sync.ts";
import { ConfigLocalDB } from "../../src/db/config-local-db.ts";
import { AuthGate } from "../../src/db/sync/auth-gate.ts";
import { ALWAYS_VISIBLE } from "../../src/db/visibility-gate.ts";
import { NoopReconnectBridge } from "../../src/sync/reconnect-bridge.ts";
import { makeConfigId } from "../../src/types/doc-id.ts";
import type { ConfigDoc, CouchSyncDoc } from "../../src/types.ts";
import type { CouchSyncSettings } from "../../src/settings.ts";
import { metaFingerprint, type ConfigMetaDoc } from "../../src/db/vault-meta.ts";
import { metaCodec } from "../../src/sync/config-binding-record.ts";
import { configLastSyncedKey } from "../../src/db/sync/config-last-synced.ts";
import {
    configLocalFirstKey,
    META_CONFIG_BASE_MIGRATED,
} from "../../src/sync/config-migration.ts";
import { FakeCouchClient } from "../helpers/fake-couch-client.ts";
import { FakeVaultIO } from "../helpers/fake-vault-io.ts";
import { FakeModalPresenter } from "../helpers/fake-modal-presenter.ts";
import { makeSettings } from "../helpers/settings-factory.ts";
import { attachPlain, putAttachment } from "../helpers/config-attach.ts";
import {
    makeConfigFixture,
    seedRemoteConfig,
    type ConfigFixture,
} from "../helpers/config-fixture.ts";
import { clearLog, getLogEntries, initLog } from "../../src/ui/log.ts";
import { noticeText } from "../../src/ui/notices.ts";

let counter = 0;
const unique = () => `cfg-3way-${Date.now()}-${counter++}`;

const DB = "cfg";
const APP = ".obsidian/app.json";
const BACKUPS = ".obsidian/plugins/obsidian-couchsync/backups/config";

interface Device {
    id: string;
    cs: ConfigSync;
    vault: FakeVaultIO;
    store: ConfigLocalDB;
    settings: CouchSyncSettings;
    modal: FakeModalPresenter;
    reloads: number;
    /** Plugin folders Pull asked to stop, per call. */
    stopped: string[][];
}

describe("config three-way merge across devices", () => {
    let remote: FakeCouchClient;
    let meta: ConfigMetaDoc | null;
    let devices: Device[];
    let shown: string[];

    beforeEach(() => {
        remote = new FakeCouchClient();
        meta = null;
        devices = [];
        shown = [];
        clearLog();
        initLog(() => ({ verboseNotice: false }), (msg) => { shown.push(noticeText(msg)); });
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(async () => {
        for (const d of devices) {
            await d.cs.close();
            await d.store.destroy().catch(() => {});
        }
        initLog(() => ({ verboseNotice: false }), () => {});
        vi.restoreAllMocks();
    });

    /** A device joined to the shared config DB. `vault` lets a device
     *  start with files already on its disk. */
    async function device(
        id: string,
        opts: { vault?: FakeVaultIO; mobile?: boolean; store?: ConfigLocalDB } = {},
    ): Promise<Device> {
        const vault = opts.vault ?? new FakeVaultIO();
        const store = opts.store ?? new ConfigLocalDB(unique());
        const settings = makeSettings({
            deviceId: id,
            couchdbUri: "http://localhost:5984",
            couchdbConfigDbName: DB,
            compressionEnabled: false,
            configCompressionEnabled: false,
        });
        const dev = { id, vault, store, settings, modal: new FakeModalPresenter(), reloads: 0, stopped: [] } as Device;
        dev.cs = new ConfigSync(
            vault, dev.modal, `vault-${id}`, new AuthGate(), ALWAYS_VISIBLE,
            NoopReconnectBridge, () => settings,
            {
                storeFactory: () => store,
                rawClientFactory: () => remote,
                getIsMobile: () => opts.mobile ?? false,
                reload: () => { dev.reloads++; },
                // Stops every plugin it is asked to; the folder name stands
                // for the plugin id.
                stopPlugins: async (dirs) => {
                    dev.stopped.push(dirs);
                    return dirs.map((d) => d.split("/").at(-1)!);
                },
            },
        );
        await dev.cs.rebind(DB);
        if (!meta) {
            meta = await attachPlain(settings, remote, store);
        } else {
            await putAttachment(store, {
                codec: metaCodec(meta),
                metaFingerprint: await metaFingerprint(meta),
            });
        }
        // The binding read its attachment when it opened: re-open it.
        await dev.cs.rebind(null);
        await dev.cs.rebind(DB);
        devices.push(dev);
        return dev;
    }

    const json = (d: Device, path = APP) => JSON.parse(d.vault.readText(path));
    const put = (d: Device, value: unknown, path = APP) =>
        d.vault.addFile(path, JSON.stringify(value, null, 2));
    const serverDoc = (path = APP) => remote.getDoc<ConfigDoc>(makeConfigId(path));
    const warnings = () => getLogEntries().filter((e) => e.level === "warn").map((e) => e.message);
    const pullNotices = () => shown.filter((s) => s.startsWith("CouchSync: Config Pull"));

    // ── Local edits ─────────────────────────────────────

    it("an edit that was not pushed survives a Pull, with or without remote changes", async () => {
        const a = await device("dev-A");
        const b = await device("dev-B");
        put(a, { tabSize: 4, theme: "light" });
        expect(await a.cs.push()).toBe(1);
        expect(await b.cs.pull()).toBe(1);

        // B edits, does not push, pulls with nothing new on the server.
        put(b, { tabSize: 2, theme: "light" });
        expect(await b.cs.pull()).toBe(0);
        expect(json(b)).toEqual({ tabSize: 2, theme: "light" });

        // A changes another key; B's Pull takes it and keeps its own edit.
        put(a, { tabSize: 4, theme: "dark" });
        expect(await a.cs.push()).toBe(1);
        expect(await b.cs.pull()).toBe(1);
        expect(json(b)).toEqual({ tabSize: 2, theme: "dark" });
        // The two Pulls that wrote reloaded; the one that did not, did not.
        expect(b.reloads).toBe(2);

        // B's edit is still a local change: its Push sends it.
        expect(await b.cs.push()).toBe(1);
        expect(await a.cs.pull()).toBe(1);
        expect(json(a)).toEqual({ tabSize: 2, theme: "dark" });
    });

    it("a key the desktop never changed is not overwritten by the desktop's Push", async () => {
        const desktop = await device("desktop");
        const mobile = await device("mobile", { mobile: true });
        put(desktop, { a: 1 });
        await desktop.cs.push();
        await mobile.cs.pull();

        // Mobile adds a key of its own and pushes it.
        put(mobile, { a: 1, mobileOnly: true });
        expect(await mobile.cs.push()).toBe(1);

        // Desktop changes `a` on its old base: the Push is held, not forced.
        put(desktop, { a: 2 });
        expect(await desktop.cs.push()).toBe(0);
        expect(warnings().some((w) => /held 1 file/.test(w) && w.includes(APP))).toBe(true);
        expect(JSON.parse(new TextDecoder().decode(await serverBytes()))).toEqual({ a: 1, mobileOnly: true });

        // Pull & Reload merges, then the Push sends only what desktop changed.
        expect(await desktop.cs.pull()).toBe(1);
        expect(json(desktop)).toEqual({ a: 2, mobileOnly: true });
        expect(await desktop.cs.push()).toBe(1);
        expect(JSON.parse(new TextDecoder().decode(await serverBytes()))).toEqual({ a: 2, mobileOnly: true });
    });

    it("a file this device would not write is not sent either: it stays this device's own", async () => {
        const PLUGIN = ".obsidian/plugins/dt";
        const DATA = `${PLUGIN}/data.json`;
        const withPlugin = (value: unknown) => {
            const vault = new FakeVaultIO();
            vault.addFile(`${PLUGIN}/manifest.json`, JSON.stringify({ id: "dt", isDesktopOnly: true }));
            vault.addFile(DATA, JSON.stringify(value));
            return vault;
        };
        const desktop = await device("desktop", { vault: withPlugin({ v: "desktop" }) });
        expect(await desktop.cs.push()).toBe(1);

        // On mobile the desktop-only plugin's data.json is never written, so
        // its own copy is not sent and not held either.
        const mobile = await device("mobile", { vault: withPlugin({ v: "mobile" }), mobile: true });
        expect(await mobile.cs.pull()).toBe(0);
        shown.length = 0;
        expect(await mobile.cs.push()).toBe(0);

        expect(json(mobile, DATA)).toEqual({ v: "mobile" });
        expect(JSON.parse(new TextDecoder().decode(await serverBytes(DATA)))).toEqual({ v: "desktop" });
        expect(warnings().some((w) => /held/.test(w))).toBe(false);
        expect(shown.filter((t) => t.startsWith("CouchSync: Config Push")))
            .toEqual([expect.stringMatching(/No local changes to push\./)]);
    });

    async function serverBytes(path = APP): Promise<Uint8Array> {
        const doc = await serverDoc(path);
        const parts: Uint8Array[] = [];
        for (const id of doc!.chunks) {
            const blob = await remote.getAttachment(id, "c");
            const { decodeEnvelope } = await import("../../src/db/envelope.ts");
            parts.push(decodeEnvelope(blob!).body);
        }
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let off = 0;
        for (const p of parts) { out.set(p, off); off += p.length; }
        return out;
    }

    it("a key both sides changed keeps the local value and is reported", async () => {
        const a = await device("dev-A");
        const b = await device("dev-B");
        put(a, { k: 0, other: 0 });
        await a.cs.push();
        await b.cs.pull();

        put(a, { k: "a", other: 1 });
        await a.cs.push();
        put(b, { k: "b", other: 0 });
        shown.length = 0;

        expect(await b.cs.pull()).toBe(1);

        expect(json(b)).toEqual({ k: "b", other: 1 });
        expect(pullNotices()).toHaveLength(1);
        expect(pullNotices()[0]).toMatch(/1 file\(s\) kept this device's value/);
        const report = warnings().find((w) => w.includes("both sides changed"));
        expect(report).toContain(`${APP}: /k`);
        // Values are never logged (a plugin's data.json may hold secrets).
        expect(report).not.toContain(`"a"`);
        // The shared value stays in the config DB; B's value is a local
        // change its next Push would send.
        expect(await b.cs.push()).toBe(1);
        expect(JSON.parse(new TextDecoder().decode(await serverBytes()))).toEqual({ k: "b", other: 1 });
    });

    // ── No base ─────────────────────────────────────────

    it("without a base the shared value wins, local-only keys stay, and the file is backed up", async () => {
        const a = await device("dev-A");
        put(a, { a: 1, r: 1 });
        await a.cs.push();

        // B joins with its own app.json already on disk.
        const vault = new FakeVaultIO();
        vault.addFile(APP, JSON.stringify({ a: 0, local: 1 }, null, 2));
        const b = await device("dev-B", { vault });

        expect(await b.cs.pull()).toBe(1);

        expect(json(b)).toEqual({ a: 1, local: 1, r: 1 });
        const gens = (await b.vault.list(BACKUPS)).folders;
        expect(gens).toHaveLength(1);
        expect(JSON.parse(b.vault.readText(`${gens[0]}/app.json`))).toEqual({ a: 0, local: 1 });
        // The local-only key is now a local change; nothing else is.
        expect(await b.cs.push()).toBe(1);
        expect(JSON.parse(new TextDecoder().decode(await serverBytes()))).toEqual({ a: 1, local: 1, r: 1 });
    });

    it("keeps the indent and key order of the file on disk", async () => {
        const a = await device("dev-A");
        const b = await device("dev-B");
        put(a, { x: 1, y: 1 });
        await a.cs.push();
        await b.cs.pull();
        b.vault.addFile(APP, `{\n\t"y": 1,\n\t"x": 1,\n\t"mine": true\n}\n`);
        a.vault.addFile(APP, `{"x":2,"y":1,"z":3}`);
        await a.cs.push();

        await b.cs.pull();

        expect(b.vault.readText(APP)).toBe(`{\n\t"y": 1,\n\t"x": 2,\n\t"mine": true,\n\t"z": 3\n}\n`);
    });

    it("community-plugins.json merges as a set of plugin ids", async () => {
        const CP = ".obsidian/community-plugins.json";
        const policy = (d: Device) => {
            d.settings.configSyncPolicy = {
                ...d.settings.configSyncPolicy,
                unitDefaults: { ...d.settings.configSyncPolicy.unitDefaults, "enabled-list": true },
            };
        };
        const a = await device("dev-A");
        const b = await device("dev-B");
        policy(a); policy(b);
        put(a, ["one", "two"], CP);
        await a.cs.push();
        await b.cs.pull();

        put(a, ["one", "two", "three"], CP);
        await a.cs.push();
        put(b, ["two", "mine"], CP); // B disabled "one" and enabled "mine"

        await b.cs.pull();

        expect(json(b, CP)).toEqual(["two", "mine", "three"]);
    });

    it("JSON that does not parse is compared as a whole file", async () => {
        const a = await device("dev-A");
        const b = await device("dev-B");
        a.vault.addFile(APP, "not json");
        await a.cs.push();
        await b.cs.pull();
        b.vault.addFile(APP, "edited here");
        a.vault.addFile(APP, "edited there");
        await a.cs.push();

        expect(await b.cs.pull()).toBe(0);

        expect(b.vault.readText(APP)).toBe("edited here");
        expect(warnings().find((w) => w.includes("both sides changed"))).toContain("(whole file)");
    });

    // ── Notice and reload ───────────────────────────────

    it("a Pull that writes nothing does not reload and shows one Notice", async () => {
        const a = await device("dev-A");
        const b = await device("dev-B");
        put(a, { a: 1 });
        await a.cs.push();
        await b.cs.pull();
        expect(b.reloads).toBe(1);
        shown.length = 0;

        put(a, { a: 1 }); // same content, rewritten: nothing to send
        expect(await a.cs.push()).toBe(0);
        expect(await b.cs.pull()).toBe(0);

        expect(b.reloads).toBe(1);
        expect(pullNotices()).toEqual([expect.stringMatching(/No config files changed; no reload needed/)]);
    });

    it("a Pull that writes reports it and reloads once", async () => {
        const a = await device("dev-A");
        const b = await device("dev-B");
        put(a, { a: 1 });
        await a.cs.push();
        shown.length = 0;

        expect(await b.cs.pull()).toBe(1);

        expect(b.reloads).toBe(1);
        expect(pullNotices()).toEqual([expect.stringMatching(/Wrote 1 file\(s\)\. Reloading Obsidian/)]);
    });

    it("Received counts the changes this device did not have, not its own Push", async () => {
        const a = await device("dev-A");
        const b = await device("dev-B");
        put(a, { a: 1 });
        await a.cs.push();
        shown.length = 0;

        expect(await a.cs.pull()).toBe(0);
        expect(pullNotices()).toEqual([expect.not.stringMatching(/Received/)]);

        shown.length = 0;
        await b.cs.pull();
        expect(pullNotices()).toEqual([expect.stringMatching(/Received 1 change\(s\)/)]);
    });

    it("a held file is worded with the same reason on the Notice and in the log", async () => {
        const a = await device("dev-A");
        const b = await device("dev-B");
        put(a, { a: 1 });
        await a.cs.push();
        put(b, { a: 2 });
        shown.length = 0;

        expect(await b.cs.push()).toBe(0);

        const pushNotice = shown.find((t) => t.startsWith("CouchSync: Config Push"));
        expect(pushNotice).toMatch(/1 held \(the server has a newer version\)\. Run Pull & Reload/);
        expect(warnings().find((w) => w.includes("held"))).toContain(`${APP} (the server has a newer version)`);
    });

    it("keeps the newest 10 backup generations", async () => {
        const a = await device("dev-A");
        const b = await device("dev-B");
        put(a, { n: 0 });
        await a.cs.push();
        await b.cs.pull();
        for (let n = 1; n <= 12; n++) {
            put(a, { n });
            await a.cs.push();
            await b.cs.pull();
        }
        expect((await b.vault.list(BACKUPS)).folders).toHaveLength(10);
        // Backups are never pushed.
        const paths = (await b.cs.listLocalConfigPaths());
        expect(paths.some((p) => p.includes("/backups/"))).toBe(false);
    });

    // ── The Push list and this device's own keys ────────

    const leaveOut = (...ids: string[]) => (review: { items: Array<{ id: string; deviceOnly: boolean }> }) =>
        review.items.filter((i) => !i.deviceOnly && !ids.includes(i.id)).map((i) => i.id);
    const serverJson = async (path = APP) => JSON.parse(new TextDecoder().decode(await serverBytes(path)));

    it("sends what the list selects; a key left out is not sent", async () => {
        const a = await device("dev-A");
        const b = await device("dev-B");
        put(a, { k: 0, mine: 0 });
        await a.cs.push();
        await b.cs.pull();

        put(b, { k: 1, mine: 1 });
        b.modal.pushResponder = leaveOut(`${APP}#/mine`);
        expect(await b.cs.push()).toBe(1);

        expect(b.modal.pushCalls).toHaveLength(1);
        expect(b.modal.pushCalls[0].items.map((i) => i.pointer)).toEqual(["/k", "/mine"]);
        expect(await serverJson()).toEqual({ k: 1, mine: 0 });
        expect(b.settings.configSyncPolicy.deviceOnlyKeys).toEqual({ [APP]: ["/mine"] });
        // The disk keeps this device's value.
        expect(json(b)).toEqual({ k: 1, mine: 1 });
    });

    it("a key left out stays left out on the next Push and does not take in remote changes", async () => {
        const a = await device("dev-A");
        const b = await device("dev-B");
        put(a, { k: 0, mine: 0 });
        await a.cs.push();
        await b.cs.pull();
        put(b, { k: 0, mine: 1 });
        b.modal.pushResponder = leaveOut(`${APP}#/mine`);
        expect(await b.cs.push()).toBe(0);
        b.modal.pushResponder = (r) => r.items.filter((i) => !i.deviceOnly).map((i) => i.id);

        // A changes both keys; B takes k, keeps its own mine, and reports
        // no conflict.
        put(a, { k: 2, mine: 2 });
        await a.cs.push();
        clearLog();
        expect(await b.cs.pull()).toBe(1);
        expect(json(b)).toEqual({ k: 2, mine: 1 });
        expect(warnings().some((w) => w.includes("both sides changed"))).toBe(false);
        expect(getLogEntries().some((e) => /1 key\(s\) kept on this device were not taken in/.test(e.message)))
            .toBe(true);

        // Only the declared key differs: Push shows no list and sends nothing.
        shown.length = 0;
        const calls = b.modal.pushCalls.length;
        expect(await b.cs.push()).toBe(0);
        expect(b.modal.pushCalls).toHaveLength(calls);
        expect(shown.filter((t) => t.startsWith("CouchSync: Config Push")))
            .toEqual([expect.stringMatching(/No local changes to push\. 1 file\(s\) differ only in keys kept on this device/)]);

        // With another change, the list shows the declared key left out.
        put(b, { k: 3, mine: 1 });
        expect(await b.cs.push()).toBe(1);
        const last = b.modal.pushCalls[b.modal.pushCalls.length - 1];
        expect(last.items.map((i) => [i.pointer, i.deviceOnly])).toEqual([["/k", false], ["/mine", true]]);
        expect(await serverJson()).toEqual({ k: 3, mine: 2 });
    });

    it("selecting a declared key again sends it and shares it again", async () => {
        const a = await device("dev-A");
        const b = await device("dev-B");
        put(a, { k: 0, mine: 0 });
        await a.cs.push();
        await b.cs.pull();
        put(b, { k: 1, mine: 1 });
        b.modal.pushResponder = leaveOut(`${APP}#/mine`);
        await b.cs.push();

        // With another change the list shows the declared key; B selects
        // everything.
        put(b, { k: 2, mine: 1 });
        b.modal.pushResponder = (r) => r.items.map((i) => i.id);
        expect(await b.cs.push()).toBe(1);
        expect(await serverJson()).toEqual({ k: 2, mine: 1 });
        expect(b.settings.configSyncPolicy.deviceOnlyKeys).toEqual({});

        // Shared again: A's next change of the key reaches B.
        await a.cs.pull();
        put(a, { k: 2, mine: 5 });
        await a.cs.push();
        await b.cs.pull();
        expect(json(b)).toEqual({ k: 2, mine: 5 });
    });

    it("a plugin left out of community-plugins.json stays this device's own", async () => {
        const PLUGINS = ".obsidian/community-plugins.json";
        const enableList = (d: Device) => { d.settings.configSyncPolicy.unitDefaults["enabled-list"] = true; };
        const desktop = await device("desktop");
        const mobile = await device("mobile", { mobile: true });
        enableList(desktop);
        enableList(mobile);
        put(desktop, ["a", "heavy"], PLUGINS);
        await desktop.cs.push();
        await mobile.cs.pull();

        // Mobile disables "heavy" and keeps that to itself.
        put(mobile, ["a"], PLUGINS);
        mobile.modal.pushResponder = leaveOut(`${PLUGINS}#/heavy`);
        expect(await mobile.cs.push()).toBe(0);
        expect(mobile.settings.configSyncPolicy.deviceOnlyKeys).toEqual({ [PLUGINS]: ["/heavy"] });
        expect(await serverJson(PLUGINS)).toEqual(["a", "heavy"]);

        // Desktop enables "b": mobile takes it, "heavy" stays off there.
        await desktop.cs.pull();
        put(desktop, ["a", "heavy", "b"], PLUGINS);
        await desktop.cs.push();
        expect(await mobile.cs.pull()).toBe(1);
        expect(json(mobile, PLUGINS)).toEqual(["a", "b"]);
        // Mobile's next Push does not disable "heavy" for everyone.
        mobile.modal.pushResponder = (r) => r.items.filter((i) => !i.deviceOnly).map((i) => i.id);
        expect(await mobile.cs.push()).toBe(0);
        expect(await serverJson(PLUGINS)).toEqual(["a", "heavy", "b"]);
    });

    it("a whole file left out stops syncing on this device", async () => {
        const CSS = ".obsidian/snippets/x.css";
        const a = await device("dev-A");
        a.vault.addFile(CSS, "a {}");
        a.modal.pushResponder = leaveOut(CSS);
        expect(await a.cs.push()).toBe(0);
        expect(a.settings.configSyncPolicy.overrides).toEqual({ [CSS]: false });
        expect(await serverDoc(CSS)).toBeNull();
        // Not offered again.
        a.modal.pushResponder = (r) => r.items.map((i) => i.id);
        expect(await a.cs.push()).toBe(0);
        expect(a.modal.pushCalls).toHaveLength(1);
    });

    it("cancelling the list sends nothing and declares nothing", async () => {
        const a = await device("dev-A");
        put(a, { k: 1 });
        a.modal.pushResponder = () => null;
        await expect(a.cs.push()).rejects.toThrow();
        expect(await serverDoc()).toBeNull();
        expect(a.settings.configSyncPolicy.deviceOnlyKeys).toEqual({});
        expect(warnings()).toContain("Config Push cancelled — Nothing was pushed.");
    });

    // ── Share again ─────────────────────────────────────

    describe("Share again", () => {
        /** A shares {k: 0, mine: 0}; B keeps mine = 1 on this device. */
        async function keptPair(): Promise<{ a: Device; b: Device }> {
            const a = await device("dev-A");
            const b = await device("dev-B");
            put(a, { k: 0, mine: 0 });
            await a.cs.push();
            await b.cs.pull();
            put(b, { k: 0, mine: 1 });
            b.modal.pushResponder = leaveOut(`${APP}#/mine`);
            expect(await b.cs.push()).toBe(0);
            b.modal.pushResponder = (r) => r.items.map((i) => i.id);
            expect(b.settings.configSyncPolicy.deviceOnlyKeys).toEqual({ [APP]: ["/mine"] });
            return { a, b };
        }

        it("writes the shared value, drops the declaration, and keeps other unpushed edits", async () => {
            const { a, b } = await keptPair();
            await a.cs.pull();
            put(a, { k: 0, mine: 2 });
            await a.cs.push();
            put(b, { k: 5, mine: 1 });
            const reloads = b.reloads;

            b.modal.shareAgainResponses.push(true);
            expect(await b.cs.shareAgain(APP, "/mine")).toBe(1);

            // The confirmation shows what the config DB had before the Pull;
            // the Pull then writes the newest shared value.
            expect(b.modal.shareAgainCalls).toEqual([
                { path: APP, pointer: "/mine", shared: { kind: "value", value: 0 }, hideValue: false },
            ]);
            expect(json(b)).toEqual({ k: 5, mine: 2 });
            expect(b.settings.configSyncPolicy.deviceOnlyKeys).toEqual({});
            expect(b.reloads).toBe(reloads + 1);
            const gens = (await b.vault.list(BACKUPS)).folders.sort();
            expect(JSON.parse(b.vault.readText(`${gens.at(-1)}/app.json`))).toEqual({ k: 5, mine: 1 });

            // The unpushed edit is still a local change; the key is not.
            expect(await b.cs.push()).toBe(1);
            expect(b.modal.pushCalls.at(-1)!.items.map((i) => i.pointer)).toEqual(["/k"]);
            expect(await serverJson()).toEqual({ k: 5, mine: 2 });

            // Shared again: A's next change of the key reaches B.
            await a.cs.pull();
            put(a, { k: 5, mine: 3 });
            await a.cs.push();
            await b.cs.pull();
            expect(json(b)).toEqual({ k: 5, mine: 3 });
        });

        it("removes the key when the shared version does not have it", async () => {
            const a = await device("dev-A");
            const b = await device("dev-B");
            put(a, { k: 0 });
            await a.cs.push();
            await b.cs.pull();
            put(b, { k: 0, mine: 1 });
            b.modal.pushResponder = leaveOut(`${APP}#/mine`);
            await b.cs.push();

            b.modal.shareAgainResponses.push(true);
            expect(await b.cs.shareAgain(APP, "/mine")).toBe(1);
            expect(b.modal.shareAgainCalls[0].shared).toEqual({ kind: "absent" });
            expect(json(b)).toEqual({ k: 0 });
            expect(b.settings.configSyncPolicy.deviceOnlyKeys).toEqual({});
        });

        it("a plugin kept off in community-plugins.json follows the shared list again", async () => {
            const PLUGINS = ".obsidian/community-plugins.json";
            const enableList = (d: Device) => { d.settings.configSyncPolicy.unitDefaults["enabled-list"] = true; };
            const desktop = await device("desktop");
            const mobile = await device("mobile", { mobile: true });
            enableList(desktop);
            enableList(mobile);
            put(desktop, ["a", "heavy"], PLUGINS);
            await desktop.cs.push();
            await mobile.cs.pull();
            put(mobile, ["a"], PLUGINS);
            mobile.modal.pushResponder = leaveOut(`${PLUGINS}#/heavy`);
            await mobile.cs.push();

            mobile.modal.shareAgainResponses.push(true);
            expect(await mobile.cs.shareAgain(PLUGINS, "/heavy")).toBe(1);
            expect(mobile.modal.shareAgainCalls[0].shared).toEqual({ kind: "member" });
            expect(json(mobile, PLUGINS)).toEqual(["a", "heavy"]);
            expect(mobile.settings.configSyncPolicy.deviceOnlyKeys).toEqual({});
        });

        it("hides a plugin's data.json value in the confirmation", async () => {
            const PLUGIN = ".obsidian/plugins/p";
            const a = await device("dev-A");
            const b = await device("dev-B");
            for (const d of [a, b]) d.vault.addFile(`${PLUGIN}/main.js`, "code");
            put(a, { token: "shared" }, `${PLUGIN}/data.json`);
            await a.cs.push();
            await b.cs.pull();
            put(b, { token: "mine" }, `${PLUGIN}/data.json`);
            b.modal.pushResponder = leaveOut(`${PLUGIN}/data.json#/token`);
            await b.cs.push();

            b.modal.shareAgainResponses.push(true);
            expect(await b.cs.shareAgain(`${PLUGIN}/data.json`, "/token")).toBe(1);
            expect(b.modal.shareAgainCalls[0].hideValue).toBe(true);
            expect(json(b, `${PLUGIN}/data.json`)).toEqual({ token: "shared" });
        });

        it("Cancel changes nothing: disk, bases, the declaration, backups", async () => {
            const { b } = await keptPair();
            put(b, { k: 5, mine: 1 });
            const binding = b.cs.currentBinding()!;
            const bases = binding.lastSynced.paths().map((p) => [p, binding.lastSynced.get(p)]);
            const diskWriteId = b.settings.configDiskWriteId;
            const generations = (await b.vault.list(BACKUPS)).folders.length;
            const reloads = b.reloads;

            await expect(b.cs.shareAgain(APP, "/mine")).rejects.toThrow();

            expect(b.modal.shareAgainCalls).toHaveLength(1);
            expect(json(b)).toEqual({ k: 5, mine: 1 });
            expect(b.settings.configSyncPolicy.deviceOnlyKeys).toEqual({ [APP]: ["/mine"] });
            expect(binding.lastSynced.paths().map((p) => [p, binding.lastSynced.get(p)])).toEqual(bases);
            expect(b.settings.configDiskWriteId).toBe(diskWriteId);
            expect((await b.vault.list(BACKUPS)).folders).toHaveLength(generations);
            expect(b.reloads).toBe(reloads);
            expect(warnings()).toContain("Config Share again cancelled — Nothing was changed.");
        });

        it("drops the declaration without a reload when the disk already has the shared value", async () => {
            const { b } = await keptPair();
            put(b, { k: 0, mine: 0 });
            const reloads = b.reloads;
            shown.length = 0;

            b.modal.shareAgainResponses.push(true);
            expect(await b.cs.shareAgain(APP, "/mine")).toBe(0);
            expect(b.settings.configSyncPolicy.deviceOnlyKeys).toEqual({});
            expect(b.reloads).toBe(reloads);
            expect(shown.filter((t) => t.startsWith("CouchSync: Config Share again")))
                .toEqual([expect.stringMatching(/shared again\. No config files changed; no reload needed\./)]);
        });
    });

    // ── Pull & Overwrite ────────────────────────────────

    describe("Pull & Overwrite", () => {
        const CSS = ".obsidian/snippets/local.css";
        const PLUGIN = ".obsidian/plugins/p";
        const OWN = ".obsidian/plugins/obsidian-couchsync";

        /** A pushes app.json and a plugin's data.json; B takes them in. */
        async function sharedPair(): Promise<{ a: Device; b: Device }> {
            const a = await device("dev-A");
            a.vault.addFile(`${PLUGIN}/main.js`, "code");
            put(a, { k: 0, mine: 0 });
            put(a, { token: "shared" }, `${PLUGIN}/data.json`);
            expect(await a.cs.push()).toBe(2);
            const b = await device("dev-B");
            b.vault.addFile(`${PLUGIN}/main.js`, "code");
            expect(await b.cs.pull()).toBe(2);
            return { a, b };
        }

        it("Pull and Overwrite log the plugins they stop before writing", async () => {
            const infos = () => getLogEntries().filter((e) => e.level === "info").map((e) => e.message);
            // sharedPair's Pull on B writes the plugin's data.json.
            const { b } = await sharedPair();
            expect(infos()).toContainEqual(
                expect.stringMatching(/^Config Pull: stopped 1 plugin\(s\) before writing their files .*: p$/),
            );

            put(b, { token: "mine" }, `${PLUGIN}/data.json`);
            b.modal.overwriteResponses.push(true);
            expect(await b.cs.overwrite()).toBe(1);
            expect(infos()).toContainEqual(
                expect.stringMatching(/^Config Pull & Overwrite: stopped 1 plugin\(s\) .*: p$/),
            );
        });

        it("makes the disk the shared state: unpushed edits and kept keys are dropped", async () => {
            const { b } = await sharedPair();
            // A key kept on this device, then an edit that is not pushed.
            put(b, { k: 0, mine: 1 });
            b.modal.pushResponder = leaveOut(`${APP}#/mine`);
            expect(await b.cs.push()).toBe(0);
            put(b, { k: 5, mine: 1, extra: true });
            put(b, { token: "mine" }, `${PLUGIN}/data.json`);
            const before = b.vault.readText(APP);
            const reloads = b.reloads;

            b.modal.overwriteResponses.push(true);
            expect(await b.cs.overwrite()).toBe(2);

            expect(b.modal.overwriteCalls).toHaveLength(1);
            expect(b.modal.overwriteCalls[0]).toEqual({
                writes: [
                    { path: APP, created: false },
                    { path: `${PLUGIN}/data.json`, created: false },
                ],
                deletes: [],
                keptKeys: 1,
                skipped: [],
            });
            expect(json(b)).toEqual({ k: 0, mine: 0 });
            expect(json(b, `${PLUGIN}/data.json`)).toEqual({ token: "shared" });
            expect(b.settings.configSyncPolicy.deviceOnlyKeys).toEqual({});
            expect(b.reloads).toBe(reloads + 1);
            // The plugin was stopped before its file was written; this
            // plugin itself never is.
            expect(b.stopped.at(-1)).toEqual([PLUGIN]);
            // The overwritten content is backed up.
            const gens = (await b.vault.list(BACKUPS)).folders.sort();
            expect(b.vault.readText(`${gens.at(-1)}/app.json`)).toBe(before);

            // The bases are the shared versions: nothing to push or pull.
            b.modal.pushResponder = (r) => r.items.map((i) => i.id);
            expect(await b.cs.push()).toBe(0);
            expect(b.modal.pushCalls).toHaveLength(1);
            expect(await b.cs.pull()).toBe(0);
        });

        it("deletes the selected files the shared state does not have, and nothing else", async () => {
            const { b } = await sharedPair();
            const DT = ".obsidian/plugins/dt";
            const keep: Record<string, string> = {
                // Not taking part: plugin code (blocked), layout, this
                // plugin's own data.json, a file left out in the Filter.
                [`${PLUGIN}/main.js`]: "code",
                ".obsidian/workspace.json": "{}",
                [`${OWN}/data.json`]: "{\"secret\":1}",
                ".obsidian/snippets/off.css": "b {}",
            };
            for (const [p, c] of Object.entries(keep)) b.vault.addFile(p, c);
            b.settings.configSyncPolicy.overrides[".obsidian/snippets/off.css"] = false;
            // Taking part, not shared: deleted.
            b.vault.addFile(CSS, "a {}");
            put(b, { v: 1 }, `${DT}/data.json`);
            // The folder keeps its plugin code, so it is not removed.
            b.vault.addFile(`${DT}/main.js`, "dt code");
            // A folder left empty is removed, so it no longer counts as an
            // installed plugin.
            const GONE = ".obsidian/plugins/gone";
            put(b, { v: 1 }, `${GONE}/data.json`);
            const deleted: string[] = [];
            const del = b.vault.delete.bind(b.vault);
            b.vault.delete = async (p: string) => { deleted.push(p); await del(p); };

            b.modal.overwriteResponses.push(true);
            expect(await b.cs.overwrite()).toBe(3);

            expect(b.modal.overwriteCalls[0].deletes.sort())
                .toEqual([`${DT}/data.json`, `${GONE}/data.json`, CSS].sort());
            expect(deleted.sort()).toEqual([`${DT}/data.json`, GONE, `${GONE}/data.json`, CSS].sort());
            expect(b.modal.overwriteCalls[0].writes).toEqual([]);
            expect(await b.vault.exists(CSS)).toBe(false);
            expect(await b.vault.exists(`${DT}/data.json`)).toBe(false);
            for (const [p, c] of Object.entries(keep)) expect(b.vault.readText(p)).toBe(c);
            expect(b.vault.readText(`${DT}/main.js`)).toBe("dt code");
            expect(json(b)).toEqual({ k: 0, mine: 0 });
            expect(b.stopped.at(-1)?.sort()).toEqual([DT, GONE]);
            // Deleted files are backed up; backups are never deleted.
            const gens = (await b.vault.list(BACKUPS)).folders.sort();
            expect(b.vault.readText(`${gens.at(-1)}/snippets/local.css`)).toBe("a {}");
            expect(getLogEntries().some((e) => e.message.includes("deleted 3 file(s)") && e.message.includes(CSS)))
                .toBe(true);
        });

        it("leaves a desktop-only plugin's files alone on mobile", async () => {
            const DT = ".obsidian/plugins/dt";
            const vault = new FakeVaultIO();
            vault.addFile(`${DT}/manifest.json`, JSON.stringify({ id: "dt", isDesktopOnly: true }));
            vault.addFile(`${DT}/data.json`, JSON.stringify({ v: "mobile" }));
            const a = await device("dev-A");
            put(a, { k: 0 });
            await a.cs.push();
            const mobile = await device("mobile", { vault, mobile: true });
            mobile.modal.overwriteResponses.push(true);
            expect(await mobile.cs.overwrite()).toBe(1);
            expect(mobile.modal.overwriteCalls[0].deletes).toEqual([]);
            expect(json(mobile, `${DT}/data.json`)).toEqual({ v: "mobile" });
        });

        it("Cancel changes nothing: disk, bases, kept keys, backups", async () => {
            const { b } = await sharedPair();
            put(b, { k: 0, mine: 1 });
            b.modal.pushResponder = leaveOut(`${APP}#/mine`);
            await b.cs.push();
            put(b, { k: 5, mine: 1 });
            b.vault.addFile(CSS, "a {}");
            const binding = b.cs.currentBinding()!;
            const bases = binding.lastSynced.paths().map((p) => [p, binding.lastSynced.get(p)]);
            const diskWriteId = b.settings.configDiskWriteId;
            const generations = (await b.vault.list(BACKUPS)).folders.length;
            const reloads = b.reloads;

            await expect(b.cs.overwrite()).rejects.toThrow();

            expect(b.modal.overwriteCalls).toHaveLength(1);
            expect(json(b)).toEqual({ k: 5, mine: 1 });
            expect(b.vault.readText(CSS)).toBe("a {}");
            expect(b.settings.configSyncPolicy.deviceOnlyKeys).toEqual({ [APP]: ["/mine"] });
            expect(binding.lastSynced.paths().map((p) => [p, binding.lastSynced.get(p)])).toEqual(bases);
            expect(b.settings.configDiskWriteId).toBe(diskWriteId);
            expect((await b.vault.list(BACKUPS)).folders).toHaveLength(generations);
            expect(b.reloads).toBe(reloads);
            expect(warnings()).toContain("Config Pull & Overwrite cancelled — Nothing was changed.");
        });

        it("asks nothing and changes nothing when the disk already is the shared state", async () => {
            const { b } = await sharedPair();
            const reloads = b.reloads;
            expect(await b.cs.overwrite()).toBe(0);
            expect(b.modal.overwriteCalls).toHaveLength(0);
            expect(b.reloads).toBe(reloads);
        });

        it("is refused when the server has no shared config for this device", async () => {
            const a = await device("dev-A");
            put(a, { k: 1 });
            a.vault.addFile(CSS, "a {}");
            expect(await a.cs.overwrite()).toBe(0);
            expect(a.modal.overwriteCalls).toHaveLength(0);
            expect(json(a)).toEqual({ k: 1 });
            expect(a.vault.readText(CSS)).toBe("a {}");
        });

        it("a deleted file loses its base, so a later shared version is written as new", async () => {
            const { a, b } = await sharedPair();
            // B's snippet is not shared: the overwrite deletes it. When A
            // later shares the same path, B's Pull writes it.
            b.vault.addFile(CSS, "b {}");
            b.modal.overwriteResponses.push(true);
            await b.cs.overwrite();
            expect(b.cs.currentBinding()!.lastSynced.get(CSS)).toBeUndefined();
            a.vault.addFile(CSS, "a {}");
            await a.cs.push();
            expect(await b.cs.pull()).toBe(1);
            expect(b.vault.readText(CSS)).toBe("a {}");
        });
    });

    // ── Migration of an older store ─────────────────────

    describe("migration of a store written by older builds", () => {
        /** Device B whose store holds the given old-format state: config
         *  DB docs and lastSynced in step (as scan / the old Pull wrote
         *  them), a push cursor, and no migration mark. */
        async function oldDevice(
            local: ConfigFixture[],
            disk: Record<string, string>,
        ): Promise<Device> {
            const store = new ConfigLocalDB(unique());
            const vault = new FakeVaultIO();
            for (const [p, c] of Object.entries(disk)) vault.addFile(p, c);
            const b = await device("dev-B", { vault, store });
            await store.runWriteTx({
                docs: local.map((f) => ({ doc: f.doc as unknown as CouchSyncDoc })),
                chunks: local.flatMap((f) => f.chunks) as unknown as CouchSyncDoc[],
                meta: [
                    ...local.map((f) => ({
                        op: "put" as const,
                        key: configLastSyncedKey(f.doc._id.slice("config:".length)),
                        value: { vclock: f.doc.vclock, size: f.doc.size, chunks: f.doc.chunks },
                    })),
                    { op: "put" as const, key: "_sync/config-push-seq", value: 7 },
                    { op: "delete" as const, key: META_CONFIG_BASE_MIGRATED },
                ],
            });
            // Re-open so the binding's lastSynced cache reads the old state.
            await b.cs.rebind(null);
            await b.cs.rebind(DB);
            return b;
        }
        const fx = (path: string, value: unknown, vclock: Record<string, number>) =>
            makeConfigFixture(path, JSON.stringify(value), { vclock });
        const base = (b: Device, path = APP) => b.cs.currentBinding()!.lastSynced.get(path);

        it("equal: the old lastSynced is the base, and an unpushed edit survives", async () => {
            const v1 = await fx(APP, { a: 1, b: 1 }, { "dev-A": 1 });
            await seedRemoteConfig(remote, [v1]);
            const b = await oldDevice([v1], { [APP]: JSON.stringify({ a: 1, b: 2 }) });

            expect(await b.cs.pull()).toBe(0);

            expect(json(b)).toEqual({ a: 1, b: 2 });
            expect(base(b)!.vclock).toEqual({ "dev-A": 1 });
            expect(await b.store.getMeta("_sync/config-push-seq")).toBeNull();
            expect(await b.store.getMeta(META_CONFIG_BASE_MIGRATED)).toBe(1);
            expect(await b.cs.push()).toBe(1);
        });

        it("dominated: the old lastSynced is the base, and the remote change merges in", async () => {
            const v1 = await fx(APP, { a: 1, b: 1 }, { "dev-A": 1 });
            const v2 = await fx(APP, { a: 9, b: 1 }, { "dev-A": 2 });
            await seedRemoteConfig(remote, [v1]);
            await seedRemoteConfig(remote, [v2]);
            const b = await oldDevice([v1], { [APP]: JSON.stringify({ a: 1, b: 2 }) });

            expect(await b.cs.pull()).toBe(1);

            expect(json(b)).toEqual({ a: 9, b: 2 });
            expect(base(b)!.vclock).toEqual({ "dev-A": 2 });
        });

        it("dominates: an unsent scan takes the server doc as its base and keeps the edit", async () => {
            const v1 = await fx(APP, { a: 1, b: 1 }, { "dev-A": 1 });
            const scanned = await fx(APP, { a: 1, b: 2 }, { "dev-A": 1, "dev-B": 1 });
            await seedRemoteConfig(remote, [v1]);
            const b = await oldDevice([scanned], { [APP]: JSON.stringify({ a: 1, b: 2 }) });

            expect(await b.cs.pull()).toBe(0);

            expect(json(b)).toEqual({ a: 1, b: 2 });
            expect(base(b)!.vclock).toEqual({ "dev-A": 1 });
            expect((await b.store.get(makeConfigId(APP)))!.vclock).toEqual({ "dev-A": 1 });
            expect(await b.cs.push()).toBe(1);
            expect((await serverDoc())!.vclock).toEqual({ "dev-A": 1, "dev-B": 1 });
        });

        it("concurrent: no base; differing keys keep the local value and are reported", async () => {
            const v1 = await fx(APP, { k: 0 }, { "dev-A": 1 });
            const scanned = await fx(APP, { k: "b" }, { "dev-A": 1, "dev-B": 1 });
            const v2 = await fx(APP, { k: "a", r: 1 }, { "dev-A": 2 });
            await seedRemoteConfig(remote, [v1]);
            await seedRemoteConfig(remote, [v2]);
            const b = await oldDevice([scanned], { [APP]: JSON.stringify({ k: "b" }) });

            expect(await b.cs.pull()).toBe(1);

            expect(json(b)).toEqual({ k: "b", r: 1 });
            expect(warnings().find((w) => w.includes("both sides changed"))).toContain(`${APP}: /k`);
            expect(base(b)!.vclock).toEqual({ "dev-A": 2 });
            expect(await b.store.getMeta(configLocalFirstKey(APP))).toBeNull();
        });

        it("same vclock, other chunks: handled like concurrent", async () => {
            const server = await fx(APP, { k: "a" }, { "dev-A": 1 });
            const mine = await fx(APP, { k: "b" }, { "dev-A": 1 });
            await seedRemoteConfig(remote, [server]);
            const b = await oldDevice([mine], { [APP]: JSON.stringify({ k: "b" }) });

            expect(await b.cs.pull()).toBe(0);

            expect(json(b)).toEqual({ k: "b" });
            expect(warnings().find((w) => w.includes("both sides changed"))).toContain(`${APP}: /k`);
        });

        it("not on the server: no base, the unsent doc is dropped, and Push sends the file as new", async () => {
            const mine = await fx(APP, { n: 1 }, { "dev-B": 1 });
            const b = await oldDevice([mine], { [APP]: JSON.stringify({ n: 1 }) });

            expect(await b.cs.pull()).toBe(0);

            expect(base(b)).toBeUndefined();
            expect(await b.store.get(makeConfigId(APP))).toBeNull();
            expect(await b.cs.push()).toBe(1);
            expect((await serverDoc())!.vclock).toEqual({ "dev-B": 1 });
        });

        it("not taking part in sharing here: the base is dropped, so the shared value arrives later", async () => {
            const DATA = ".obsidian/plugins/foo/data.json";
            const v1 = await fx(DATA, { s: 1 }, { "dev-A": 1 });
            await seedRemoteConfig(remote, [v1]);
            const b = await oldDevice([v1], {});

            expect(await b.cs.pull()).toBe(0);
            expect(base(b, DATA)).toBeUndefined();

            // The plugin gets installed, with its defaults on disk.
            b.vault.addFile(".obsidian/plugins/foo/manifest.json", `{"id":"foo"}`);
            b.vault.addFile(DATA, JSON.stringify({ s: 0, d: 1 }));
            expect(await b.cs.pull()).toBe(1);
            expect(json(b, DATA)).toEqual({ s: 1, d: 1 });
        });

        it("runs once", async () => {
            const v1 = await fx(APP, { a: 1 }, { "dev-A": 1 });
            await seedRemoteConfig(remote, [v1]);
            const b = await oldDevice([v1], { [APP]: JSON.stringify({ a: 1 }) });
            await b.cs.pull();
            const allDocs = vi.spyOn(remote, "allDocs");

            await b.cs.pull();

            expect(allDocs).not.toHaveBeenCalled();
        });
    });
});
