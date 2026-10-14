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
 *   - community-plugins.json merges as a set
 *   - a Pull that writes nothing does not reload and shows one Notice
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
    reloads: number;
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
        const dev = { id, vault, store, settings, reloads: 0 } as Device;
        dev.cs = new ConfigSync(
            vault, new FakeModalPresenter(), `vault-${id}`, new AuthGate(), ALWAYS_VISIBLE,
            NoopReconnectBridge, () => settings,
            {
                storeFactory: () => store,
                rawClientFactory: () => remote,
                getIsMobile: () => opts.mobile ?? false,
                reload: () => { dev.reloads++; },
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

        it("outside the receive policy: the base is dropped, so the shared value arrives later", async () => {
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
