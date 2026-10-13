/**
 * vault-binding.ts — the owner of this device's setup of the vault DB.
 *
 * The live session is SyncEngine's; the config DB is ConfigBinding's. What
 * is left is the setup of the vault DB itself, and this class owns all of
 * it:
 *
 *   - the codec state the vault decorator stack is built from: the unlocked
 *     key, and the compression flag and cipher floor a Clone applies in
 *     memory before it commits them (`wrapClient`, `chunkHasher`);
 *   - Init and Clone, each run as a preparation that changes nothing and
 *     an execution that is destructive (see `runOperation`);
 *   - the encryption-agreement check the live session runs before catchup
 *     (`checkAgreement`);
 *   - how the last Init / Clone and the last agreement check ended
 *     (`relation`).
 *
 * Has no dependency on Obsidian: the host injects settings, the setup
 * runner, the live-sync switch, the progress notice and the passphrase
 * prompt.
 */
import type { CouchSyncSettings, ConnectionState } from "../settings.ts";
import type { ICouchClient } from "../db/interfaces.ts";
import type { CryptoProvider } from "../db/crypto-provider.ts";
import type { AuthGate } from "../db/sync/auth-gate.ts";
import { EncryptingCouchClient } from "../db/encrypting-couch-client.ts";
import { CompressingCouchClient } from "../db/compressing-couch-client.ts";
import { computeHash, type ChunkHasher } from "../db/chunker.ts";
import type { ChunkHashAlg } from "../types/doc-id.ts";
import {
    buildInitialVaultMeta,
    fetchVaultMeta,
    pushVaultMeta,
    unlockVaultMeta,
    VAULT_META_DOC_ID,
    type VaultMetaDoc,
} from "../db/vault-meta.ts";
import { checkEncryptionAgreement, type EncryptionAgreement } from "../db/encryption-agreement.ts";
import { classifyError } from "../db/sync/errors.ts";
import { describeError, rawErrorMessage, UserFacingError } from "../ui/describe-error.ts";
import { logWarn } from "../ui/log.ts";
import { OutcomeLedger, type OpOutcome, type OutcomeView } from "./op-outcome.ts";
import type { SetupResult } from "./setup.ts";

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
    init(onProgress: (msg: string) => void): Promise<SetupResult>;
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
    /** Stop the live session and the change tracker. */
    stopLive(): void;
    openProgress(label: string): VaultProgress;
    askPassphrase: AskVaultPassphrase;
}

/** The vault operations whose outcome describes this device's setup.
 *  `agreement` is the encryption-agreement check the live session runs;
 *  the others are the user's. */
export type VaultOpName = "init" | "clone" | "agreement";

export type VaultOutcome = OpOutcome<VaultOpName>;

const OP_LABELS: Record<Exclude<VaultOpName, "agreement">, string> = {
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
    /** Compression flag applied in memory while a Clone runs, before it
     *  commits `settings.compressionEnabled` — a failed Clone persists
     *  nothing. Undefined at all other times. */
    private compressionOverride?: boolean;
    /** Cipher floor applied in memory while a Clone runs, before it
     *  commits `settings.vaultCipherVersion`. Undefined at all other times. */
    private cipherVersionOverride?: number;
    private inflight: Exclude<VaultOpName, "agreement"> | null = null;
    private readonly outcomes = new OutcomeLedger<VaultOpName>((op) => op === "agreement");
    /** The agreement the last check disagreed with (encryption changed by
     *  another device, or a cipher downgrade), for the Step 1 warning. */
    encryptionMismatch?: EncryptionAgreement;

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

    // ── Codec stack ────────────────────────────────────

    private hmacKey(): CryptoProvider | undefined {
        return this.settings().encryptionEnabled ? this.crypto : undefined;
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
     * (VaultRemoteOps, SyncEngine). The encryption setting decides whether
     * the encrypt layer is applied, not whether a key exists: a key left
     * from an earlier encrypted session never encrypts a plaintext vault,
     * and an encrypted vault without a key is refused (fail-closed).
     *
     * Compose order is `compress(encrypt(raw))`: on push the plain payload
     * reaches gzip before the cipher makes it incompressible.
     */
    wrapClient = (raw: ICouchClient): ICouchClient => {
        let client: ICouchClient = raw;
        if (this.settings().encryptionEnabled) {
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

    /** Persist the setup state. The one place `connectionState` changes. */
    private async writeState(state: ConnectionState): Promise<void> {
        this.settings().connectionState = state;
        await this.host.saveSettings();
    }

    /** The Init or Clone running now, or null. */
    busy(): "init" | "clone" | null {
        return this.inflight;
    }

    /** How the last Init / Clone and the last agreement check ended, for the
     *  vault DB the settings name now. In memory only. */
    outcomesNow(): OutcomeView<VaultOpName> {
        return this.outcomes.view(vaultTarget(this.settings()));
    }

    // ── Init / Clone ───────────────────────────────────

    /**
     * Run Init or Clone. The notice is opened first, so no failure goes
     * unreported. A second run while one is in flight is refused; so is a
     * run while the auth latch is raised. `body` prepares (reads, derives,
     * asks — nothing is changed, and a failure leaves the setup state and
     * live sync as they were), then calls `beginDestructive` and executes.
     *
     * This is the one exit of an Init / Clone failure: the outcome is
     * recorded (a cancellation is not), a 401/403 raises the auth latch,
     * and the notice words the error. The error is rethrown so the caller
     * only has to restore its button.
     */
    private async runOperation(
        op: "init" | "clone",
        body: (progress: VaultProgress) => Promise<string>,
    ): Promise<void> {
        const progress = this.host.openProgress(OP_LABELS[op]);
        if (this.inflight) {
            const e = new UserFacingError(
                `${OP_LABELS[this.inflight]} is running — wait for it to finish.`,
            );
            progress.fail(e);
            throw e;
        }
        this.inflight = op;
        const at = Date.now();
        const against = vaultTarget(this.settings());
        try {
            if (this.host.auth.isBlocked()) throw this.host.auth.blockedError();
            const summary = await body(progress);
            this.outcomes.record({ op, at, against, error: null });
            progress.done(summary);
        } catch (e) {
            const d = classifyError(e);
            if (d.kind === "auth" && typeof d.code === "number") {
                this.host.auth.raise(d.code, rawErrorMessage(e));
            }
            if (!describeError(e).cancelled) {
                this.outcomes.record({ op, at, against, error: e });
            }
            progress.fail(e);
            throw e;
        } finally {
            this.inflight = null;
        }
    }

    /** The point of no return of Init and Clone: stop live sync and persist
     *  `settingUp` before anything is destroyed, so a failure (or a crash)
     *  from here on never leaves `setupDone` / `syncing` behind on a
     *  half-built DB. */
    private async beginDestructive(): Promise<void> {
        this.host.stopLive();
        await this.writeState("settingUp");
    }

    /**
     * Init: wipe the remote and the local DB, push this vault, write a new
     * `vault:meta` from the Step 1 settings.
     *
     * Preparation: a passphrase is required when encryption is on; the
     * server must answer (a missing DB is fine — Init creates it); the meta
     * and its key are built. With a key already unlocked in this session
     * and encryption on, the existing `vault:meta`'s salt and keyCheck are
     * kept (the key stays the same) and only the cipher format and the
     * compression flag are restamped.
     */
    async init(): Promise<void> {
        return this.runOperation("init", async (progress) => {
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
            await probeServer(raw, { allowMissing: true });

            let meta: VaultMetaDoc;
            let crypto: CryptoProvider | undefined;
            if (enc && this.crypto) {
                const existing = await fetchVaultMeta(raw);
                if (!existing || !existing.encryption.enabled) {
                    throw new UserFacingError(
                        "Init keeps the vault's current encryption key, but the server has " +
                            "no encrypted vault:meta to keep it from. Reload Obsidian, then " +
                            "run Init again to create a new key.",
                    );
                }
                meta = {
                    ...existing,
                    // A re-init writes encBody bodies: stamp the current
                    // cipher format, not the one the vault was created with.
                    encryption: { ...existing.encryption, cipherVersion: 3 },
                    compression: compress
                        ? { enabled: true, algorithm: "gzip", version: 1 }
                        : { enabled: false },
                };
                crypto = this.crypto;
            } else {
                progress.update(enc ? "Deriving encryption keys..." : "Preparing vault metadata...");
                const derived = await buildInitialVaultMeta({
                    encryption: enc,
                    passphrase: enc ? s.encryptionPassphrase : undefined,
                    compression: compress,
                });
                meta = derived.meta;
                crypto = derived.crypto ?? undefined;
            }

            await this.beginDestructive();
            this.crypto = crypto;
            try {
                const result = await this.host.setup().init((msg) => progress.update(msg));
                progress.update("Writing vault metadata...");
                await pushVaultMeta(raw, meta);
                if (!enc) s.encryptionPassphrase = "";
                s.connectionState = "setupDone";
                this.encryptionMismatch = undefined;
                if (meta.encryption.enabled) {
                    this.ratchetCipherFloor(meta.encryption.cipherVersion);
                }
                await this.host.saveSettings();
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
     * Preparation: the server must answer and the DB exist; `vault:meta` is
     * read; an encrypted vault is unlocked — with the Step 1 passphrase,
     * else with one the user enters (the prompt stays open on a wrong one;
     * cancelling changes nothing).
     *
     * Execution runs the pull under the remote's codec held in memory; the
     * settings (encryption, passphrase, compression, cipher floor) are
     * committed together with `setupDone` only on success. The floor is set
     * to the adopted vault's, not ratcheted: re-cloning a vault of an older
     * cipher version must not keep a floor from another vault.
     */
    async clone(): Promise<void> {
        return this.runOperation("clone", async (progress) => {
            const s = this.settings();
            const raw = this.host.makeRawClient();
            progress.update("Reading vault:meta...");
            await probeServer(raw, { allowMissing: false });
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

            await this.beginDestructive();
            this.crypto = crypto;
            this.compressionOverride = targetCompression;
            this.cipherVersionOverride = targetCipherVersion;
            try {
                const result = await this.host.setup().clone((msg) => progress.update(msg));
                s.encryptionEnabled = targetEncryption;
                s.encryptionPassphrase = targetPassphrase;
                s.compressionEnabled = targetCompression;
                s.vaultCipherVersion = targetCipherVersion;
                s.connectionState = "setupDone";
                this.compressionOverride = undefined;
                this.cipherVersionOverride = undefined;
                this.encryptionMismatch = undefined;
                await this.host.saveSettings();
                return `${result.vaultFiles} files written.`;
            } catch (e) {
                this.compressionOverride = undefined;
                this.cipherVersionOverride = undefined;
                this.crypto = undefined;
                throw e;
            }
        });
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
        if (answer === null || unlocked === null) throw setupCancelled();
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
                this.encryptionMismatch = agreement;
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
     * The encryption-agreement check the live session runs before catchup
     * (SyncEngine's `preCatchupCheck`), under the engine's retry
     * supervision.
     *
     *   - agreed: unlock the key once (asking for the passphrase when none
     *     is stored), ratchet the cipher floor, and take the server's
     *     compression flag. Returns normally.
     *   - a transient failure while reading `vault:meta` is thrown as is;
     *     the engine retries.
     *   - a state the user has to act on (cipher downgrade, encryption
     *     changed by another device, pre-v2 meta, no or a wrong passphrase)
     *     pauses: see `pause`.
     */
    async checkAgreement(_signal: AbortSignal): Promise<void> {
        const s = this.settings();
        const agreement = await checkEncryptionAgreement(
            this.host.makeRawClient(), s.encryptionEnabled,
            VAULT_META_DOC_ID, s.vaultCipherVersion,
        );

        if (agreement.status === "cipher-downgrade-detected") {
            this.encryptionMismatch = agreement;
            throw await this.pause(
                "vault encryption was downgraded on the server " +
                `(cipherVersion below this device's floor ${agreement.localFloor}). ` +
                "Sync paused — verify the server has not been tampered with.",
            );
        }

        if (agreement.status === "agreed-encrypted") {
            if (!this.crypto) {
                const meta = agreement.meta as VaultMetaDoc;
                let passphrase = s.encryptionPassphrase;
                let crypto: CryptoProvider | null = null;
                if (!passphrase) {
                    const answer = await this.host.askPassphrase("missing", async (p) => {
                        crypto = p ? (await unlockVaultMeta(meta, p))?.crypto ?? null : null;
                        return crypto !== null;
                    });
                    if (answer === null || crypto === null) {
                        throw await this.pause("passphrase required. Sync paused.");
                    }
                    passphrase = answer;
                } else {
                    crypto = (await unlockVaultMeta(meta, passphrase))?.crypto ?? null;
                    if (!crypto) {
                        s.encryptionPassphrase = "";
                        await this.host.saveSettings();
                        throw await this.pause("wrong passphrase. Sync paused.");
                    }
                }
                if (!s.encryptionPassphrase) {
                    s.encryptionPassphrase = passphrase;
                    await this.host.saveSettings();
                }
                this.crypto = crypto!;
                const cv = meta.encryption.enabled ? meta.encryption.cipherVersion : 0;
                if (this.ratchetCipherFloor(cv)) await this.host.saveSettings();
            }
        } else if (agreement.status === "remote-encrypted"
            || agreement.status === "remote-plaintext") {
            this.encryptionMismatch = agreement;
            throw await this.pause(
                "encryption state changed by another device. " +
                "Open Settings → Vault Sync to re-run Init or Clone.",
            );
        } else if (agreement.status === "legacy-meta-only") {
            throw await this.pause(
                "this vault was set up with a pre-v2 build. " +
                "Open Settings → Vault Sync and re-run Init or Clone to migrate.",
            );
        }

        // The compression flag is the server's: take it so every device
        // builds the same decorator stack.
        const remoteMeta = (agreement.status === "agreed-encrypted"
            || agreement.status === "agreed-plaintext") ? agreement.meta : null;
        if (remoteMeta && s.compressionEnabled !== remoteMeta.compression.enabled) {
            s.compressionEnabled = remoteMeta.compression.enabled;
            await this.host.saveSettings();
        }
        if (agreement.status === "agreed-encrypted" || agreement.status === "agreed-plaintext") {
            this.encryptionMismatch = undefined;
        }
    }

    /** Pause live sync for a state the user has to act on: persist
     *  `tested` (the next load does not start sync; Step 3 offers Init and
     *  Clone) and return the terminal error for the caller to throw. */
    private async pause(message: string): Promise<Error> {
        await this.writeState("tested");
        return Object.assign(new Error(message), { encryptionPaused: true });
    }
}

/** Ask the server for the DB's info with a short timeout. A missing DB is
 *  an error unless `allowMissing`. */
async function probeServer(raw: ICouchClient, opts: { allowMissing: boolean }): Promise<void> {
    try {
        await raw.withTimeout(REACHABILITY_TIMEOUT_MS).info();
    } catch (e) {
        if (opts.allowMissing && classifyError(e).kind === "not-found") return;
        throw e;
    }
}

/** The user cancelled the passphrase prompt of Clone: a cancellation, not
 *  recorded as an outcome; the notice reads "Clone cancelled — nothing
 *  was changed." */
function setupCancelled(): Error {
    const e: any = new Error("Clone cancelled — nothing was changed.");
    e.name = "AbortError";
    e.userMessage = "nothing was changed.";
    return e;
}
