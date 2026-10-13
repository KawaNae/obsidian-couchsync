/**
 * VaultBinding — Init and Clone run as a preparation that changes nothing
 * and an execution that is destructive. A failure in the preparation
 * leaves the setup state and live sync as they were; the execution stops
 * live sync and persists `settingUp` before the first destructive step.
 * Every run ends at one exit: the outcome is recorded (not for a busy
 * refusal or a cancellation) and the notice words the error.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
    VaultBinding, VaultEncryptionPausedError, type VaultBindingHost, type AskVaultPassphrase,
} from "../src/sync/vault-binding.ts";
import { classifyError } from "../src/db/sync/errors.ts";
import { AuthGate } from "../src/db/sync/auth-gate.ts";
import { buildInitialVaultMeta, fetchVaultMeta, pushVaultMeta } from "../src/db/vault-meta.ts";
import { FakeCouchClient } from "./helpers/fake-couch-client.ts";
import { makeSettings } from "./helpers/settings-factory.ts";
import type { CouchSyncSettings } from "../src/settings.ts";
import type { ICouchClient } from "../src/db/interfaces.ts";
import type { DbCheckResult } from "../src/db/sync/vault-remote-ops.ts";

interface Rig {
    binding: VaultBinding;
    settings: CouchSyncSettings;
    remote: FakeCouchClient;
    auth: AuthGate;
    stops: number;
    starts: number;
    saves: CouchSyncSettings["connectionState"][];
    /** connectionState seen when the destructive setup step started. */
    stateAtSetup: CouchSyncSettings["connectionState"] | null;
    failures: unknown[];
    dones: string[];
    setupError: Error | null;
    /** When set, the destructive step waits for it. */
    setupGate: Promise<void> | null;
    dbCheckResult: DbCheckResult;
}

function rig(opts: {
    settings?: Partial<CouchSyncSettings>;
    ask?: AskVaultPassphrase;
    client?: (remote: FakeCouchClient) => ICouchClient;
} = {}): Rig {
    const settings = makeSettings({
        couchdbUri: "http://couch.test:5984",
        couchdbDbName: "vault",
        connectionState: "setupDone",
        ...opts.settings,
    });
    const remote = new FakeCouchClient();
    const r: Rig = {
        binding: null as unknown as VaultBinding,
        settings, remote, auth: new AuthGate(),
        stops: 0, starts: 0, saves: [], stateAtSetup: null, failures: [], dones: [], setupError: null, setupGate: null,
        dbCheckResult: { status: "exists", docCount: 5 },
    };
    const result = { vaultFiles: 3, totalDocs: 7 };
    const host: VaultBindingHost = {
        getSettings: () => settings,
        saveSettings: async () => { r.saves.push(settings.connectionState); },
        auth: r.auth,
        makeRawClient: () => (opts.client ? opts.client(remote) : remote),
        setup: () => ({
            init: async () => {
                r.stateAtSetup = settings.connectionState;
                await r.setupGate;
                if (r.setupError) throw r.setupError;
                return result;
            },
            clone: async () => {
                r.stateAtSetup = settings.connectionState;
                if (r.setupError) throw r.setupError;
                return result;
            },
        }),
        stopLive: () => { r.stops++; },
        startLive: async () => { r.starts++; },
        checkDatabase: async () => r.dbCheckResult,
        openProgress: () => ({
            update: () => {},
            done: (s) => { r.dones.push(s); },
            fail: (e) => { r.failures.push(e); },
        }),
        askPassphrase: opts.ask ?? (async () => null),
    };
    r.binding = new VaultBinding(host);
    return r;
}

function unreachable(remote: FakeCouchClient): ICouchClient {
    return new Proxy(remote, {
        get(target, prop, recv) {
            if (prop === "withTimeout") return () => unreachable(remote);
            if (prop === "info") return async () => { throw new TypeError("Failed to fetch"); };
            return Reflect.get(target, prop, recv);
        },
    });
}

function rejecting(status: number): (remote: FakeCouchClient) => ICouchClient {
    const fail = (remote: FakeCouchClient): ICouchClient => new Proxy(remote, {
        get(target, prop, recv) {
            if (prop === "withTimeout") return () => fail(remote);
            if (prop === "info") {
                return async () => { throw Object.assign(new Error("unauthorized"), { status }); };
            }
            return Reflect.get(target, prop, recv);
        },
    });
    return fail;
}

async function encryptedRemote(remote: FakeCouchClient, passphrase: string): Promise<void> {
    const built = await buildInitialVaultMeta({ encryption: true, passphrase, compression: true });
    await pushVaultMeta(remote, built.meta);
}

describe("VaultBinding.init", () => {
    it("a preparation failure changes nothing: no stop, no settingUp, recorded and reported", async () => {
        const r = rig({ settings: { encryptionEnabled: true, encryptionPassphrase: "" } });
        await expect(r.binding.init()).rejects.toThrow(/no passphrase is set/);
        expect(r.stops).toBe(0);
        expect(r.settings.connectionState).toBe("setupDone");
        expect(r.saves).toEqual([]);
        expect(r.failures).toHaveLength(1);
        expect(r.binding.relation().lastOp).toMatchObject({ op: "init", error: expect.any(Error) });
    });

    it("an unreachable server fails the preparation before the local DB is touched", async () => {
        const r = rig({ client: unreachable });
        await expect(r.binding.init()).rejects.toThrow(/Failed to fetch/);
        expect(r.stateAtSetup).toBeNull();
        expect(r.stops).toBe(0);
        expect(r.settings.connectionState).toBe("setupDone");
    });

    it("a 401 raises the auth latch", async () => {
        const r = rig({ client: rejecting(401) });
        await expect(r.binding.init()).rejects.toThrow();
        expect(r.auth.isBlocked()).toBe(true);
    });

    it("is refused while the auth latch is raised", async () => {
        const r = rig();
        r.auth.raise(401, "nope");
        await expect(r.binding.init()).rejects.toThrow(/rejected the credentials/);
        expect(r.stops).toBe(0);
        expect(r.stateAtSetup).toBeNull();
    });

    it("stops live sync and persists settingUp before the destructive step, setupDone after", async () => {
        const r = rig();
        await r.binding.init();
        expect(r.stops).toBe(1);
        expect(r.stateAtSetup).toBe("settingUp");
        expect(r.saves[0]).toBe("settingUp");
        expect(r.settings.connectionState).toBe("setupDone");
        expect(await fetchVaultMeta(r.remote)).toMatchObject({ type: "vault-meta" });
        expect(r.dones).toEqual(["3 files, 7 docs pushed (compressed)."]);
        expect(r.binding.relation().lastOp).toMatchObject({ op: "init", error: null });
    });

    it("a failure in the execution leaves settingUp", async () => {
        const r = rig();
        r.setupError = new Error("disk full");
        await expect(r.binding.init()).rejects.toThrow("disk full");
        expect(r.settings.connectionState).toBe("settingUp");
        expect(r.binding.relation().lastOp?.error).toBe(r.setupError);
    });

    it("a second run while one is in flight is refused and not recorded", async () => {
        const r = rig();
        let release!: () => void;
        r.setupGate = new Promise<void>((res) => { release = res; });
        const first = r.binding.init();
        await new Promise((res) => setTimeout(res, 0));
        expect(r.binding.busy()).toBe("init");
        await expect(r.binding.clone()).rejects.toThrow(/Init is running/);
        expect(r.failures).toHaveLength(1);
        release();
        await first;
        expect(r.binding.relation().lastOp).toMatchObject({ op: "init", error: null });
    });
});

describe("VaultBinding.clone", () => {
    let asked: string[];
    beforeEach(() => { asked = []; });

    it("unlocks with the Step 1 passphrase and commits the remote's codec on success", async () => {
        const r = rig({ settings: { encryptionEnabled: false, encryptionPassphrase: "pw", compressionEnabled: false } });
        await encryptedRemote(r.remote, "pw");
        await r.binding.clone();
        expect(r.settings).toMatchObject({
            encryptionEnabled: true, encryptionPassphrase: "pw", compressionEnabled: true,
            vaultCipherVersion: 3, connectionState: "setupDone",
        });
        expect(r.stateAtSetup).toBe("settingUp");
    });

    it("asks when the passphrase at hand does not unlock; the prompt checks each answer", async () => {
        const r = rig({
            settings: { encryptionPassphrase: "old" },
            ask: async (reason, tryUnlock) => {
                asked.push(reason);
                expect(await tryUnlock("wrong")).toBe(false);
                expect(await tryUnlock("pw")).toBe(true);
                return "pw";
            },
        });
        await encryptedRemote(r.remote, "pw");
        await r.binding.clone();
        expect(asked).toEqual(["mismatch"]);
        expect(r.settings.encryptionPassphrase).toBe("pw");
    });

    it("a cancelled prompt changes nothing and is not recorded", async () => {
        const r = rig({
            settings: { encryptionPassphrase: "" },
            ask: async (reason) => { asked.push(reason); return null; },
        });
        await encryptedRemote(r.remote, "pw");
        await expect(r.binding.clone()).rejects.toMatchObject({ name: "AbortError" });
        expect(asked).toEqual(["missing"]);
        expect(r.stops).toBe(0);
        expect(r.settings.connectionState).toBe("setupDone");
        expect(r.binding.relation().lastOp).toBeNull();
    });

    it("a failure in the execution commits no codec setting and leaves settingUp", async () => {
        const r = rig({ settings: { encryptionEnabled: false, encryptionPassphrase: "pw", compressionEnabled: false } });
        await encryptedRemote(r.remote, "pw");
        r.setupError = new Error("pull failed");
        await expect(r.binding.clone()).rejects.toThrow("pull failed");
        expect(r.settings).toMatchObject({
            encryptionEnabled: false, compressionEnabled: false, connectionState: "settingUp",
        });
        expect(r.settings.vaultCipherVersion).toBeUndefined();
    });

    it("an outcome about another vault DB is not shown", async () => {
        const r = rig({ client: unreachable });
        await expect(r.binding.clone()).rejects.toThrow();
        expect(r.binding.relation().lastOp).not.toBeNull();
        r.settings.couchdbDbName = "other";
        expect(r.binding.relation().lastOp).toBeNull();
    });
});

describe("VaultBinding.checkAgreement", () => {
    const signal = new AbortController().signal;

    it("encryption changed by another device: pauses to tested and records why", async () => {
        const r = rig({ settings: { connectionState: "syncing", encryptionEnabled: false } });
        await encryptedRemote(r.remote, "pw");
        const err = await r.binding.checkAgreement(signal).catch((e) => e);
        expect(err).toBeInstanceOf(VaultEncryptionPausedError);
        expect(err).toMatchObject({ reason: "encryption-changed", encryptionPaused: true });
        expect(err.userMessage).toMatch(/^Sync paused — another device turned vault encryption on\./);
        expect(r.settings.connectionState).toBe("tested");
        expect(r.binding.relation().lastCheck).toMatchObject({ op: "agreement", error: err });
        // The engine halts on it and shows its own sentence.
        expect(classifyError(err)).toEqual({ kind: "encryption-paused", message: err.userMessage });
    });

    it("a wrong stored passphrase pauses and clears it", async () => {
        const r = rig({
            settings: { connectionState: "syncing", encryptionEnabled: true, encryptionPassphrase: "old" },
        });
        await encryptedRemote(r.remote, "pw");
        await expect(r.binding.checkAgreement(signal)).rejects.toMatchObject({ reason: "passphrase-mismatch" });
        expect(r.settings).toMatchObject({ connectionState: "tested", encryptionPassphrase: "" });
    });

    it("an agreed vault unlocks, takes the server's compression flag and records a passed check", async () => {
        const r = rig({
            settings: {
                connectionState: "syncing", encryptionEnabled: true, encryptionPassphrase: "pw",
                compressionEnabled: false,
            },
        });
        await encryptedRemote(r.remote, "pw");
        await r.binding.checkAgreement(signal);
        expect(r.settings).toMatchObject({ connectionState: "syncing", compressionEnabled: true, vaultCipherVersion: 3 });
        expect(r.binding.chunkHasher.alg).toBe("hmac");
        expect(r.binding.relation().lastCheck).toMatchObject({ op: "agreement", error: null });
    });

    it("a transient failure is thrown as is and not recorded", async () => {
        const failing = (remote: FakeCouchClient): ICouchClient => new Proxy(remote, {
            get(target, prop, recv) {
                if (prop === "getDoc") return async () => { throw new TypeError("Failed to fetch"); };
                return Reflect.get(target, prop, recv);
            },
        });
        const r = rig({ settings: { connectionState: "syncing" }, client: failing });
        await expect(r.binding.checkAgreement(signal)).rejects.toThrow("Failed to fetch");
        expect(r.settings.connectionState).toBe("syncing");
        expect(r.binding.relation().lastCheck).toBeNull();
    });

    it("a successful Init clears the recorded pause", async () => {
        const r = rig({ settings: { connectionState: "syncing", encryptionEnabled: false } });
        await encryptedRemote(r.remote, "pw");
        await r.binding.checkAgreement(signal).catch(() => {});
        await r.binding.init();
        expect(r.binding.relation()).toMatchObject({ lastOp: { op: "init", error: null }, lastCheck: null });
    });
});

describe("VaultBinding: the one writer of the setup state", () => {
    it("Live Sync turns on only from setupDone, and off back to setupDone", async () => {
        const r = rig({ settings: { connectionState: "tested" } });
        await expect(r.binding.setLiveSync(true)).rejects.toThrow(/Run Init or Clone/);
        expect(r.starts).toBe(0);
        r.settings.connectionState = "setupDone";
        await r.binding.setLiveSync(true);
        expect(r.settings.connectionState).toBe("syncing");
        expect(r.starts).toBe(1);
        await r.binding.setLiveSync(false);
        expect(r.settings.connectionState).toBe("setupDone");
        expect(r.stops).toBe(1);
    });

    it("Step 2 Apply selects the DB and asks for a setup", async () => {
        const r = rig();
        await r.binding.applyDatabase("other");
        expect(r.settings).toMatchObject({ couchdbDbName: "other", connectionState: "tested" });
    });

    it("a Step 1 codec change drops a finished setup to tested, not a broken one", async () => {
        const r = rig();
        await r.binding.changeCodecSetting({ compressionEnabled: false });
        expect(r.settings).toMatchObject({ compressionEnabled: false, connectionState: "tested" });
        r.settings.connectionState = "settingUp";
        await r.binding.changeCodecSetting({ compressionEnabled: true });
        expect(r.settings.connectionState).toBe("settingUp");
    });

    it("new server credentials send the setup back to editing", async () => {
        const r = rig();
        await r.binding.applyServer({ couchdbUser: "u2", serverTested: true }, true);
        expect(r.settings).toMatchObject({ couchdbUser: "u2", connectionState: "editing" });
    });

    it("every writer is refused while Init or Clone runs", async () => {
        const r = rig();
        let release!: () => void;
        r.setupGate = new Promise<void>((res) => { release = res; });
        const running = r.binding.init();
        await new Promise((res) => setTimeout(res, 0));
        expect(r.binding.changeBlocker()).toMatch(/Init is running/);
        await expect(r.binding.setLiveSync(true)).rejects.toThrow(/Init is running/);
        await expect(r.binding.applyDatabase("x")).rejects.toThrow(/Init is running/);
        await expect(r.binding.changeCodecSetting({ compressionEnabled: false })).rejects.toThrow(/Init is running/);
        await expect(r.binding.applyServer({ couchdbUser: "x" }, true)).rejects.toThrow(/Init is running/);
        expect(r.settings.couchdbDbName).toBe("vault");
        release();
        await running;
        expect(r.binding.changeBlocker()).toBeNull();
    });
});

describe("VaultBinding.checkDatabase", () => {
    it("keeps the result for the DB it checked; a success clears the auth latch", async () => {
        const r = rig();
        r.auth.raise(401, "old");
        await r.binding.checkDatabase("vault");
        expect(r.auth.isBlocked()).toBe(false);
        expect(r.dones).toEqual(['"vault" found — 5 docs.']);
        expect(r.binding.relation().dbCheck?.result).toEqual({ status: "exists", docCount: 5 });
        expect(r.binding.dbCheckFor("other")).toBeNull();
    });

    it("a failure goes to the notice as the error itself", async () => {
        const r = rig();
        const err = new TypeError("Failed to fetch");
        r.dbCheckResult = { status: "error", error: err };
        await r.binding.checkDatabase("vault");
        expect(r.failures).toEqual([err]);
    });
});
