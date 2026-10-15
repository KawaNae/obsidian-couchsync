/**
 * VaultBinding — Init and Clone run as a preparation that changes nothing
 * and an execution that is destructive. A failure in the preparation
 * leaves the setup state and live sync as they were; the execution stops
 * live sync and persists `settingUp` before the first destructive step.
 * Every run ends at one exit: the outcome is recorded (not for a refusal,
 * a cancellation or a rejection of the credentials) and the notice words
 * the error.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { describeError } from "../src/ui/describe-error.ts";
import {
    VaultBinding, VaultEncryptionPausedError, vaultTarget, type VaultBindingHost, type AskVaultPassphrase,
} from "../src/sync/vault-binding.ts";
import { classifyError } from "../src/db/sync/errors.ts";
import { AuthGate } from "../src/db/sync/auth-gate.ts";
import {
    buildInitialVaultMeta, fetchVaultMeta, metaFingerprint, pushVaultMeta, unlockVaultMeta,
} from "../src/db/vault-meta.ts";
import { FakeCouchClient } from "./helpers/fake-couch-client.ts";
import { makeSettings } from "./helpers/settings-factory.ts";
import type { CouchSyncSettings } from "../src/settings.ts";
import type { ICouchClient } from "../src/db/interfaces.ts";
import type { DbCheckResult } from "../src/db/sync/vault-remote-ops.ts";
import type { VaultSetupPlan } from "../src/sync/vault-setup-confirm.ts";

interface Rig {
    binding: VaultBinding;
    settings: CouchSyncSettings;
    remote: FakeCouchClient;
    auth: AuthGate;
    stops: number;
    starts: number;
    saves: CouchSyncSettings["connectionState"][];
    /** Called when the destructive setup step starts. */
    onSetup: () => void;
    /** connectionState seen when the destructive setup step started. */
    stateAtSetup: CouchSyncSettings["connectionState"] | null;
    failures: unknown[];
    dones: string[];
    setupError: Error | null;
    /** When set, the destructive step waits for it. */
    setupGate: Promise<void> | null;
    dbCheckResult: DbCheckResult;
    /** When set, Step 2's Check waits for it. */
    checkGate: Promise<void> | null;
    /** The plans the confirm dialog was shown, in order. */
    confirmed: VaultSetupPlan[];
    /** The answer to the confirm dialog. */
    confirmAnswer: boolean;
    /** Each host call that asks the user, in order. */
    prompts: ("passphrase" | "confirm")[];
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
        stops: 0, starts: 0, saves: [], stateAtSetup: null, failures: [], dones: [], setupError: null, setupGate: null, onSetup: () => {},
        dbCheckResult: { status: "exists", docCount: 5 }, checkGate: null,
        confirmed: [], confirmAnswer: true, prompts: [],
    };
    const result = { vaultFiles: 3, totalDocs: 7 };
    const host: VaultBindingHost = {
        getSettings: () => settings,
        saveSettings: async () => { r.saves.push(settings.connectionState); },
        auth: r.auth,
        makeRawClient: () => (opts.client ? opts.client(remote) : remote),
        setup: () => ({
            init: async (_progress, publishMeta) => {
                r.stateAtSetup = settings.connectionState;
                r.onSetup();
                await publishMeta();
                await r.setupGate;
                if (r.setupError) throw r.setupError;
                return result;
            },
            clone: async () => {
                r.stateAtSetup = settings.connectionState;
                r.onSetup();
                await r.setupGate;
                if (r.setupError) throw r.setupError;
                return result;
            },
        }),
        stopLive: () => { r.stops++; },
        startLive: async () => { r.starts++; },
        checkDatabase: async () => {
            await r.checkGate;
            return r.dbCheckResult;
        },
        openProgress: () => ({
            update: () => {},
            done: (s) => { r.dones.push(s); },
            fail: (e) => { r.failures.push(e); },
        }),
        askPassphrase: (reason, tryUnlock) => {
            r.prompts.push("passphrase");
            return (opts.ask ?? (async () => null))(reason, tryUnlock);
        },
        confirmSetup: async (plan) => {
            r.prompts.push("confirm");
            r.confirmed.push(plan);
            return r.confirmAnswer;
        },
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

    it("a 401 raises the auth latch, which tells the rejection instead of a recorded outcome", async () => {
        const r = rig({ client: rejecting(401) });
        await expect(r.binding.init()).rejects.toThrow();
        expect(r.auth.isBlocked()).toBe(true);
        expect(r.failures).toHaveLength(1);
        expect(r.binding.relation().lastOp).toBeNull();
    });

    it("is refused while the auth latch is raised, and the refusal is not recorded", async () => {
        const r = rig();
        r.auth.raise(401, "nope");
        await expect(r.binding.init()).rejects.toThrow(/rejected the credentials/);
        expect(r.stops).toBe(0);
        expect(r.stateAtSetup).toBeNull();
        expect(r.failures).toHaveLength(1);
        // The credentials have to be fixed: a failure, not "not started".
        expect(describeError(r.failures[0]).outcome).toBe("failed");
        // Once a Test clears the latch, nothing claims requests are on hold.
        r.auth.clear();
        expect(r.binding.relation().lastOp).toBeNull();
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

    it("reads the DB back, so a Check that found it empty no longer describes it", async () => {
        const r = rig({ settings: { connectionState: "tested" } });
        r.dbCheckResult = { status: "created" };
        await r.binding.checkDatabase("vault");
        await r.binding.init();
        const found = r.binding.relation().dbCheck?.result;
        expect(found?.status).toBe("exists");
        expect(found && found.status === "exists" && found.docCount).toBeGreaterThan(0);
    });

    it("announces the run's start and end", async () => {
        const r = rig();
        const seen: (string | null)[] = [];
        r.binding.onChange(() => seen.push(r.binding.busy()));
        await r.binding.init();
        expect(seen[0]).toBe("init");
        expect(seen[seen.length - 1]).toBeNull();
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
        expect(describeError(r.failures[0])).toEqual({
            text: "Init is running — wait for it to finish.", outcome: "refused",
        });
        release();
        await first;
        expect(r.binding.relation().lastOp).toMatchObject({ op: "init", error: null });
    });

    it("builds the vault from the Step 1 passphrase even when a key is unlocked in this session", async () => {
        const r = rig({ settings: { encryptionEnabled: true, encryptionPassphrase: "old" } });
        await encryptedRemote(r.remote, "old");
        await r.binding.clone();
        const before = await fetchVaultMeta(r.remote);

        r.settings.encryptionPassphrase = "new";
        await r.binding.init();

        const after = await fetchVaultMeta(r.remote);
        expect(after?.encryption.enabled).toBe(true);
        if (!before?.encryption.enabled || !after?.encryption.enabled) throw new Error("unreachable");
        expect(after.encryption.salt).not.toBe(before.encryption.salt);
        expect(after.encryption.keyCheck).not.toBe(before.encryption.keyCheck);
        expect(await unlockVaultMeta(after, "old")).toBeNull();
        const unlocked = await unlockVaultMeta(after, "new");
        expect(unlocked).not.toBeNull();

        // The chunk hasher of every vault client uses the new key.
        const data = new TextEncoder().encode("chunk body");
        expect(await r.binding.chunkHasher.hash(data)).toBe(await unlocked!.crypto.hmacHash(data));
    });

    it("asks to confirm after the preparation, shown what the DB holds and the codec it builds", async () => {
        const r = rig({ settings: { encryptionEnabled: true, encryptionPassphrase: "pw", compressionEnabled: false } });
        await pushVaultMeta(r.remote, (await buildInitialVaultMeta({ encryption: false, compression: true })).meta);
        await r.binding.init();
        expect(r.confirmed).toEqual([{
            op: "init", dbName: "vault", docCount: 1, encryption: true, compression: false,
        }]);
    });

    it("a missing DB is confirmed as one Init creates", async () => {
        const r = rig();
        r.remote.info = async () => { throw Object.assign(new Error("not_found"), { status: 404 }); };
        await r.binding.init();
        expect(r.confirmed[0]).toMatchObject({ op: "init", docCount: null });
    });

    it("a preparation that refuses never asks to confirm", async () => {
        const r = rig({ client: unreachable });
        await expect(r.binding.init()).rejects.toThrow();
        expect(r.confirmed).toEqual([]);
    });

    it("declining changes nothing and is not recorded: no stop, no settingUp, the DB untouched", async () => {
        const r = rig();
        r.confirmAnswer = false;
        await expect(r.binding.init()).rejects.toMatchObject({
            name: "AbortError", message: "Init cancelled — nothing was changed.",
        });
        expect(r.stops).toBe(0);
        expect(r.saves).toEqual([]);
        expect(r.stateAtSetup).toBeNull();
        expect(r.settings.connectionState).toBe("setupDone");
        expect(await fetchVaultMeta(r.remote)).toBeNull();
        expect(r.binding.relation().lastOp).toBeNull();
        expect(r.binding.busy()).toBeNull();
    });

    it("mints a fresh salt on each Init with the same passphrase", async () => {
        const r = rig({ settings: { encryptionEnabled: true, encryptionPassphrase: "pw" } });
        await r.binding.init();
        const first = await fetchVaultMeta(r.remote);
        await r.binding.init();
        const second = await fetchVaultMeta(r.remote);
        if (!first?.encryption.enabled || !second?.encryption.enabled) throw new Error("not encrypted");
        expect(second.encryption.salt).not.toBe(first.encryption.salt);
        expect(await unlockVaultMeta(second, "pw")).not.toBeNull();
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

    it("pulls through the encrypt layer although Step 1 has encryption off", async () => {
        const r = rig({ settings: { encryptionEnabled: false, encryptionPassphrase: "pw" } });
        await encryptedRemote(r.remote, "pw");
        // While the pull runs, Step 1 still says unencrypted; the vault being
        // cloned decides the codec.
        let alg: string | null = null;
        r.onSetup = () => { alg = r.binding.chunkHasher.alg; };
        await r.binding.clone();
        expect(alg).toBe("hmac");
        expect(r.settings.encryptionEnabled).toBe(true);
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

    it("records what the DB holds from its own read; no Check is needed before it", async () => {
        const r = rig({ settings: { encryptionPassphrase: "pw" } });
        await encryptedRemote(r.remote, "pw");
        expect(r.binding.relation().dbCheck).toBeNull();
        await r.binding.clone();
        expect(r.binding.relation().dbCheck?.result).toEqual({ status: "exists", docCount: 1 });
    });

    it("a Check made before is replaced by what Clone read", async () => {
        const r = rig({ settings: { encryptionPassphrase: "pw" } });
        r.dbCheckResult = { status: "exists", docCount: 0 };
        await r.binding.checkDatabase("vault");
        await encryptedRemote(r.remote, "pw");
        await r.binding.clone();
        expect(r.binding.relation().dbCheck?.result).toEqual({ status: "exists", docCount: 1 });
    });

    it("an empty DB is refused in the preparation: nothing is stopped or changed", async () => {
        const r = rig();
        await expect(r.binding.clone()).rejects.toThrow(/empty — use Init/);
        expect(r.stops).toBe(0);
        expect(r.settings.connectionState).toBe("setupDone");
        expect(r.binding.relation().dbCheck?.result).toEqual({ status: "exists", docCount: 0 });
    });

    it("an empty DB is kept as what the DB holds, not as a failed Clone: a later read replaces it", async () => {
        const r = rig({ settings: { encryptionEnabled: false, encryptionPassphrase: "pw", compressionEnabled: false } });
        await expect(r.binding.clone()).rejects.toThrow(/empty — use Init/);
        expect(r.binding.relation().lastOp).toBeNull();
        expect(r.binding.relation().dbCheck?.result).toEqual({ status: "exists", docCount: 0 });

        // Another device fills the DB; this one's Clone reads it and is
        // cancelled at the confirmation. Nothing says the DB is empty.
        await encryptedRemote(r.remote, "pw");
        r.confirmAnswer = false;
        await expect(r.binding.clone()).rejects.toMatchObject({ name: "AbortError" });
        expect(r.binding.relation().lastOp).toBeNull();
        expect(r.binding.relation().dbCheck?.result).toEqual({ status: "exists", docCount: 1 });
    });

    it("asks for the passphrase first, then to confirm, shown the server's codec", async () => {
        const r = rig({
            settings: { encryptionEnabled: false, encryptionPassphrase: "" },
            ask: async (_reason, tryUnlock) => (await tryUnlock("pw")) ? "pw" : null,
        });
        await encryptedRemote(r.remote, "pw");
        await r.binding.clone();
        expect(r.prompts).toEqual(["passphrase", "confirm"]);
        expect(r.confirmed).toEqual([{
            op: "clone", dbName: "vault", docCount: 1, encryption: true, compression: true,
        }]);
    });

    it("a cancelled passphrase prompt and an empty DB never ask to confirm", async () => {
        const cancelled = rig({ settings: { encryptionPassphrase: "" } });
        await encryptedRemote(cancelled.remote, "pw");
        await expect(cancelled.binding.clone()).rejects.toMatchObject({ name: "AbortError" });
        expect(cancelled.prompts).toEqual(["passphrase"]);

        const empty = rig();
        await expect(empty.binding.clone()).rejects.toThrow(/empty/);
        expect(empty.prompts).toEqual([]);
    });

    it("declining changes nothing and is not recorded: no stop, no settingUp, no codec committed", async () => {
        const r = rig({ settings: { encryptionEnabled: false, encryptionPassphrase: "pw", compressionEnabled: false } });
        await encryptedRemote(r.remote, "pw");
        r.confirmAnswer = false;
        await expect(r.binding.clone()).rejects.toMatchObject({
            name: "AbortError", message: "Clone cancelled — nothing was changed.",
        });
        expect(r.stops).toBe(0);
        expect(r.saves).toEqual([]);
        expect(r.stateAtSetup).toBeNull();
        expect(r.settings).toMatchObject({
            encryptionEnabled: false, compressionEnabled: false, connectionState: "setupDone",
        });
        expect(r.settings.vaultCipherVersion).toBeUndefined();
        expect(r.binding.relation().lastOp).toBeNull();
        // The vault decorator stack is the persisted one again.
        expect(r.binding.chunkHasher.alg).toBe("x64");
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

    it("encryption changed by another device: pauses to tested and persists why", async () => {
        const r = rig({ settings: { connectionState: "syncing", encryptionEnabled: false } });
        await encryptedRemote(r.remote, "pw");
        const err = await r.binding.checkAgreement(signal).catch((e) => e);
        expect(err).toBeInstanceOf(VaultEncryptionPausedError);
        expect(err).toMatchObject({ reason: "encryption-changed", encryptionPaused: true });
        expect(err.userMessage).toMatch(/^Sync paused — another device turned vault encryption on\./);
        expect(r.settings.connectionState).toBe("tested");
        expect(r.binding.relation().pause?.error).toMatchObject({ reason: "encryption-changed", userMessage: err.userMessage });
        expect(r.saves).toEqual(["tested"]);
        expect(r.settings.vaultPause).toMatchObject({ reason: "encryption-changed", detail: { remoteEncrypted: true } });
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

    it("an agreed vault unlocks, takes the server's compression flag and clears a pause", async () => {
        const r = rig({
            settings: {
                connectionState: "syncing", encryptionEnabled: true, encryptionPassphrase: "pw",
                compressionEnabled: false,
                vaultPause: { reason: "passphrase-missing", detail: {}, at: 0, against: "x" },
            },
        });
        await encryptedRemote(r.remote, "pw");
        await r.binding.checkAgreement(signal);
        expect(r.settings).toMatchObject({ connectionState: "syncing", compressionEnabled: true, vaultCipherVersion: 3 });
        expect(r.binding.chunkHasher.alg).toBe("hmac");
        expect(r.settings.vaultPause).toBeUndefined();
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
        expect(r.binding.relation().pause).toBeNull();
        expect(r.saves).toEqual([]);
    });

    it("the pause survives a reload: a new binding on the saved settings still says why", async () => {
        const r = rig({ settings: { connectionState: "syncing", encryptionEnabled: true, encryptionPassphrase: "old" } });
        await encryptedRemote(r.remote, "pw");
        await r.binding.checkAgreement(signal).catch(() => {});
        const reloaded = rig({ settings: JSON.parse(JSON.stringify(r.settings)) });
        expect(reloaded.binding.relation()).toMatchObject({
            state: "tested",
            pause: { error: { reason: "passphrase-mismatch" } },
        });
    });

    it("a pause about another vault DB is not shown", async () => {
        const r = rig({ settings: { connectionState: "syncing", encryptionEnabled: false } });
        await encryptedRemote(r.remote, "pw");
        await r.binding.checkAgreement(signal).catch(() => {});
        r.settings.couchdbDbName = "other";
        expect(r.binding.relation().pause).toBeNull();
    });

    it("a successful Init clears the pause", async () => {
        const r = rig({ settings: { connectionState: "syncing", encryptionEnabled: false } });
        await encryptedRemote(r.remote, "pw");
        await r.binding.checkAgreement(signal).catch(() => {});
        await r.binding.init();
        expect(r.binding.relation()).toMatchObject({ lastOp: { op: "init", error: null }, pause: null });
        expect(r.settings.vaultPause).toBeUndefined();
    });

    it("a failed Init keeps the pause", async () => {
        const r = rig({ settings: { connectionState: "syncing", encryptionEnabled: false } });
        await encryptedRemote(r.remote, "pw");
        await r.binding.checkAgreement(signal).catch(() => {});
        r.setupError = new Error("disk full");
        await r.binding.init().catch(() => {});
        expect(r.binding.relation().pause).not.toBeNull();
    });
});

describe("VaultBinding: the incarnation of the vault DB a device is set up against", () => {
    const signal = new AbortController().signal;

    /** Another device's Init: the DB is re-created with a new vault:meta. */
    async function initElsewhere(remote: FakeCouchClient, compression = false): Promise<void> {
        await remote.destroy();
        const built = await buildInitialVaultMeta({ encryption: false, compression });
        await pushVaultMeta(remote, built.meta);
    }

    it("Init writes a meta with a fresh generation id and binds the device to it", async () => {
        const r = rig();
        await r.binding.init();
        const meta = await fetchVaultMeta(r.remote);
        expect(meta?.generationId).toMatch(/^[0-9a-f]{32}$/);
        expect(r.settings.vaultRoot).toEqual({
            fingerprint: await metaFingerprint(meta!), against: vaultTarget(r.settings),
        });
    });

    it("Clone binds the device to the meta it cloned, or to no meta", async () => {
        const r = rig({ settings: { connectionState: "tested" } });
        await initElsewhere(r.remote);
        await r.binding.clone();
        expect(r.settings.vaultRoot?.fingerprint).toBe(await metaFingerprint((await fetchVaultMeta(r.remote))!));

        // A vault set up before vault:meta existed: documents, no meta.
        const bare = rig({ settings: { connectionState: "tested" } });
        await bare.remote.bulkDocs([{ _id: "file:a.md", type: "file", chunks: [] } as never]);
        await bare.binding.clone();
        expect(bare.settings.vaultRoot).toEqual({ fingerprint: null, against: vaultTarget(bare.settings) });
    });

    it("another device's Init pauses this device until it clones the new DB", async () => {
        const r = rig({ settings: { connectionState: "tested" } });
        await initElsewhere(r.remote);
        await r.binding.clone();
        r.settings.connectionState = "syncing";
        await r.binding.checkAgreement(signal);

        await initElsewhere(r.remote);
        const err = await r.binding.checkAgreement(signal).catch((e) => e);
        expect(err).toBeInstanceOf(VaultEncryptionPausedError);
        expect(err).toMatchObject({ reason: "root-changed" });
        expect(classifyError(err).kind).toBe("encryption-paused");
        expect(r.settings.connectionState).toBe("tested");
        expect(r.settings.vaultPause).toMatchObject({ reason: "root-changed" });
        expect(r.binding.relation().pause?.error.userMessage).toMatch(/Run Clone/);

        // Clone recovers: bound to the new DB, the pause is gone.
        await r.binding.clone();
        r.settings.connectionState = "syncing";
        await r.binding.checkAgreement(signal);
        expect(r.settings.vaultPause).toBeUndefined();
        expect(r.settings.connectionState).toBe("syncing");
    });

    it("a re-creation keeps the same plaintext codec and is still told apart", async () => {
        const r = rig({ settings: { connectionState: "tested" } });
        await initElsewhere(r.remote, true);
        await r.binding.clone();
        r.settings.connectionState = "syncing";
        await initElsewhere(r.remote, true);
        await expect(r.binding.checkAgreement(signal)).rejects.toMatchObject({ reason: "root-changed" });
    });

    it("a DB whose vault:meta is gone (deleted, or Init has not written it yet) pauses", async () => {
        const r = rig({ settings: { connectionState: "tested" } });
        await initElsewhere(r.remote);
        await r.binding.clone();
        r.settings.connectionState = "syncing";
        await r.remote.destroy();
        await expect(r.binding.checkAgreement(signal)).rejects.toMatchObject({ reason: "root-changed" });
    });

    it("a device set up before the record existed adopts the server's meta, then detects a re-creation", async () => {
        const r = rig({ settings: { connectionState: "syncing" } });
        await initElsewhere(r.remote);
        expect(r.settings.vaultRoot).toBeUndefined();
        await r.binding.checkAgreement(signal);
        expect(r.settings.vaultRoot?.fingerprint).toBe(await metaFingerprint((await fetchVaultMeta(r.remote))!));
        expect(r.settings.connectionState).toBe("syncing");

        await initElsewhere(r.remote);
        await expect(r.binding.checkAgreement(signal)).rejects.toMatchObject({ reason: "root-changed" });
    });

    it("a meta written by an older build (no generation id) is compared by its codec and salt", async () => {
        const r = rig({ settings: { connectionState: "syncing", encryptionEnabled: true, encryptionPassphrase: "pw" } });
        const old = await buildInitialVaultMeta({ encryption: true, passphrase: "pw", compression: false });
        delete old.meta.generationId;
        await pushVaultMeta(r.remote, old.meta);
        await r.binding.checkAgreement(signal);
        // Checked again with the same meta: still the same DB.
        await r.binding.checkAgreement(signal);
        expect(r.settings.connectionState).toBe("syncing");

        const reInit = await buildInitialVaultMeta({ encryption: true, passphrase: "pw", compression: false });
        delete reInit.meta.generationId;
        await r.remote.destroy();
        await pushVaultMeta(r.remote, reInit.meta);
        await expect(r.binding.checkAgreement(signal)).rejects.toMatchObject({ reason: "root-changed" });
    });

    it("a record about another vault DB is not compared, and is replaced", async () => {
        const r = rig({ settings: { connectionState: "syncing", vaultRoot: { fingerprint: "sha256:x", against: "elsewhere" } } });
        await initElsewhere(r.remote);
        await r.binding.checkAgreement(signal);
        expect(r.settings.vaultRoot?.against).toBe(vaultTarget(r.settings));
    });

    describe("recheckRoot (during a live session)", () => {
        async function bound(): Promise<Rig> {
            const r = rig({ settings: { connectionState: "tested" } });
            await initElsewhere(r.remote);
            await r.binding.clone();
            r.settings.connectionState = "syncing";
            return r;
        }

        it("a pulled meta of the same DB passes; of a re-created DB pauses", async () => {
            const r = await bound();
            const same = await fetchVaultMeta(r.remote);
            await r.binding.recheckRoot(same);
            expect(r.settings.connectionState).toBe("syncing");

            const other = await buildInitialVaultMeta({ encryption: false, compression: false });
            await expect(r.binding.recheckRoot(other.meta)).rejects.toMatchObject({ reason: "root-changed" });
            expect(r.settings.connectionState).toBe("tested");
        });

        it("a deleted meta pauses", async () => {
            const r = await bound();
            await expect(r.binding.recheckRoot(null)).rejects.toMatchObject({ reason: "root-changed" });
        });

        it("without a pulled meta, reads the server's", async () => {
            const r = await bound();
            await r.binding.recheckRoot();
            await initElsewhere(r.remote);
            await expect(r.binding.recheckRoot()).rejects.toMatchObject({ reason: "root-changed" });
        });

        it("a failed read is not a verdict: nothing changes", async () => {
            const r = await bound();
            const failing = rig({
                settings: JSON.parse(JSON.stringify(r.settings)),
                client: (remote) => new Proxy(remote, {
                    get(target, prop, recv) {
                        if (prop === "getDoc") return async () => { throw new TypeError("Failed to fetch"); };
                        return Reflect.get(target, prop, recv);
                    },
                }),
            });
            await failing.binding.recheckRoot();
            expect(failing.settings.connectionState).toBe("syncing");
            expect(failing.settings.vaultPause).toBeUndefined();
        });

        it("without a record there is nothing to compare", async () => {
            const r = rig({ settings: { connectionState: "syncing" } });
            const other = await buildInitialVaultMeta({ encryption: false, compression: false });
            await r.binding.recheckRoot(other.meta);
            expect(r.settings.connectionState).toBe("syncing");
        });
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
        const refused = { name: "BusyError", message: expect.stringMatching(/Init is running/) };
        await expect(r.binding.setLiveSync(true)).rejects.toMatchObject(refused);
        await expect(r.binding.applyDatabase("x")).rejects.toMatchObject(refused);
        await expect(r.binding.changeCodecSetting({ compressionEnabled: false })).rejects.toMatchObject(refused);
        await expect(r.binding.applyServer({ couchdbUser: "x" }, true)).rejects.toMatchObject(refused);
        await expect(r.binding.setPassphrase("x")).rejects.toMatchObject(refused);
        await expect(r.binding.checkDatabase("vault")).rejects.toMatchObject(refused);
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

    it("keeps one result per DB: checking another DB keeps the applied DB's", async () => {
        const r = rig();
        await r.binding.checkDatabase("vault");
        r.dbCheckResult = { status: "created" };
        await r.binding.checkDatabase("other");
        expect(r.binding.relation().dbCheck?.result).toEqual({ status: "exists", docCount: 5 });
        expect(r.binding.dbCheckFor("other")?.result).toEqual({ status: "created" });
    });

    it("an empty DB is worded as empty, found or created", async () => {
        const r = rig();
        r.dbCheckResult = { status: "exists", docCount: 0 };
        await r.binding.checkDatabase("vault");
        r.dbCheckResult = { status: "created" };
        await r.binding.checkDatabase("other");
        expect(r.dones).toEqual(['"vault" found — empty.', '"other" created — empty.']);
    });

    it("a failure goes to the notice as the error itself", async () => {
        const r = rig();
        const err = new TypeError("Failed to fetch");
        r.dbCheckResult = { status: "error", error: err };
        await r.binding.checkDatabase("vault");
        expect(r.failures).toEqual([err]);
    });
});

describe("VaultBinding — Step 2's Check takes the setup lock", () => {
    it("while a Check runs, Init, Clone and every writer are refused, and its pass does not clear a latch it did not see", async () => {
        const r = rig();
        let release!: () => void;
        r.checkGate = new Promise<void>((res) => { release = res; });
        const checking = r.binding.checkDatabase("vault");
        expect(r.binding.changeBlocker()).toBe("Database check is running — wait for it to finish.");
        const refused = { name: "BusyError", message: "Database check is running — wait for it to finish." };
        await expect(r.binding.init()).rejects.toMatchObject(refused);
        await expect(r.binding.clone()).rejects.toMatchObject(refused);
        await expect(r.binding.checkDatabase("vault")).rejects.toMatchObject(refused);
        await expect(r.binding.setPassphrase("x")).rejects.toMatchObject(refused);
        await expect(r.binding.changeCodecSetting({ compressionEnabled: false })).rejects.toMatchObject(refused);
        expect(r.stateAtSetup).toBeNull();
        expect(r.binding.relation().lastOp).toBeNull();
        release();
        await expect(checking).resolves.toEqual({ status: "exists", docCount: 5 });
        expect(r.binding.changeBlocker()).toBeNull();
        await r.binding.init();
        expect(r.binding.relation().lastOp).toMatchObject({ op: "init", error: null });
    });

    it("a Check refused while Init runs leaves the auth latch as it was", async () => {
        const r = rig();
        let release!: () => void;
        r.setupGate = new Promise<void>((res) => { release = res; });
        const running = r.binding.init();
        await new Promise((res) => setTimeout(res, 0));
        r.auth.raise(401, "nope");
        await expect(r.binding.checkDatabase("vault")).rejects.toMatchObject({ name: "BusyError" });
        expect(r.auth.isBlocked()).toBe(true);
        release();
        await running;
    });
});

describe("VaultBinding.setPassphrase", () => {
    it("keeps a finished setup: the passphrase unlocks the vault, it does not define it", async () => {
        const r = rig({ settings: { encryptionEnabled: true, encryptionPassphrase: "old" } });
        await r.binding.setPassphrase("new");
        expect(r.settings).toMatchObject({ encryptionPassphrase: "new", connectionState: "setupDone" });
        expect(r.saves).toEqual(["setupDone"]);
    });
});
