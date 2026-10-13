/**
 * Config sync failures must never be silent (config-binding design, stage 1).
 *
 * The bug: Push / Pull ran their pre-checks (not configured, setup flag,
 * codec, another op in flight) BEFORE the ProgressNotice existed, and the
 * settings tab swallowed the throw — pressing Pull did nothing, with no
 * notice and no log line. Every pre-check now throws a typed
 * `ConfigNotReadyError` from inside the op runner, so the failure always
 * reaches `ProgressNotice.fail`, which writes the error log.
 *
 * Also covers the filter tree's remote-listing classification (it used to
 * report every failure as "Server not reachable").
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { ConfigSync } from "../src/sync/config-sync.ts";
import {
    ConfigNotReadyError,
    configNotReady,
    classifyConfigRemoteFailure,
    describeConfigRemoteFailure,
} from "../src/sync/config-errors.ts";
import { ConfigLocalDB } from "../src/db/config-local-db.ts";
import { AuthGate } from "../src/db/sync/auth-gate.ts";
import { ALWAYS_VISIBLE } from "../src/db/visibility-gate.ts";
import { EncryptingCouchClient } from "../src/db/encrypting-couch-client.ts";
import {
    createCryptoProvider,
    deriveKeys,
    generateSalt,
} from "../src/db/crypto-provider.ts";
import { getLogEntries, clearLog } from "../src/ui/log.ts";
import type { ICouchClient, DbInfo } from "../src/db/interfaces.ts";
import type { ReconnectBridge } from "../src/sync/reconnect-bridge.ts";
import { FakeCouchClient } from "./helpers/fake-couch-client.ts";
import { FakeVaultIO } from "./helpers/fake-vault-io.ts";
import { FakeModalPresenter } from "./helpers/fake-modal-presenter.ts";
import { makeSettings } from "./helpers/settings-factory.ts";
import { makeConfigFixture } from "./helpers/config-fixture.ts";
import { attachPlain, putEntry } from "./helpers/config-attach.ts";

let counter = 0;
function uniqueName() { return `cs-fail-${Date.now()}-${counter++}`; }

function errorLogs(): string[] {
    return getLogEntries().filter((e) => e.level === "error").map((e) => e.message);
}

/** FakeCouchClient whose reachability probe parks until released — holds an
 *  op in flight so a second op can be started against it. */
class ParkedCouchClient extends FakeCouchClient {
    private release!: () => void;
    private readonly gate = new Promise<void>((r) => { this.release = r; });
    parked = false;
    async info(signal?: AbortSignal): Promise<DbInfo> {
        this.parked = true;
        await this.gate;
        return super.info(signal);
    }
    unpark(): void { this.release(); }
}

/** FakeCouchClient whose allDocs throws the given error. */
class FailingListClient extends FakeCouchClient {
    constructor(private readonly err: unknown) { super(); }
    async allDocs(): Promise<never> { throw this.err; }
}

function httpError(status: number, message: string): Error {
    const e: any = new Error(message);
    e.status = status;
    return e;
}

describe("ConfigSync — failures are surfaced, never swallowed", () => {
    let vault: FakeVaultIO;
    let db: ConfigLocalDB;
    let auth: AuthGate;
    let settings: ReturnType<typeof makeSettings>;
    let bridge: ReconnectBridge & { notifyTransient: ReturnType<typeof vi.fn> };

    /** A ConfigSync over the test's `db`, bound to the settings' DB name
     *  (left unbound when `bind` is false or no name is set). */
    async function makeSync(
        clientFactory: () => ICouchClient | null,
        bind = true,
    ): Promise<ConfigSync> {
        const cs = new ConfigSync(
            vault, new FakeModalPresenter(), "test-vault", auth, ALWAYS_VISIBLE, bridge,
            () => settings,
            { storeFactory: () => db, clientFactory, rawClientFactory: clientFactory },
        );
        if (bind) await cs.rebind(settings.couchdbConfigDbName || null);
        return cs;
    }

    beforeEach(() => {
        clearLog();
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vault = new FakeVaultIO();
        db = new ConfigLocalDB(uniqueName());
        db.open();
        auth = new AuthGate();
        bridge = { notifyTransient: vi.fn() };
        settings = makeSettings({
            deviceId: "dev-A",
            couchdbUri: "http://localhost:5984",
            couchdbConfigDbName: "config-test",
            compressionEnabled: false,
        });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await db.destroy().catch(() => {});
    });

    describe("pre-checks report through ProgressNotice + log", () => {
        it("not configured: Push fails with a typed error AND an error log line", async () => {
            settings.couchdbConfigDbName = "";
            const cs = await makeSync(() => new FakeCouchClient());
            await expect(cs.push()).rejects.toMatchObject({
                name: "ConfigNotReadyError",
                kind: "not-configured",
            });
            expect(errorLogs()).toEqual([
                "Config Push failed — Config sync is not configured — apply a config database name in Step 2.",
            ]);
        });

        it("DB name set but not bound (store failed to open): Pull says to re-apply", async () => {
            // Apply rebinds immediately, so a name without a binding only
            // happens when opening its store failed. Pull used to do nothing.
            const cs = await makeSync(() => new FakeCouchClient(), false);
            await expect(cs.pull()).rejects.toMatchObject({ kind: "not-configured" });
            const logs = errorLogs();
            expect(logs).toHaveLength(1);
            expect(logs[0]).toMatch(/^Config Pull failed — Config database "config-test" is not active/);
            expect(logs[0]).toMatch(/Apply the name again/);
        });

        it("setup flag: Pull fails as setup-interrupted and recommends Create", async () => {
            putEntry(settings, { settingUp: true });
            const cs = await makeSync(() => new FakeCouchClient());
            await expect(cs.pull()).rejects.toMatchObject({
                kind: "setup-interrupted",
                message: expect.stringMatching(/run Create in Step 3/),
            });
            expect(errorLogs()[0]).toMatch(/^Config Pull failed — Create was interrupted/);
        });

        it("a Step 1 codec change is not a failure: Push runs with the joined codec, nothing is logged as an error", async () => {
            const remote = new FakeCouchClient();
            await attachPlain(settings, remote, db);
            settings.configCompressionEnabled = true;
            settings.configEncryptionEnabled = true;
            settings.configEncryptionPassphrase = "p";
            vault.addFile(".obsidian/app.json", "{}");
            const cs = await makeSync(() => remote);
            await expect(cs.push()).resolves.toBe(1);
            expect(errorLogs()).toEqual([]);
        });

        it("pre-check failures never reach the reconnect bridge", async () => {
            putEntry(settings, { settingUp: true });
            const cs = await makeSync(() => new FakeCouchClient());
            await expect(cs.pull()).rejects.toBeInstanceOf(ConfigNotReadyError);
            expect(bridge.notifyTransient).not.toHaveBeenCalled();
        });
    });

    describe("in-flight rejection", () => {
        it("a second op while one runs is reported as busy, and the first op keeps its lock", async () => {
            const remote = new ParkedCouchClient();
            await attachPlain(settings, remote, db);
            const cs = await makeSync(() => remote);

            const first = cs.pull();
            await vi.waitFor(() => expect(remote.parked).toBe(true));
            expect(cs.isInflight()).toBe(true);

            await expect(cs.push()).rejects.toMatchObject({ kind: "busy" });
            expect(errorLogs()).toEqual([
                expect.stringMatching(/^Config Push failed — Another config operation is already in progress/),
            ]);
            // The rejected op must not have released the running op's lock.
            expect(cs.isInflight()).toBe(true);

            remote.unpark();
            await expect(first).resolves.toBe(0);
            expect(cs.isInflight()).toBe(false);
        });
    });

    describe("missing config key (wrapped client build)", () => {
        const keyMissing = () => new ConfigNotReadyError(
            "key-missing", "Config DB is encrypted, but its key is not unlocked on this device.",
        );

        it("Pull reports key-missing, recommends no Init, and does not notify the bridge", async () => {
            const cs = await makeSync(() => { throw keyMissing(); });
            const err = await cs.pull().catch((e) => e);
            expect(err).toBeInstanceOf(ConfigNotReadyError);
            expect(err.kind).toBe("key-missing");
            expect(err.message).not.toMatch(/Create|Init/);
            expect(errorLogs()[0]).toMatch(/^Config Pull failed — Config DB is encrypted, but its key/);
            expect(bridge.notifyTransient).not.toHaveBeenCalled();
        });
    });

    describe("transport failures are still reported", () => {
        it("an unreachable server is reported with its cause and fix, keeps the raw error, and nudges the bridge", async () => {
            const remote = new FakeCouchClient();
            remote.info = async () => { throw new TypeError("Failed to fetch"); };
            const cs = await makeSync(() => remote);
            await expect(cs.pull()).rejects.toThrow(/Failed to fetch/);
            const line = errorLogs()[0];
            expect(line).toMatch(/^Config Pull failed — The server could not be reached/);
            expect(line).toMatch(/server URI in the CouchDB tab/);
            expect(line).toMatch(/\(Failed to fetch\)$/);
            expect(bridge.notifyTransient).toHaveBeenCalledTimes(1);
        });

        it("an auth latch refusal names the CouchDB tab, not Vault Sync", async () => {
            auth.raise(401, "bad creds");
            const cs = await makeSync(() => new FakeCouchClient());
            await expect(cs.pull()).rejects.toMatchObject({ name: "AuthBlockedError" });
            const line = errorLogs()[0];
            expect(line).toMatch(/^Config Pull failed — The server rejected the credentials \(401\)/);
            expect(line).toMatch(/CouchDB tab, then press Test/);
            expect(line).not.toMatch(/Vault Sync/);
        });
    });
});

describe("configNotReady messages — where Create is advised", () => {
    // The message is the only carrier of a kind's advice (the former
    // `createRecommended` flag was never read by the UI).
    it("never mentions Create for key / passphrase / reset / tamper problems", () => {
        for (const kind of [
            "key-missing", "passphrase-missing", "passphrase-mismatch",
            "root-changed", "encryption-removed", "cipher-downgrade", "busy",
            "not-configured", "unattached", "device-id-missing",
        ] as const) {
            const msg = configNotReady(kind, { db: "cfg", docCount: 2 }).message;
            expect(msg, kind).not.toMatch(/\bCreate\b/);
            expect(msg, kind).not.toMatch(/\bInit\b/);
        }
    });

    it("names Create (in Step 3) where re-creating is the fix", () => {
        for (const kind of [
            "setup-interrupted", "uninitialized", "db-missing", "legacy-meta", "meta-missing",
        ] as const) {
            const msg = configNotReady(kind, { db: "cfg", docCount: 2, schemaVersion: 1 }).message;
            expect(msg, kind).toMatch(/Create in Step 3/);
        }
    });
});

describe("filter tree remote listing — classified failures", () => {
    let settings: ReturnType<typeof makeSettings>;
    let stores: ConfigLocalDB[];

    beforeEach(() => {
        clearLog();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        settings = makeSettings({
            couchdbUri: "http://localhost:5984",
            couchdbConfigDbName: "config-test",
            compressionEnabled: false,
        });
        stores = [];
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        for (const s of stores) await s.destroy().catch(() => {});
    });

    /** A ConfigSync whose preflight runs against an attached plaintext
     *  remote (`raw`) and whose wrapped client is `clientFactory`'s. */
    async function quietSync(clientFactory: () => ICouchClient | null): Promise<ConfigSync> {
        const raw = new FakeCouchClient();
        const cs = new ConfigSync(
            new FakeVaultIO(), new FakeModalPresenter(), "test-vault", new AuthGate(),
            ALWAYS_VISIBLE, { notifyTransient: () => {} }, () => settings,
            {
                storeFactory: () => {
                    const s = new ConfigLocalDB(uniqueName());
                    stores.push(s);
                    return s;
                },
                clientFactory,
                rawClientFactory: () => raw,
            },
        );
        await cs.rebind(settings.couchdbConfigDbName || null);
        if (settings.couchdbConfigDbName) await attachPlain(settings, raw, cs.currentStore()!);
        return cs;
    }

    it.each([
        ["unreachable", new TypeError("Failed to fetch")],
        ["unreachable", new Error("Request timed out")],
        ["auth", httpError(401, "unauthorized")],
        ["not-found", httpError(404, "not_found")],
        ["other", new Error("boom")],
    ])("classifies a listing failure as %s", async (kind, err) => {
        const res = await (await quietSync(() => new FailingListClient(err))).listRemoteConfigPathsQuiet();
        expect(res.paths).toEqual([]);
        expect(res.failure?.kind).toBe(kind);
        // Logged, not silently dropped.
        expect(getLogEntries().some(
            (e) => e.level === "warn" && e.message.includes(`config remote listing failed (${kind})`),
        )).toBe(true);
    });

    it("classifies a missing config key as not-ready / key-missing", async () => {
        const res = await (await quietSync(() => {
            throw new ConfigNotReadyError("key-missing", "key not unlocked");
        })).listRemoteConfigPathsQuiet();
        expect(res.failure).toEqual({
            kind: "not-ready", notReady: "key-missing", message: "key not unlocked",
        });
    });

    it("reads encrypted `config:<hmac>` ids through the wrapped client as plaintext paths", async () => {
        const crypto = createCryptoProvider(await deriveKeys("pw", generateSalt()));
        const raw = new FakeCouchClient();
        const enc = new EncryptingCouchClient(raw, crypto, 3);
        const { doc } = await makeConfigFixture(".obsidian/app.json", "{}");
        await enc.bulkDocs([doc]);

        // The server only ever sees the HMAC'd id.
        const rawIds = (await raw.allDocs({ startkey: "config:", endkey: "config:￰" }))
            .rows.map((r) => r.id);
        expect(rawIds).toHaveLength(1);
        expect(rawIds[0]).not.toBe("config:.obsidian/app.json");

        const cs = await quietSync(() => enc);
        const res = await cs.listRemoteConfigPathsQuiet();
        expect(res).toEqual({
            paths: [".obsidian/app.json"], failure: null, bindingKey: cs.currentBinding()!.key,
        });
    });

    it("an unconfigured DB name is not a failure (empty listing)", async () => {
        settings.couchdbConfigDbName = "";
        const res = await (await quietSync(() => null)).listRemoteConfigPathsQuiet();
        expect(res).toEqual({ paths: [], failure: null, bindingKey: null });
    });
});

describe("describeConfigRemoteFailure", () => {
    it("names the cause instead of always saying 'Server not reachable'", () => {
        const f = classifyConfigRemoteFailure;
        expect(describeConfigRemoteFailure(f(new TypeError("Failed to fetch"))))
            .toMatch(/^Server not reachable/);
        expect(describeConfigRemoteFailure(f(httpError(403, "forbidden"))))
            .toMatch(/CouchDB tab/);
        expect(describeConfigRemoteFailure(f(httpError(404, "missing"))))
            .toMatch(/not found on the server/);
        const keyLine = describeConfigRemoteFailure(
            f(new ConfigNotReadyError("key-missing", "Config key not unlocked.")),
        );
        expect(keyLine).toMatch(/^Config key not unlocked\./);
        expect(keyLine).not.toMatch(/not reachable/);
        expect(describeConfigRemoteFailure(f(new Error("boom")))).toMatch(/boom/);
    });

    it("always states the local-only fallback", () => {
        for (const err of [new TypeError("Failed to fetch"), httpError(401, "x"), new Error("y")]) {
            expect(describeConfigRemoteFailure(classifyConfigRemoteFailure(err)))
                .toMatch(/this device's config only/);
        }
    });
});
