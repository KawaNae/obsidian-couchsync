/**
 * VaultBinding — Init and Clone run as a preparation that changes nothing
 * and an execution that is destructive. A failure in the preparation
 * leaves the setup state and live sync as they were; the execution stops
 * live sync and persists `settingUp` before the first destructive step.
 * Every run ends at one exit: the outcome is recorded (not for a busy
 * refusal or a cancellation) and the notice words the error.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { VaultBinding, type VaultBindingHost, type AskVaultPassphrase } from "../src/sync/vault-binding.ts";
import { AuthGate } from "../src/db/sync/auth-gate.ts";
import { buildInitialVaultMeta, fetchVaultMeta, pushVaultMeta } from "../src/db/vault-meta.ts";
import { FakeCouchClient } from "./helpers/fake-couch-client.ts";
import { makeSettings } from "./helpers/settings-factory.ts";
import type { CouchSyncSettings } from "../src/settings.ts";
import type { ICouchClient } from "../src/db/interfaces.ts";

interface Rig {
    binding: VaultBinding;
    settings: CouchSyncSettings;
    remote: FakeCouchClient;
    auth: AuthGate;
    stops: number;
    saves: CouchSyncSettings["connectionState"][];
    /** connectionState seen when the destructive setup step started. */
    stateAtSetup: CouchSyncSettings["connectionState"] | null;
    failures: unknown[];
    dones: string[];
    setupError: Error | null;
    /** When set, the destructive step waits for it. */
    setupGate: Promise<void> | null;
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
        stops: 0, saves: [], stateAtSetup: null, failures: [], dones: [], setupError: null, setupGate: null,
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
        expect(r.binding.outcomesNow().lastOp).toMatchObject({ op: "init", error: expect.any(Error) });
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
        expect(r.binding.outcomesNow().lastOp).toMatchObject({ op: "init", error: null });
    });

    it("a failure in the execution leaves settingUp", async () => {
        const r = rig();
        r.setupError = new Error("disk full");
        await expect(r.binding.init()).rejects.toThrow("disk full");
        expect(r.settings.connectionState).toBe("settingUp");
        expect(r.binding.outcomesNow().lastOp?.error).toBe(r.setupError);
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
        expect(r.binding.outcomesNow().lastOp).toMatchObject({ op: "init", error: null });
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
        expect(r.binding.outcomesNow().lastOp).toBeNull();
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
        expect(r.binding.outcomesNow().lastOp).not.toBeNull();
        r.settings.couchdbDbName = "other";
        expect(r.binding.outcomesNow().lastOp).toBeNull();
    });
});
