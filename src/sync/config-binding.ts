/**
 * config-binding.ts — the owner of every piece of config-sync state that
 * belongs to ONE config DB on ONE server.
 *
 * A binding is identified by `configBindingKey(server, db)` — the same key
 * everywhere:
 *
 *   - the local store (`ConfigLocalDB`), named from the key
 *     (`configStoreName`), holding the docs, the per-path `ConfigLastSynced`
 *     cache, the `ConfigCheckpoints` cursors AND this device's participation
 *     record (`ConfigAttachment`: the codec it syncs with and the root it
 *     joined). Deleting the store detaches the device.
 *   - the settings entry `configBindings[key]`: only what must survive the
 *     store — the cipher floor and the Create-interrupted flag.
 *   - a memo of the PBKDF2 unlock for that DB's root (in memory only).
 *
 * The binding also pins the server URI it was opened for; its raw clients
 * always talk to that server. The server and DB name change only through
 * `ConfigSync.rebind`, which replaces the binding and the settings together
 * (see the invariant there), so a binding never talks to a server or DB the
 * settings no longer name.
 *
 * Mutation discipline: only operations holding ConfigSync's op lock change
 * a binding (Join, Create, and the preflight of Push / Pull via `preflight`,
 * which ratchets the floor). `inspect` is the read-only half of the
 * preflight, for callers without the lock (the settings filter tree). There
 * is no "installed" key: an op freezes its keys (`ConfigOpKeys`: codec, key,
 * floor, chunk hasher) when its preflight passes and carries them for its
 * whole run, so nothing that runs alongside it can switch its encryption or
 * chunk-id space mid-op.
 *
 * State is evaluated per op, never persisted as a state machine (design
 * 状態モデル): Disabled (no binding), Unattached (no attachment in the
 * store), SettingUp (the setup flag), Blocked (a `ConfigNotReadyError`
 * kind) or Ready. The key never depends on the vault's connectionState
 * (invariant 18).
 */
import { ConfigLocalDB } from "../db/config-local-db.ts";
import type { ICouchClient } from "../db/interfaces.ts";
import type { CryptoProvider } from "../db/crypto-provider.ts";
import { EncryptingCouchClient } from "../db/encrypting-couch-client.ts";
import { CompressingCouchClient } from "../db/compressing-couch-client.ts";
import { computeHash, type ChunkHasher } from "../db/chunker.ts";
import type { ConfigBindingRecord, CouchSyncSettings } from "../settings.ts";
import { ConfigLastSynced } from "../db/sync/config-last-synced.ts";
import { ConfigCheckpoints } from "../db/sync/config-checkpoints.ts";
import { joinedConfigPassphrase, resolveConfigCodec } from "./config-codec-policy.ts";
import {
    ConfigNotReadyError,
    configNotReady,
    type ConfigNotReadyContext,
    type ConfigNotReadyKind,
} from "./config-errors.ts";
import {
    fetchConfigMeta,
    unlockConfigMeta,
    type ConfigMetaDoc,
} from "../db/vault-meta.ts";
import { classifyError } from "../db/sync/errors.ts";
import {
    CONFIG_ATTACHMENT_KEY,
    configBindingKey,
    configMetaFingerprint,
    configStoreName,
    describeCodec,
    metaCodec,
    parseAttachment,
    type ConfigAttachment,
    type ConfigCodec,
} from "./config-binding-record.ts";
import { logWarn } from "../ui/log.ts";

/** Builds (but does not open) the local store with the given IndexedDB
 *  name (`configStoreName`). Production uses `defaultConfigStoreFactory`;
 *  tests inject their own. */
export type ConfigStoreFactory = (storeName: string) => ConfigLocalDB;

export const defaultConfigStoreFactory: ConfigStoreFactory =
    (storeName) => new ConfigLocalDB(storeName);

/** Host services a binding needs: the live settings (passphrase, and its
 *  `configBindings` entry) and a way to persist them. */
export interface ConfigBindingHost {
    getSettings: () => CouchSyncSettings;
    saveSettings: () => Promise<void>;
}

/** Result of the latest preflight / Join / Create on this binding, for the
 *  settings tab's status line. */
export type ConfigBindingStatus =
    | { state: "ready"; at: number }
    | { state: "blocked"; kind: ConfigNotReadyKind; message: string; at: number };

/**
 * Everything an op encodes and decodes with, fixed for the op's whole run:
 * the codec from the attachment, the unlocked key, the cipher floor, and a
 * chunk hasher built from those two (HMAC under the key when the DB is
 * encrypted, xxhash64 otherwise — invariant 18, config and vault mint chunk
 * ids in disjoint spaces).
 */
export interface ConfigOpKeys {
    readonly codec: ConfigCodec;
    readonly crypto: CryptoProvider | null;
    readonly cipherFloor?: number;
    readonly hasher: ChunkHasher;
}

/**
 * Build an op's keys. Fail-closed: an encrypted codec without a key throws
 * `key-missing` — it never falls back to the plaintext xxhash64 hasher,
 * which would mint chunk ids that leak content hashes into an encrypted
 * DB. `db` only names the DB in that message.
 */
export function makeConfigOpKeys(
    codec: ConfigCodec,
    crypto: CryptoProvider | null,
    cipherFloor?: number,
    db?: string,
): ConfigOpKeys {
    let hasher: ChunkHasher;
    if (codec.encryption) {
        if (!crypto) throw configNotReady("key-missing", { db });
        hasher = { alg: "hmac", hash: (data) => crypto.hmacHash(data) };
    } else {
        hasher = { alg: "x64", hash: (data) => computeHash(data) };
    }
    return { codec, crypto, cipherFloor, hasher };
}

/** Outcome of `inspect`: the root passed every check. */
export interface ConfigVerdict {
    attachment: ConfigAttachment;
    meta: ConfigMetaDoc;
    crypto: CryptoProvider | null;
}

export interface ConfigJoinOptions {
    /** Ask the user for the config passphrase when none is set. Returning
     *  null / "" aborts the Join as `passphrase-missing`. */
    promptPassphrase?: () => Promise<string | null>;
    /** Confirm adopting a codec weaker than the one this device trusted for
     *  the DB (encryption removed, or a cipherVersion below the floor).
     *  Omitted or false → the Join is cancelled with nothing changed. */
    confirmWeaker?: (title: string, message: string) => Promise<boolean>;
    onProgress?: (msg: string) => void;
}

export class ConfigBinding {
    /** `configBindingKey(serverUri, dbName)` — the identity of this binding. */
    readonly key: string;
    readonly lastSynced: ConfigLastSynced;
    readonly checkpoints: ConfigCheckpoints;

    private checkpointsLoaded = false;
    private closed = false;
    private lastStatus: ConfigBindingStatus | undefined;

    /** Result of the last passphrase check against one `config:meta` root.
     *  A memo of PBKDF2 results, not binding state: negative results are
     *  cached too, so a wrong passphrase costs one PBKDF2 per session. */
    private keyCache: { metaFp: string; passphrase: string; crypto: CryptoProvider | null } | null = null;
    /** De-duplicates concurrent unlocks (an op and the filter tree). */
    private pendingUnlock: { key: string; promise: Promise<CryptoProvider | null> } | null = null;
    private derivations = 0;

    private constructor(
        /** The server URI this binding was opened for (raw, as in settings). */
        readonly serverUri: string,
        readonly dbName: string,
        readonly store: ConfigLocalDB,
        private readonly host: ConfigBindingHost,
        /** Mirror of the store's `CONFIG_ATTACHMENT_KEY`. */
        private att: ConfigAttachment | null,
    ) {
        this.key = configBindingKey(serverUri, dbName);
        this.lastSynced = new ConfigLastSynced(store);
        this.checkpoints = new ConfigCheckpoints(store);
    }

    /** Open the store for (server, DB) and return a binding over it. The
     *  schema stamp is checked here (invariant 15) and the attachment read;
     *  on failure the store is closed again and the error propagates. */
    static async open(
        vaultName: string,
        serverUri: string,
        dbName: string,
        host: ConfigBindingHost,
        storeFactory: ConfigStoreFactory = defaultConfigStoreFactory,
    ): Promise<ConfigBinding> {
        const store = storeFactory(await configStoreName(vaultName, serverUri, dbName));
        store.open();
        let att: ConfigAttachment | null;
        try {
            await store.ensureSchemaVersion();
            att = parseAttachment(await store.getMeta(CONFIG_ATTACHMENT_KEY));
        } catch (e) {
            await store.close().catch(() => {});
            throw e;
        }
        return new ConfigBinding(serverUri, dbName, store, host, att);
    }

    /** Close the store and drop the key. Idempotent. The store stays on disk. */
    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.keyCache = null;
        this.lastSynced.clear();
        this.checkpointsLoaded = false;
        await this.store.close();
    }

    isClosed(): boolean {
        return this.closed;
    }

    // ── Participation ──────────────────────────────────

    /** The attachment recorded in this binding's store, or null when this
     *  device has not joined (or created) the DB with this store. */
    get attachment(): ConfigAttachment | null {
        return this.att;
    }

    /** This binding's settings entry (cipher floor, setup flag). */
    entry(): ConfigBindingRecord | undefined {
        return this.host.getSettings().configBindings?.[this.key];
    }

    /** Replace this binding's settings entry and persist settings. The map
     *  is replaced, never mutated in place, so a settings object that
     *  shares its map with another (e.g. DEFAULT_SETTINGS) is never touched.
     *  `passphrase`, when given, is stored as the explicit config passphrase
     *  in the same save (Create / Join, see `join` step 5). */
    private async putEntry(rec: ConfigBindingRecord, passphrase?: string): Promise<void> {
        if (this.closed) return;
        const s = this.host.getSettings();
        s.configBindings = { ...(s.configBindings ?? {}), [this.key]: rec };
        if (passphrase !== undefined) s.configEncryptionPassphrase = passphrase;
        await this.host.saveSettings();
    }

    /** Read the attachment from the store (the source of truth). */
    private async readAttachment(): Promise<ConfigAttachment | null> {
        return parseAttachment(await this.store.getMeta(CONFIG_ATTACHMENT_KEY));
    }

    /** Write the attachment into the store — the commit point of Create
     *  and Join. One IndexedDB transaction. */
    private async writeAttachment(att: ConfigAttachment): Promise<void> {
        await this.store.runWriteTx({
            meta: [{ op: "put", key: CONFIG_ATTACHMENT_KEY, value: att }],
        });
        this.att = att;
    }

    /** Latest preflight / Join / Create outcome, or undefined when none ran. */
    get status(): ConfigBindingStatus | undefined {
        return this.lastStatus;
    }

    // ── Keys ───────────────────────────────────────────

    /** Number of PBKDF2 derivations this binding ran (diagnostics / tests:
     *  the key is derived once per root + passphrase per session). */
    get keyDerivations(): number {
        return this.derivations;
    }

    /**
     * Keys for local work outside an op (a bare `ConfigSync.scan`): the
     * attachment's codec, and — when it is encrypted — the key this session
     * already unlocked for the joined root with the current passphrase.
     * Throws `key-missing` when there is no such key (no op ran yet, or the
     * passphrase changed since); never a plaintext hasher for an encrypted
     * DB. Ops use the keys their preflight froze instead.
     */
    currentKeys(): ConfigOpKeys {
        const codec = this.att?.codec ?? { encryption: false, compression: false };
        let crypto: CryptoProvider | null = null;
        if (codec.encryption) {
            const memo = this.keyCache;
            if (memo && memo.metaFp === this.att?.metaFingerprint
                && memo.passphrase === joinedConfigPassphrase(this.host.getSettings())) {
                crypto = memo.crypto;
            }
        }
        return makeConfigOpKeys(codec, crypto, this.entry()?.cipherFloor, this.dbName);
    }

    // ── Cursors / caches ───────────────────────────────

    /** Lazy-load the persisted pull/push cursors. Idempotent. */
    async ensureCheckpointsLoaded(): Promise<void> {
        if (this.checkpointsLoaded) return;
        await this.checkpoints.load();
        this.checkpointsLoaded = true;
    }

    /** Force a reload on the next `ensureCheckpointsLoaded` (after the store
     *  was wiped). */
    invalidateCheckpoints(): void {
        this.checkpointsLoaded = false;
    }

    /** Empty this binding's local store (docs, chunks, cursors, lastSynced
     *  AND the attachment) and re-open it stamped. The device is Unattached
     *  afterwards until the caller commits. Used by Create and Join. */
    async resetStore(): Promise<void> {
        this.att = null;
        await this.store.destroy();
        this.store.open();
        await this.store.ensureSchemaVersion();
        this.lastSynced.clear();
        this.invalidateCheckpoints();
    }

    // ── Readiness ──────────────────────────────────────

    private ctx(extra: ConfigNotReadyContext = {}): ConfigNotReadyContext {
        return { db: this.dbName, ...extra };
    }

    /**
     * The local half of readiness — no I/O. An interrupted Create first
     * (the remote may be half-built), then "not joined".
     *
     * `requireAttached: false` is for local-only work (`ConfigSync.write`),
     * which must still refuse a half-built DB but has no business demanding
     * a Join.
     */
    assertLocalReady(opts: { requireAttached: boolean }): ConfigAttachment | null {
        if (this.entry()?.settingUp) {
            throw configNotReady("setup-interrupted", this.ctx());
        }
        if (!this.att && opts.requireAttached) {
            throw configNotReady("unattached", this.ctx());
        }
        return this.att;
    }

    /**
     * Read-only readiness check against the server: judges the root and
     * unlocks its key, but changes nothing on the binding (the PBKDF2 memo
     * aside). Safe without the op lock — the settings filter tree uses it.
     *
     *   1. local: setup-interrupted → unattached
     *   2. `config:meta` (one GET on the raw client): no meta →
     *      uninitialized / meta-missing / db-missing; schemaVersion ≠ 2 →
     *      legacy-meta; cipherVersion below this DB's floor →
     *      cipher-downgrade
     *   3. the root must be the one this device joined: an encrypted
     *      attachment facing a plaintext root is encryption-removed, any
     *      other difference root-changed
     *   4. encrypted: passphrase-missing / passphrase-mismatch, else the key
     *      (cached — PBKDF2 once per root + passphrase per session). The
     *      passphrase is the one Create / Join saved in the config settings
     *      (`joinedConfigPassphrase`) — never the vault's, so a vault-side
     *      change after joining cannot stop config sync
     *
     * Never re-joins by itself: a changed root would mix old vclocks into
     * the new DB, so the user Joins explicitly.
     */
    async inspect(raw: ICouchClient, signal?: AbortSignal): Promise<ConfigVerdict> {
        if (this.entry()?.settingUp) {
            throw configNotReady("setup-interrupted", this.ctx());
        }
        // The store is the source of truth; the `attachment` mirror is for
        // synchronous readers and is refreshed only under the op lock.
        const att = await this.readAttachment();
        if (!att) throw configNotReady("unattached", this.ctx());
        const floor = this.entry()?.cipherFloor;

        const meta = await fetchConfigMeta(raw);
        throwIfAborted(signal);
        if (!meta) throw await this.classifyMissingMeta(raw, signal);
        if (meta.schemaVersion !== 2) {
            throw configNotReady("legacy-meta", this.ctx({ schemaVersion: meta.schemaVersion }));
        }
        if (meta.encryption.enabled && floor !== undefined
            && meta.encryption.cipherVersion < floor) {
            throw configNotReady("cipher-downgrade", this.ctx({
                remoteCipherVersion: meta.encryption.cipherVersion, localFloor: floor,
            }));
        }
        if (att.codec.encryption && !meta.encryption.enabled) {
            throw configNotReady("encryption-removed", this.ctx());
        }
        const metaFp = await configMetaFingerprint(meta);
        if (att.metaFingerprint !== metaFp) {
            throw configNotReady("root-changed", this.ctx());
        }

        let crypto: CryptoProvider | null = null;
        if (meta.encryption.enabled) {
            const passphrase = joinedConfigPassphrase(this.host.getSettings());
            if (!passphrase) throw configNotReady("passphrase-missing", this.ctx());
            crypto = await this.unlock(meta, metaFp, passphrase);
            throwIfAborted(signal);
            if (!crypto) throw configNotReady("passphrase-mismatch", this.ctx());
        }
        return { attachment: att, meta, crypto };
    }

    /**
     * Per-op readiness check for ops holding the op lock (Push, Pull):
     * `inspect`, then apply the verdict — ratchet the cipher floor (TOFU)
     * and record the status. Returns the keys the op must use for its whole
     * run. On a not-ready verdict the status records the cause.
     */
    async preflight(raw: ICouchClient, signal?: AbortSignal): Promise<ConfigOpKeys> {
        let verdict: ConfigVerdict;
        try {
            if (!this.closed) this.att = await this.readAttachment();
            verdict = await this.inspect(raw, signal);
        } catch (e) {
            this.recordFailure(e);
            throw e;
        }
        const entry = this.entry();
        let floor = entry?.cipherFloor;
        const cv = verdict.meta.encryption.enabled
            ? verdict.meta.encryption.cipherVersion : undefined;
        if (cv !== undefined && cv > (floor ?? 0)) {
            floor = cv;
            await this.putEntry({ ...(entry ?? { settingUp: false }), cipherFloor: cv });
        }
        this.lastStatus = { state: "ready", at: Date.now() };
        return makeConfigOpKeys(verdict.attachment.codec, verdict.crypto, floor, this.dbName);
    }

    private recordFailure(e: unknown): void {
        if (e instanceof ConfigNotReadyError) {
            this.lastStatus = { state: "blocked", kind: e.kind, message: e.message, at: Date.now() };
        }
    }

    /** `config:meta` is absent: tell an empty DB (never set up) from one
     *  holding documents (legacy layout / interrupted Create) and from a DB
     *  that does not exist at all. */
    private async classifyMissingMeta(
        raw: ICouchClient,
        signal?: AbortSignal,
    ): Promise<ConfigNotReadyError> {
        let docCount: number;
        try {
            docCount = (await raw.info(signal)).doc_count ?? 0;
        } catch (e) {
            if (classifyError(e).kind === "not-found") {
                return configNotReady("db-missing", this.ctx());
            }
            throw e;
        }
        return docCount === 0
            ? configNotReady("uninitialized", this.ctx())
            : configNotReady("meta-missing", this.ctx({ docCount }));
    }

    /** Unlock `meta` with `passphrase`, at most once per root + passphrase
     *  per session (negative results included), de-duplicating concurrent
     *  callers. */
    private async unlock(
        meta: ConfigMetaDoc,
        metaFp: string,
        passphrase: string,
    ): Promise<CryptoProvider | null> {
        const cached = this.keyCache;
        if (cached && cached.metaFp === metaFp && cached.passphrase === passphrase) {
            return cached.crypto;
        }
        const key = `${metaFp}\u0000${passphrase}`;
        if (this.pendingUnlock?.key === key) return this.pendingUnlock.promise;
        this.derivations++;
        const promise = unlockConfigMeta(meta, passphrase).then((r) => r?.crypto ?? null);
        this.pendingUnlock = { key, promise };
        try {
            const crypto = await promise;
            if (!this.closed) this.keyCache = { metaFp, passphrase, crypto };
            return crypto;
        } finally {
            if (this.pendingUnlock?.key === key) this.pendingUnlock = null;
        }
    }

    // ── Join / Create ──────────────────────────────────

    /**
     * Join: accept the config DB's existing root and attach this device.
     * Touches no config file, never writes to the server, and never changes
     * the Step 1 codec settings — the DB's codec goes into the attachment.
     *
     *   1. read `config:meta` on the raw client and classify it
     *   2. a codec weaker than this device trusted for the DB (encryption
     *      removed, or a cipherVersion below the floor) needs the user's
     *      confirmation; cancelled → nothing changes
     *   3. unlock with the passphrase — the Step 1 input
     *      (`resolveConfigCodec`: the config value, else the vault's),
     *      asking for it when both are empty
     *   4. empty this binding's local store (cursors of any earlier root
     *      must not be reused) — Unattached from here until 6
     *   5. settings, in ONE save: the floor is SET to the root's (not
     *      ratcheted), the setup flag cleared, and — encrypted root only —
     *      the passphrase that unlocked it stored as the explicit
     *      `configEncryptionPassphrase`. From here on every op unlocks with
     *      that value alone; the vault passphrase is never consulted again
     *      for this DB. A plaintext root stores no passphrase.
     *   6. commit: the attachment is written into the store
     *
     * Nothing is changed before 1–3 all succeeded (invariant C). A crash in
     * 4–6 leaves the device Unattached with an empty store: Join again.
     */
    async join(raw: ICouchClient, signal: AbortSignal, opts: ConfigJoinOptions = {}): Promise<void> {
        try {
            await this.runJoin(raw, signal, opts);
            this.lastStatus = { state: "ready", at: Date.now() };
        } catch (e) {
            this.recordFailure(e);
            throw e;
        }
    }

    private async runJoin(raw: ICouchClient, signal: AbortSignal, opts: ConfigJoinOptions): Promise<void> {
        const progress = opts.onProgress ?? (() => {});
        const s = this.host.getSettings();

        progress("Reading config:meta...");
        const meta = await fetchConfigMeta(raw);
        throwIfAborted(signal);
        if (!meta) throw await this.classifyMissingMeta(raw, signal);
        if (meta.schemaVersion !== 2) {
            throw configNotReady("legacy-meta", this.ctx({ schemaVersion: meta.schemaVersion }));
        }
        const metaFp = await configMetaFingerprint(meta);
        const codec = metaCodec(meta);

        // 2. Weaker than trusted?
        const weaker = this.weakerThanTrusted(meta);
        if (weaker) {
            const ok = await (opts.confirmWeaker?.(weaker.title, weaker.message) ?? Promise.resolve(false));
            throwIfAborted(signal);
            if (!ok) {
                const e = new Error("Join cancelled — nothing was changed.");
                e.name = "AbortError";
                throw e;
            }
        }

        // 3. Unlock.
        let crypto: CryptoProvider | null = null;
        let passphrase = resolveConfigCodec(s).passphrase;
        if (meta.encryption.enabled) {
            if (!passphrase) {
                passphrase = (await opts.promptPassphrase?.()) ?? "";
                throwIfAborted(signal);
                if (!passphrase) throw configNotReady("passphrase-missing", this.ctx());
            }
            progress("Unlocking config key...");
            crypto = await this.unlock(meta, metaFp, passphrase);
            throwIfAborted(signal);
            if (!crypto) throw configNotReady("passphrase-mismatch", this.ctx());
        }

        // 4. Local store.
        progress("Preparing the local config store...");
        await this.resetStore();
        throwIfAborted(signal);

        // 5. Settings entry.
        const floor = meta.encryption.enabled ? meta.encryption.cipherVersion : undefined;
        const prevFloor = this.entry()?.cipherFloor;
        if (prevFloor !== undefined && (floor === undefined || floor < prevFloor)) {
            logWarn(
                `CouchSync: Config Join re-anchors the cipher floor of "${this.dbName}" ` +
                `from ${prevFloor} to ${floor ?? "none (unencrypted)"} (the joined root's).`,
            );
        }
        await this.putEntry({
            ...(floor !== undefined ? { cipherFloor: floor } : {}),
            settingUp: false,
        }, meta.encryption.enabled ? passphrase : undefined);

        // 6. Commit.
        await this.writeAttachment({ codec, metaFingerprint: metaFp });
    }

    /** What makes `meta` weaker than what this device trusted for the DB,
     *  as a confirm dialog, or null. */
    private weakerThanTrusted(meta: ConfigMetaDoc): { title: string; message: string } | null {
        const floor = this.entry()?.cipherFloor;
        const wasEncrypted = this.att?.codec.encryption === true || floor !== undefined;
        const db = `"${this.dbName}"`;
        if (!meta.encryption.enabled && wasEncrypted) {
            return {
                title: `Join unencrypted config database ${db}?`,
                message:
                    `This device knew config database ${db} as encrypted, but its ` +
                    "config:meta is now unencrypted. Either it was re-created without " +
                    "encryption on another device, or the server was tampered with.\n\n" +
                    "Joining makes this device send and receive its config unencrypted " +
                    `(${describeCodec(metaCodec(meta))}). Join only if you verified the ` +
                    "server and the unencrypted database is intended.",
            };
        }
        if (meta.encryption.enabled && floor !== undefined
            && meta.encryption.cipherVersion < floor) {
            return {
                title: `Join config database ${db} with an older cipher?`,
                message:
                    `config:meta of ${db} declares cipherVersion ` +
                    `${meta.encryption.cipherVersion}, below the version ${floor} this ` +
                    "device already trusted for it — possible tampering.\n\n" +
                    "Joining lowers this device's floor for the database to the older " +
                    "version. Join only if you verified the server.",
            };
        }
        return null;
    }

    /** Create, before its destructive wipe: flag this binding as mid-setup
     *  (Invariant C, #err-9). Kept on the settings entry — it must survive
     *  the store being emptied — and blocks only THIS DB. */
    async beginCreate(): Promise<void> {
        await this.putEntry({ ...(this.entry() ?? {}), settingUp: true });
    }

    /**
     * Create succeeded (remote wiped, new root pushed). In ONE settings save
     * the entry gets the new root's floor and loses the setup flag, and —
     * encrypted root only — `passphrase` (the one Create encrypted with,
     * possibly inherited from the vault) becomes the explicit
     * `configEncryptionPassphrase`. Then the attachment (the root's codec
     * and fingerprint) is written into the emptied store — the commit point.
     * A crash between the two leaves the device Unattached on a complete
     * remote: Join (or Create again).
     */
    async commitCreate(
        meta: ConfigMetaDoc,
        crypto: CryptoProvider | null,
        passphrase: string,
    ): Promise<void> {
        const metaFp = await configMetaFingerprint(meta);
        await this.putEntry({
            ...(meta.encryption.enabled ? { cipherFloor: meta.encryption.cipherVersion } : {}),
            settingUp: false,
        }, meta.encryption.enabled ? passphrase : undefined);
        await this.writeAttachment({ codec: metaCodec(meta), metaFingerprint: metaFp });
        if (!this.closed && crypto) this.keyCache = { metaFp, passphrase, crypto };
        this.lastStatus = { state: "ready", at: Date.now() };
    }

    /** Record a Create failure for the status line. */
    noteFailure(e: unknown): void {
        this.recordFailure(e);
    }

    // ── Codec stack ────────────────────────────────────

    /**
     * Wrap a raw client for this config DB with the codec stack of `keys`
     * (an op's frozen keys, or an `inspect` verdict's), symmetric with
     * the vault's `wrapVaultClient` (#12): the attachment's codec decides
     * whether the encrypt layer is applied, not the provider's existence.
     * Fail-closed: encrypted + no key → `key-missing`, never a plaintext
     * client against an encrypted DB.
     *
     * The cipher floor is client-local state (the settings entry), never
     * the server-writable meta. Compose order is invariant 10:
     * `compress(encrypt(raw))`.
     */
    wrapClient(raw: ICouchClient, keys: ConfigOpKeys): ICouchClient {
        let client: ICouchClient = raw;
        if (keys.codec.encryption) {
            if (!keys.crypto) {
                throw configNotReady("key-missing", this.ctx());
            }
            client = new EncryptingCouchClient(client, keys.crypto, keys.cipherFloor);
        }
        if (keys.codec.compression) {
            client = new CompressingCouchClient(client);
        }
        return client;
    }
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        const e: any = new Error("The operation was aborted.");
        e.name = "AbortError";
        throw e;
    }
}
