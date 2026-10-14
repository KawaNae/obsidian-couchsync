/**
 * vault-binding.ts — the owner of this device's setup of the vault DB.
 *
 * The live session is SyncEngine's; the config DB is ConfigBinding's. What
 * is left is the setup of the vault DB itself, and this class owns all of
 * it:
 *
 *   - the setup state (`settings.connectionState`): every change of it
 *     goes through a method here (Init, Clone, the Live Sync switch, Step 2
 *     Apply, a Step 1 codec change, a server change, a pause);
 *     only the settings migration on load rewrites it elsewhere;
 *   - the codec state the vault decorator stack is built from: the unlocked
 *     key, and the compression flag and cipher floor a Clone applies in
 *     memory before it commits them (`wrapClient`, `chunkHasher`);
 *   - Init and Clone, each run as a preparation that changes nothing and
 *     an execution that is destructive (see `runOperation`);
 *   - the agreement check the live session runs before catchup
 *     (`checkAgreement`): the codec, and whether the server's vault DB is
 *     still the one this device set up against (`settings.vaultRoot`), also
 *     re-checked during the session when the pull sees a sign of a
 *     re-created DB (`recheckRoot`);
 *   - what is known about the setup: how the last Init / Clone ended, why
 *     the agreement check paused sync (persisted with the state it
 *     explains, so a reload keeps both), and what each vault DB was found
 *     to hold (`relation`, which the Step 3 status line is drawn from).
 *     An operation that reads or changes a fact updates what is known
 *     about it: Init and Clone record what the DB holds (Init after it
 *     filled the DB, Clone when its preparation read the DB), clear a
 *     pause and bind the device to the DB's current `vault:meta`.
 *
 * Every change of what `relation` returns is announced (`onChange`), so a
 * view drawn from it can redraw while an operation runs, not only when the
 * view's own button resolves.
 *
 * Has no dependency on Obsidian: the host injects settings, the setup
 * runner, the live-sync switch, the progress notice, the passphrase
 * prompt and the confirm dialog.
 */
import type { CouchSyncSettings, ConnectionState, VaultPauseRecord } from "../settings.ts";
import type { DbInfo, ICouchClient } from "../db/interfaces.ts";
import type { CryptoProvider } from "../db/crypto-provider.ts";
import { AuthBlockedError, type AuthGate } from "../db/sync/auth-gate.ts";
import { EncryptingCouchClient } from "../db/encrypting-couch-client.ts";
import { CompressingCouchClient } from "../db/compressing-couch-client.ts";
import { computeHash, type ChunkHasher } from "../db/chunker.ts";
import type { ChunkHashAlg } from "../types/doc-id.ts";
import {
    buildInitialVaultMeta,
    fetchVaultMeta,
    metaFingerprint,
    pushVaultMeta,
    unlockVaultMeta,
    VAULT_META_DOC_ID,
    type VaultMetaDoc,
} from "../db/vault-meta.ts";
import { checkEncryptionAgreement } from "../db/encryption-agreement.ts";
import { classifyError } from "../db/sync/errors.ts";
import { describeError, rawErrorMessage, UserFacingError } from "../ui/describe-error.ts";
import { logWarn } from "../ui/log.ts";
import { OutcomeLedger, type OpOutcome } from "./op-outcome.ts";
import type { SetupResult } from "./setup.ts";
import { describeDbFound, type DbCheckResult } from "../db/sync/vault-remote-ops.ts";
import type { VaultSetupPlan } from "./vault-setup-confirm.ts";

/** The one-shot run's notice: progress lines, then a summary or the error.
 *  The host builds it (`ProgressNotice`), which also logs. */
export interface VaultProgress {
    update(message: string): void;
    done(summary: string): void;
    fail(err: unknown): void;
}

/** Why the passphrase is asked for: no value to try, or the value at hand
 *  does not unlock the vault. */
export type VaultPassphraseReason = "missing" | "mismatch";

/**
 * Ask the user for the vault passphrase. The prompt checks each answer
 * with `tryUnlock` and stays open on a wrong one. Resolves with the
 * passphrase that unlocked, or null when the user cancelled.
 */
export type AskVaultPassphrase = (
    reason: VaultPassphraseReason,
    tryUnlock: (passphrase: string) => Promise<boolean>,
) => Promise<string | null>;

/** The destructive half of Init and Clone (`SetupService`). */
export interface VaultSetupRunner {
    init(onProgress: (msg: string) => void, publishMeta: () => Promise<void>): Promise<SetupResult>;
    clone(onProgress: (msg: string) => void): Promise<SetupResult>;
}

export interface VaultBindingHost {
    getSettings(): CouchSyncSettings;
    saveSettings(): Promise<void>;
    auth: AuthGate;
    /** A raw (codec-less) client for the vault DB the settings name. */
    makeRawClient(): ICouchClient;
    /** The setup runner. A function because the host builds it after the
     *  binding (it needs the binding's client wrapper). */
    setup(): VaultSetupRunner;
    /** Step 2's Check: read the DB's info with the saved credentials
     *  (creating the DB when it is missing). */
    checkDatabase(dbName: string): Promise<DbCheckResult>;
    /** Stop the live session and the change tracker. */
    stopLive(): void;
    /** Start the live session (the state is `syncing` when called). */
    startLive(): Promise<void>;
    openProgress(label: string): VaultProgress;
    askPassphrase: AskVaultPassphrase;
    /** Ask the user to confirm the destructive half of Init or Clone, as
     *  `plan` describes it. Resolves false when the user declined. */
    confirmSetup(plan: VaultSetupPlan): Promise<boolean>;
}

/** The user's operations on the vault setup. */
export type VaultOpName = "init" | "clone";

export type VaultOutcome = OpOutcome<VaultOpName>;

/** What the vault DB was found to hold: by Step 2's Check, by the
 *  preparation of Clone, or read back after an Init filled it. */
export interface VaultDbCheck {
    at: number;
    /** `vaultTarget` of the DB. */
    against: string;
    result: DbCheckResult;
}

/** Why the agreement check paused live sync, and since when. */
export interface VaultPause {
    at: number;
    error: VaultEncryptionPausedError;
}

/** Snapshot of this device's setup of the vault DB, for the status line.
 *  The outcome, the pause and the DB check are given only for the vault DB
 *  the settings name now. */
export interface VaultRelation {
    state: ConnectionState;
    serverTested: boolean;
    /** The Init or Clone running now. */
    busy: VaultOpName | null;
    /** The last Init or Clone. In memory: unknown after a reload. */
    lastOp: VaultOutcome | null;
    /** Why sync is paused on the encryption agreement. Persisted: kept until
     *  the check passes or an Init / Clone succeeds. */
    pause: VaultPause | null;
    dbCheck: VaultDbCheck | null;
}

const OP_LABELS: Record<VaultOpName, string> = {
    init: "Init",
    clone: "Clone",
};

/** How long the server may take to answer the probe at the start of Init
 *  and Clone. Short, so an unreachable server fails before anything is
 *  changed rather than after the local DB was emptied. */
const REACHABILITY_TIMEOUT_MS = 15_000;

/** The fingerprint outcomes are recorded against: the server and the
 *  vault DB name. A result about another DB no longer describes this one. */
export function vaultTarget(s: Pick<CouchSyncSettings, "couchdbUri" | "couchdbDbName">): string {
    return `${s.couchdbUri.replace(/\/+$/, "")}\u0000${s.couchdbDbName}`;
}

export class VaultBinding {
    /** The key unlocked from `vault:meta` (or derived by Init). */
    private crypto?: CryptoProvider;
    /** Encryption flag applied in memory while a Clone runs, before it
     *  commits `settings.encryptionEnabled` — the vault being cloned decides
     *  whether the encrypt layer is applied, whatever Step 1 says. A failed
     *  Clone persists nothing. Undefined at all other times. */
    private encryptionOverride?: boolean;
    /** Compression flag applied in memory while a Clone runs, before it
     *  commits `settings.compressionEnabled`. Undefined at all other times. */
    private compressionOverride?: boolean;
    /** Cipher floor applied in memory while a Clone runs, before it
     *  commits `settings.vaultCipherVersion`. Undefined at all other times. */
    private cipherVersionOverride?: number;
    private inflight: VaultOpName | null = null;
    /** Init and Clone only; the agreement check's conclusion is the
     *  persisted pause (`settings.vaultPause`). */
    private readonly outcomes = new OutcomeLedger<VaultOpName>(() => false);
    /** What each vault DB was found to hold, keyed by `vaultTarget`. */
    private readonly dbChecks = new Map<string, VaultDbCheck>();
    private readonly listeners = new Set<() => void>();

    /** The vault chunk hasher: HMAC under the key when the vault is
     *  encrypted and unlocked, xxhash64 otherwise. Reads the key on every
     *  call, so a change of the key reaches every user of the hasher. */
    readonly chunkHasher: ChunkHasher;

    constructor(private readonly host: VaultBindingHost) {
        const binding = this;
        this.chunkHasher = {
            get alg(): ChunkHashAlg {
                return binding.hmacKey() ? "hmac" : "x64";
            },
            hash: (data) => {
                const key = binding.hmacKey();
                return key ? key.hmacHash(data) : computeHash(data);
            },
        };
    }

    private settings(): CouchSyncSettings {
        return this.host.getSettings();
    }

    /** Subscribe to changes of `relation()` and `busy()`. Returns the
     *  unsubscribe function. */
    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    private changed(): void {
        for (const l of this.listeners) {
            try {
                l();
            } catch (e) {
                logWarn(`vault setup listener failed: ${rawErrorMessage(e)}`);
            }
        }
    }

    // ── Codec stack ────────────────────────────────────

    private hmacKey(): CryptoProvider | undefined {
        return this.activeEncryption ? this.crypto : undefined;
    }

    /** Encryption flag the vault decorator stack uses: the persisted one,
     *  except while a Clone runs. */
    private get activeEncryption(): boolean {
        return this.encryptionOverride ?? this.settings().encryptionEnabled;
    }

    /** Compression flag the vault decorator stack uses: the persisted one,
     *  except while a Clone runs. */
    private get activeCompression(): boolean {
        return this.compressionOverride ?? this.settings().compressionEnabled;
    }

    /** Cipher floor the vault decorator stack enforces: the persisted one
     *  (`settings.vaultCipherVersion`, trust on first use), except while a
     *  Clone runs. */
    private get activeCipherVersion(): number | undefined {
        return this.cipherVersionOverride ?? this.settings().vaultCipherVersion;
    }

    /**
     * Wrap a raw client with the vault decorator stack, read at each call so
     * a change made by Init / Clone reaches every vault client
     * (VaultRemoteOps, SyncEngine). The encryption flag decides whether
     * the encrypt layer is applied, not whether a key exists: a key left
     * from an earlier encrypted session never encrypts a plaintext vault,
     * and an encrypted vault without a key is refused (fail-closed).
     *
     * Compose order is `compress(encrypt(raw))`: on push the plain payload
     * reaches gzip before the cipher makes it incompressible.
     */
    wrapClient = (raw: ICouchClient): ICouchClient => {
        let client: ICouchClient = raw;
        if (this.activeEncryption) {
            if (!this.crypto) {
                throw new Error(
                    "refusing to build vault client — vault is encrypted " +
                        "but no crypto provider is unlocked (provisioning incomplete). " +
                        "Re-run Init/Clone or unlock the vault.",
                );
            }
            client = new EncryptingCouchClient(client, this.crypto, this.activeCipherVersion);
        }
        if (this.activeCompression) {
            client = new CompressingCouchClient(client);
        }
        return client;
    };

    /** Raise the local cipher floor to `observed` if it is higher (trust on
     *  first use; a server cannot lower it). Changes the settings object
     *  only; the caller saves. True when the floor changed. */
    private ratchetCipherFloor(observed: number): boolean {
        const s = this.settings();
        if (observed > (s.vaultCipherVersion ?? 0)) {
            s.vaultCipherVersion = observed;
            return true;
        }
        return false;
    }

    // ── Setup state ────────────────────────────────────

    /** Set the setup state alone and persist it. */
    private async writeState(state: ConnectionState): Promise<void> {
        this.settings().connectionState = state;
        await this.host.saveSettings();
        this.changed();
    }

    /** The Init or Clone running now, or null. */
    busy(): VaultOpName | null {
        return this.inflight;
    }

    /** Why the vault setup cannot be changed now (Init or Clone runs), or
     *  null. */
    changeBlocker(): string | null {
        return this.inflight
            ? `${OP_LABELS[this.inflight]} is running — wait for it to finish.`
            : null;
    }

    private assertIdle(): void {
        const blocked = this.changeBlocker();
        if (blocked) throw new UserFacingError(blocked);
    }

    /**
     * Step 4's Live Sync switch. On: only from `setupDone` — a setup that
     * did not finish never syncs; persists `syncing`, then starts the
     * session. Off: stops the session, then persists `setupDone`.
     */
    async setLiveSync(on: boolean): Promise<void> {
        this.assertIdle();
        const state = this.settings().connectionState;
        if (on) {
            if (state === "syncing") return;
            if (state !== "setupDone") {
                throw new UserFacingError("Run Init or Clone (Step 3) before turning on Live Sync.");
            }
            await this.writeState("syncing");
            await this.host.startLive();
        } else {
            if (state !== "syncing") return;
            this.host.stopLive();
            await this.writeState("setupDone");
        }
    }

    /** Step 2 Apply: select the vault DB. The device must set it up (Init or
     *  Clone) before it syncs with it. */
    async applyDatabase(dbName: string): Promise<void> {
        this.assertIdle();
        const s = this.settings();
        s.couchdbDbName = dbName;
        s.connectionState = "tested";
        await this.host.saveSettings();
        this.changed();
    }

    /** A Step 1 codec setting changed (encryption, compression). The vault
     *  on the server was set up with the old one, so a finished setup no
     *  longer holds: `setupDone` drops to `tested` (Init or Clone again). */
    async changeCodecSetting(
        patch: Partial<Pick<CouchSyncSettings, "encryptionEnabled" | "encryptionPassphrase" | "compressionEnabled">>,
    ): Promise<void> {
        this.assertIdle();
        const s = this.settings();
        Object.assign(s, patch);
        if (s.connectionState === "setupDone") s.connectionState = "tested";
        await this.host.saveSettings();
        this.changed();
    }

    /** The CouchDB tab's Apply. New credentials (or server) send the vault
     *  setup back to `editing`: Step 2 has to be checked again. */
    async applyServer(
        patch: Partial<Pick<CouchSyncSettings, "couchdbUri" | "couchdbUser" | "couchdbPassword" | "serverTested">>,
        credentialsChanged: boolean,
    ): Promise<void> {
        this.assertIdle();
        const s = this.settings();
        Object.assign(s, patch);
        if (credentialsChanged) s.connectionState = "editing";
        await this.host.saveSettings();
        this.changed();
    }

    /** This device's setup of the vault DB now. The state and the pause are
     *  persisted; the last Init / Clone and the DB checks are in memory,
     *  unknown after a reload until the next run. */
    relation(): VaultRelation {
        const s = this.settings();
        const target = vaultTarget(s);
        const p = s.vaultPause;
        return {
            state: s.connectionState,
            serverTested: s.serverTested,
            busy: this.inflight,
            lastOp: this.outcomes.view(target).lastOp,
            pause: p && p.against === target
                ? { at: p.at, error: new VaultEncryptionPausedError(p.reason, p.detail) }
                : null,
            dbCheck: this.dbCheckFor(s.couchdbDbName),
        };
    }

    /** What `dbName` on the saved server was found to hold, or null when it
     *  was not checked since the plugin loaded. */
    dbCheckFor(dbName: string): VaultDbCheck | null {
        const against = vaultTarget({ couchdbUri: this.settings().couchdbUri, couchdbDbName: dbName });
        return this.dbChecks.get(against) ?? null;
    }

    /** Keep what the DB was found to hold, unless a newer finding is kept. */
    private recordDbCheck(check: VaultDbCheck): void {
        const kept = this.dbChecks.get(check.against);
        if (kept && check.at < kept.at) return;
        this.dbChecks.set(check.against, check);
        this.changed();
    }

    /** Clear a pause noticed no later than `at` (a check that passed, or an
     *  Init / Clone that succeeded, started at `at`). Changes the settings
     *  object only; the caller saves. */
    private clearPause(at: number): void {
        const p = this.settings().vaultPause;
        if (p && p.at <= at) delete this.settings().vaultPause;
    }

    /**
     * Step 2's Check of `dbName` (not yet applied): whether it exists and
     * how many documents it holds; a missing DB is created. Kept so Step 3
     * can tell whether Clone has something to pull. A failure is reported
     * on the notice, worded by `describeError`; a success clears the auth
     * latch (the credentials were accepted).
     */
    async checkDatabase(dbName: string): Promise<DbCheckResult> {
        const at = Date.now();
        const against = vaultTarget({ couchdbUri: this.settings().couchdbUri, couchdbDbName: dbName });
        const progress = this.host.openProgress("Database check");
        const result = await this.host.checkDatabase(dbName);
        this.recordDbCheck({ at, against, result });
        if (result.status === "error") {
            progress.fail(result.error);
        } else {
            this.host.auth.clear();
            progress.done(`"${dbName}" ${describeDbFound(result)}`);
        }
        return result;
    }

    // ── Init / Clone ───────────────────────────────────

    /**
     * Run Init or Clone. The notice is opened first, so no failure goes
     * unreported. A second run while one is in flight is refused; so is a
     * run while the auth latch is raised. Neither refusal is recorded:
     * nothing was attempted. `body` prepares (reads, derives, asks —
     * nothing is changed, and a failure leaves the setup state and live
     * sync as they were), then calls `beginDestructive`, which asks the
     * user to confirm, and executes.
     *
     * This is the one exit of an Init / Clone failure: the outcome is
     * recorded, and the notice words the error. Three failures are not
     * recorded, because something else already tells them: a cancellation;
     * a rejection of the credentials (401/403), which raises the auth
     * latch — the status line shows the latch while it is raised, and once
     * a Test clears it the rejection no longer holds; and a Clone of an
     * empty DB, which is what the DB was found to hold — kept as its check
     * (Clone's description says it), which the next read of the DB
     * replaces. The error is rethrown so the caller only has to restore its
     * button.
     */
    private async runOperation(
        op: VaultOpName,
        body: (progress: VaultProgress, at: number) => Promise<string>,
    ): Promise<void> {
        const progress = this.host.openProgress(OP_LABELS[op]);
        const busy = this.changeBlocker();
        const refusal = busy !== null
            ? new UserFacingError(busy)
            : this.host.auth.isBlocked() ? this.host.auth.blockedError() : null;
        if (refusal) {
            progress.fail(refusal);
            throw refusal;
        }
        this.inflight = op;
        this.changed();
        const at = Date.now();
        const against = vaultTarget(this.settings());
        try {
            const summary = await body(progress, at);
            this.outcomes.record({ op, at, against, error: null });
            progress.done(summary);
        } catch (e) {
            const d = classifyError(e);
            const rejected = d.kind === "auth" && typeof d.code === "number";
            if (rejected) this.host.auth.raise(d.code!, rawErrorMessage(e));
            if (
                !rejected && !(e instanceof AuthBlockedError)
                && !(e instanceof VaultDbEmptyError) && !describeError(e).cancelled
            ) {
                this.outcomes.record({ op, at, against, error: e });
            }
            progress.fail(e);
            throw e;
        } finally {
            this.inflight = null;
            this.changed();
        }
    }

    /** A finished Init or Clone, started at `at`, against the DB whose
     *  `vault:meta` has fingerprint `root` (null: no meta): the setup holds,
     *  the device is bound to that incarnation of the DB, and a pause
     *  noticed before it no longer does. Changes the settings object only;
     *  the caller saves. */
    private settleSetup(at: number, root: string | null): void {
        const s = this.settings();
        s.connectionState = "setupDone";
        s.vaultRoot = { fingerprint: root, against: vaultTarget(s) };
        this.clearPause(at);
    }

    /**
     * The point of no return of Init and Clone. The user confirms first,
     * shown what the preparation found: every check that can refuse the
     * run has passed by now, so a dialog is never answered for a run that
     * is then refused, and what it says was read just before. Declining is
     * a cancellation and changes nothing. On a yes, stop live sync and
     * persist `settingUp` before anything is destroyed, so a failure (or a
     * crash) from here on never leaves `setupDone` / `syncing` behind on a
     * half-built DB.
     */
    private async beginDestructive(progress: VaultProgress, plan: VaultSetupPlan): Promise<void> {
        progress.update("Waiting for confirmation...");
        if (!(await this.host.confirmSetup(plan))) throw setupCancelled(plan.op);
        this.host.stopLive();
        await this.writeState("settingUp");
    }

    /**
     * Init: wipe the remote and the local DB, write a new `vault:meta` from
     * the Step 1 settings, push this vault.
     *
     * Preparation: a passphrase is required when encryption is on; the
     * server must answer (a missing DB is fine — Init creates it); the meta
     * and its key are built from the Step 1 settings alone, with a fresh
     * salt and keyCheck; last, the user confirms, shown what the DB holds. Init creates a new vault that every other device
     * clones again, so nothing of the previous `vault:meta` or of a key
     * unlocked earlier in this session is carried over: a passphrase
     * changed in Step 1 is the one the new vault is encrypted with.
     *
     * The new meta carries a fresh `generationId`; the DB it is written to
     * is a new incarnation, which this device is bound to on success and
     * every other device tells apart from the one it set up against.
     */
    async init(): Promise<void> {
        return this.runOperation("init", async (progress, at) => {
            const s = this.settings();
            const enc = s.encryptionEnabled;
            const compress = s.compressionEnabled;
            if (enc && !s.encryptionPassphrase) {
                throw new UserFacingError(
                    "Encryption is on, but no passphrase is set — enter one in Step 1.",
                );
            }
            const raw = this.host.makeRawClient();
            progress.update("Checking the server...");
            const info = await probeServer(raw, { allowMissing: true });

            progress.update(enc ? "Deriving encryption keys..." : "Preparing vault metadata...");
            const { meta, crypto: derived } = await buildInitialVaultMeta({
                encryption: enc,
                passphrase: enc ? s.encryptionPassphrase : undefined,
                compression: compress,
            });
            const crypto = derived ?? undefined;

            await this.beginDestructive(progress, {
                op: "init", dbName: s.couchdbDbName, docCount: info ? info.doc_count : null,
                encryption: enc, compression: compress,
            });
            this.crypto = crypto;
            try {
                const result = await this.host.setup().init(
                    (msg) => progress.update(msg),
                    () => pushVaultMeta(raw, meta),
                );
                if (!enc) s.encryptionPassphrase = "";
                this.settleSetup(at, await metaFingerprint(meta));
                if (meta.encryption.enabled) {
                    this.ratchetCipherFloor(meta.encryption.cipherVersion);
                }
                await this.host.saveSettings();
                await this.readBackDb(raw);
                const modes: string[] = [];
                if (enc) modes.push("encrypted");
                if (compress) modes.push("compressed");
                const tag = modes.length ? ` (${modes.join(", ")})` : "";
                return `${result.vaultFiles} files, ${result.totalDocs} docs pushed${tag}.`;
            } catch (e) {
                this.crypto = undefined;
                throw e;
            }
        });
    }

    /**
     * Clone: empty the local DB, pull the remote vault, write its files, and
     * adopt the remote's codec.
     *
     * Preparation: the server must answer and the DB exist and hold
     * documents (what it holds is recorded, as a Check would); `vault:meta`
     * is read; an encrypted vault is unlocked — with the Step 1 passphrase,
     * else with one the user enters (the prompt stays open on a wrong one;
     * cancelling changes nothing); last, the user confirms, shown what the
     * DB holds. The passphrase comes before the confirmation because a
     * wrong or missing one refuses the run. The preparation reads the DB
     * itself, so Clone does not depend on a Check made before it.
     *
     * Execution runs the pull under the remote's codec held in memory; the
     * settings (encryption, passphrase, compression, cipher floor) are
     * committed together with `setupDone` only on success. The floor is set
     * to the adopted vault's, not ratcheted: re-cloning a vault of an older
     * cipher version must not keep a floor from another vault.
     */
    async clone(): Promise<void> {
        return this.runOperation("clone", async (progress, at) => {
            const s = this.settings();
            const raw = this.host.makeRawClient();
            progress.update("Reading vault:meta...");
            const info = await probeServer(raw, { allowMissing: false });
            const docCount = info?.doc_count ?? 0;
            this.recordDbCheck({
                at: Date.now(), against: vaultTarget(s), result: { status: "exists", docCount },
            });
            if (docCount === 0) {
                throw new VaultDbEmptyError();
            }
            const meta = await fetchVaultMeta(raw);

            let crypto: CryptoProvider | undefined;
            let targetPassphrase = "";
            let targetCipherVersion: number | undefined;
            if (meta && meta.encryption.enabled) {
                progress.update("Unlocking the vault key...");
                const unlocked = await this.unlockForClone(meta);
                crypto = unlocked.crypto;
                targetPassphrase = unlocked.passphrase;
                targetCipherVersion = meta.encryption.cipherVersion;
            }
            const targetEncryption = crypto !== undefined;
            const targetCompression = meta ? meta.compression.enabled : s.compressionEnabled;

            await this.beginDestructive(progress, {
                op: "clone", dbName: s.couchdbDbName, docCount,
                encryption: targetEncryption, compression: targetCompression,
            });
            this.crypto = crypto;
            this.encryptionOverride = targetEncryption;
            this.compressionOverride = targetCompression;
            this.cipherVersionOverride = targetCipherVersion;
            try {
                const result = await this.host.setup().clone((msg) => progress.update(msg));
                s.encryptionEnabled = targetEncryption;
                s.encryptionPassphrase = targetPassphrase;
                s.compressionEnabled = targetCompression;
                s.vaultCipherVersion = targetCipherVersion;
                this.settleSetup(at, meta ? await metaFingerprint(meta) : null);
                this.encryptionOverride = undefined;
                this.compressionOverride = undefined;
                this.cipherVersionOverride = undefined;
                await this.host.saveSettings();
                return `${result.vaultFiles} files written.`;
            } catch (e) {
                this.encryptionOverride = undefined;
                this.compressionOverride = undefined;
                this.cipherVersionOverride = undefined;
                this.crypto = undefined;
                throw e;
            }
        });
    }

    /** After Init filled the DB, read back what it holds, so a Check made
     *  before (an empty DB) does not keep describing it. When the read
     *  fails, the old finding is dropped: what the DB holds is unknown. */
    private async readBackDb(raw: ICouchClient): Promise<void> {
        const at = Date.now();
        const against = vaultTarget(this.settings());
        try {
            const info = await raw.withTimeout(REACHABILITY_TIMEOUT_MS).info();
            this.recordDbCheck({ at, against, result: { status: "exists", docCount: info.doc_count } });
        } catch (e) {
            logWarn(`could not read the vault DB back after Init: ${rawErrorMessage(e)}`);
            if (this.dbChecks.delete(against)) this.changed();
        }
    }

    /** Unlock the encrypted `meta` for Clone: the Step 1 passphrase first,
     *  then the user's answer. */
    private async unlockForClone(
        meta: VaultMetaDoc,
    ): Promise<{ crypto: CryptoProvider; passphrase: string }> {
        const atHand = this.settings().encryptionPassphrase;
        if (atHand) {
            const r = await unlockVaultMeta(meta, atHand);
            if (r) return { crypto: r.crypto, passphrase: atHand };
        }
        let unlocked: { crypto: CryptoProvider; passphrase: string } | null = null;
        const answer = await this.host.askPassphrase(atHand ? "mismatch" : "missing", async (p) => {
            const r = p ? await unlockVaultMeta(meta, p) : null;
            if (!r) return false;
            unlocked = { crypto: r.crypto, passphrase: p };
            return true;
        });
        if (answer === null || unlocked === null) throw setupCancelled("clone");
        return unlocked;
    }

    // ── Encryption agreement ───────────────────────────

    /**
     * Unlock the key at startup, before the live session starts, when the
     * vault is set up for live sync and the passphrase is stored. Best
     * effort: anything other than an agreed, unlockable vault is left to
     * the session's `checkAgreement`, which judges it.
     */
    async unlockAtStartup(): Promise<void> {
        const s = this.settings();
        if (this.crypto || !s.encryptionPassphrase) return;
        try {
            const agreement = await checkEncryptionAgreement(
                this.host.makeRawClient(), s.encryptionEnabled,
                VAULT_META_DOC_ID, s.vaultCipherVersion,
            );
            if (agreement.status === "cipher-downgrade-detected") {
                logWarn(
                    `vault:meta cipherVersion downgrade detected ` +
                    `(below floor ${agreement.localFloor}) — refusing early unlock.`,
                );
                return;
            }
            if (agreement.status !== "agreed-encrypted"
                || (agreement.meta as VaultMetaDoc).type !== "vault-meta") return;
            const meta = agreement.meta as VaultMetaDoc;
            const result = await unlockVaultMeta(meta, s.encryptionPassphrase);
            if (!result) return;
            this.crypto = result.crypto;
            if (meta.encryption.enabled && this.ratchetCipherFloor(meta.encryption.cipherVersion)) {
                await this.host.saveSettings();
            }
        } catch (e) {
            logWarn(`early vault crypto derivation failed (non-fatal): ${rawErrorMessage(e)}`);
        }
    }

    /**
     * The agreement check the live session runs before catchup (SyncEngine's
     * `RemoteAgreement.check`), under the engine's retry supervision.
     *
     *   - the server's vault DB must be the incarnation this device set up
     *     against (`settings.vaultRoot`); another device's Init re-created it
     *     (`root-changed`, see `recheckRoot`)
     *   - agreed: unlock the key once (asking for the passphrase when none
     *     is stored), ratchet the cipher floor, and take the server's
     *     compression flag. A pause noticed before is cleared. A device set
     *     up before the record existed adopts the server's meta here.
     *   - a transient failure while reading `vault:meta` is thrown as is and
     *     changes nothing: the check did not conclude, and the engine
     *     retries (the status bar shows the live session's errors).
     *   - a state the user has to act on pauses (`pause`), persisted so
     *     Step 3 says why, also after a reload.
     */
    async checkAgreement(_signal: AbortSignal): Promise<void> {
        const at = Date.now();
        const s = this.settings();
        const against = vaultTarget(s);
        const agreement = await checkEncryptionAgreement(
            this.host.makeRawClient(), s.encryptionEnabled,
            VAULT_META_DOC_ID, s.vaultCipherVersion,
        );

        if (agreement.status === "cipher-downgrade-detected") {
            throw await this.pause(at, against, "cipher-downgrade", { localFloor: agreement.localFloor });
        }
        const root = agreement.status !== "legacy-meta-only" && agreement.meta
            ? await metaFingerprint(agreement.meta)
            : null;
        if (this.rootChanged(against, root)) {
            throw await this.pause(at, against, "root-changed");
        }
        if (agreement.status === "remote-encrypted" || agreement.status === "remote-plaintext") {
            throw await this.pause(at, against, "encryption-changed", {
                remoteEncrypted: agreement.status === "remote-encrypted",
            });
        }
        if (agreement.status === "legacy-meta-only") {
            throw await this.pause(at, against, "legacy-meta");
        }

        if (agreement.status === "agreed-encrypted" && !this.crypto) {
            const meta = agreement.meta as VaultMetaDoc;
            const unlocked: { crypto: CryptoProvider | null } = { crypto: null };
            let passphrase = s.encryptionPassphrase;
            if (!passphrase) {
                const answer = await this.host.askPassphrase("missing", async (p) => {
                    unlocked.crypto = p ? (await unlockVaultMeta(meta, p))?.crypto ?? null : null;
                    return unlocked.crypto !== null;
                });
                if (answer === null || unlocked.crypto === null) {
                    throw await this.pause(at, against, "passphrase-missing");
                }
                passphrase = answer;
                s.encryptionPassphrase = passphrase;
                await this.host.saveSettings();
                this.changed();
            } else {
                unlocked.crypto = (await unlockVaultMeta(meta, passphrase))?.crypto ?? null;
                if (!unlocked.crypto) {
                    s.encryptionPassphrase = "";
                    await this.host.saveSettings();
                    throw await this.pause(at, against, "passphrase-mismatch");
                }
            }
            this.crypto = unlocked.crypto;
            const cv = meta.encryption.enabled ? meta.encryption.cipherVersion : 0;
            if (this.ratchetCipherFloor(cv)) await this.host.saveSettings();
        }

        // The compression flag is the server's: take it so every device
        // builds the same decorator stack.
        let changed = false;
        if (agreement.meta && s.compressionEnabled !== agreement.meta.compression.enabled) {
            s.compressionEnabled = agreement.meta.compression.enabled;
            changed = true;
        }
        const recorded = s.vaultRoot;
        if (!recorded || recorded.against !== against) {
            s.vaultRoot = { fingerprint: root, against };
            changed = true;
        }
        const pause = s.vaultPause;
        this.clearPause(at);
        if (s.vaultPause !== pause) changed = true;
        if (changed) {
            await this.host.saveSettings();
            this.changed();
        }
    }

    /**
     * Re-check, during a live session, that the server's vault DB is still
     * the one this device set up against. The pull calls it on a sign that
     * the DB was re-created: a pulled change of `vault:meta` (`observed`:
     * the pulled meta, or null when the change deleted it), a body that does
     * not decrypt, or a sequence that went backwards (`observed` omitted:
     * the meta is read from the server).
     *
     * Throws the pause when the DB was re-created; otherwise returns, also
     * when the meta cannot be read now — the session's own error handling
     * goes on, and the next session's `checkAgreement` judges again.
     * Without a record for this DB there is nothing to compare: the
     * session's `checkAgreement` records it.
     */
    async recheckRoot(observed?: VaultMetaDoc | null): Promise<void> {
        const at = Date.now();
        const against = vaultTarget(this.settings());
        const recorded = this.settings().vaultRoot;
        if (!recorded || recorded.against !== against) return;
        let meta = observed;
        if (meta === undefined) {
            try {
                meta = await fetchVaultMeta(this.host.makeRawClient());
            } catch (e) {
                logWarn(`could not read vault:meta to re-check the vault DB: ${rawErrorMessage(e)}`);
                return;
            }
        }
        const root = meta ? await metaFingerprint(meta) : null;
        if (this.rootChanged(against, root)) {
            throw await this.pause(at, against, "root-changed");
        }
    }

    /** The server's vault DB (its meta has fingerprint `root`, null: no
     *  meta) is not the incarnation this device set up against. Unknown
     *  (no record for `against`) is not a change. */
    private rootChanged(against: string, root: string | null): boolean {
        const recorded = this.settings().vaultRoot;
        return !!recorded && recorded.against === against && recorded.fingerprint !== root;
    }

    /** Pause live sync for a state the user has to act on: persist
     *  `tested` (the next load does not start sync; Step 3 offers Init and
     *  Clone) together with the reason, and return the terminal error for
     *  the caller to throw. The live session surfaces it once. */
    private async pause(
        at: number,
        against: string,
        reason: VaultPauseReason,
        detail: VaultPauseDetail = {},
    ): Promise<VaultEncryptionPausedError> {
        const s = this.settings();
        const kept = s.vaultPause;
        if (!kept || kept.at <= at) {
            const record: VaultPauseRecord = { reason, detail, at, against };
            s.vaultPause = record;
        }
        await this.writeState("tested");
        return new VaultEncryptionPausedError(reason, detail);
    }
}

/** Why the live session paused on the encryption agreement. */
export type VaultPauseReason =
    /** `vault:meta` declares a cipher version below this device's floor. */
    | "cipher-downgrade"
    /** The vault DB is not the incarnation this device set up against:
     *  another device's Init re-created it, or its `vault:meta` is gone. */
    | "root-changed"
    /** Another device turned encryption on or off. */
    | "encryption-changed"
    /** Only a pre-v2 `encryption:meta` is on the server. */
    | "legacy-meta"
    /** Encrypted, and the passphrase prompt was cancelled. */
    | "passphrase-missing"
    /** Encrypted, and the stored passphrase does not unlock it. */
    | "passphrase-mismatch";

export interface VaultPauseDetail {
    localFloor?: number;
    remoteEncrypted?: boolean;
}

function pauseMessage(reason: VaultPauseReason, d: VaultPauseDetail): string {
    const redo = "re-run Init or Clone in Vault Sync (Step 3)";
    switch (reason) {
        case "cipher-downgrade":
            return "Sync paused — the server's vault:meta declares an older cipher version " +
                `than this device trusts (below ${d.localFloor}), which can mean the server ` +
                `was tampered with. Verify the server, then ${redo}.`;
        case "root-changed":
            return "Sync paused — the vault database on the server is not the one this " +
                "device was set up with: Init on another device re-created it, or its " +
                "vault:meta is gone. Run Clone in Vault Sync (Step 3) to sync with it.";
        case "encryption-changed":
            return `Sync paused — another device turned vault encryption ` +
                `${d.remoteEncrypted ? "on" : "off"}. Match Step 1 in Vault Sync, then ${redo}.`;
        case "legacy-meta":
            return `Sync paused — this vault was set up with a pre-v2 build. To migrate, ${redo}.`;
        case "passphrase-missing":
            return "Sync paused — the vault is encrypted and no passphrase was entered. " +
                "Run Clone in Vault Sync (Step 3); it asks for the passphrase.";
        case "passphrase-mismatch":
            return "Sync paused — the stored passphrase does not unlock this vault. " +
                "Run Clone in Vault Sync (Step 3); it asks for the passphrase.";
    }
}

/**
 * The live session paused on the agreement check. Terminal for the
 * engine (`encryptionPaused`, see `classifyError`): retrying meets the same
 * server state. Carries its own sentence (`userMessage`).
 */
export class VaultEncryptionPausedError extends Error {
    readonly encryptionPaused = true;
    readonly userMessage: string;
    constructor(readonly reason: VaultPauseReason, readonly detail: VaultPauseDetail = {}) {
        const msg = pauseMessage(reason, detail);
        super(msg);
        this.name = "VaultEncryptionPausedError";
        this.userMessage = msg;
    }
}

/** Ask the server for the DB's info with a short timeout. A missing DB is
 *  an error unless `allowMissing` (then null). */
async function probeServer(raw: ICouchClient, opts: { allowMissing: boolean }): Promise<DbInfo | null> {
    try {
        return await raw.withTimeout(REACHABILITY_TIMEOUT_MS).info();
    } catch (e) {
        if (opts.allowMissing && classifyError(e).kind === "not-found") return null;
        throw e;
    }
}

/** Clone found the vault DB empty: there is nothing to clone. Recorded as
 *  what the DB holds (its check), not as an outcome of the Clone. */
class VaultDbEmptyError extends UserFacingError {
    constructor() {
        super("The database is empty — use Init to push your vault.");
    }
}

/** The user declined the confirmation of Init or Clone, or cancelled the
 *  passphrase prompt of Clone: a cancellation, not recorded as an outcome;
 *  the notice reads "<Init|Clone> cancelled — nothing was changed." */
function setupCancelled(op: VaultOpName): Error {
    const e: any = new Error(`${OP_LABELS[op]} cancelled — nothing was changed.`);
    e.name = "AbortError";
    e.userMessage = "nothing was changed.";
    return e;
}
