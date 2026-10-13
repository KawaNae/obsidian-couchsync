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
 *     store — the cipher floor, the Create-interrupted flag and the
 *     passphrase that unlocks this DB.
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
 * Readiness is evaluated per op, never persisted as a state machine:
 * Disabled (no binding), Unattached (no attachment in the store),
 * SettingUp (the setup flag), Blocked (the op throws a
 * `ConfigNotReadyError`) or Ready. A persisted state could disagree with
 * the store and the server it summarises; re-evaluating cannot. What the
 * settings tab shows is `relation()`: the attachment, the setup flag, the
 * outcome of the last user operation and that of the last check (in memory
 * only). The key never depends on the
 * vault's connectionState (the config DB is its own crypto principal).
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
import {
    ConfigNotReadyError,
    configNotReady,
    type ConfigNotReadyContext,
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
import { OutcomeLedger, type OpOutcome } from "./op-outcome.ts";

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

/** The config operations whose outcome describes this device's relation
 *  to the config DB. `check` is the settings filter tree's read-only
 *  `inspect` + listing (no op lock); the others run under the lock. */
export type ConfigOpName = "push" | "pull" | "join" | "create" | "check";

/** How one operation on this binding ended. `against` is the
 *  `metaFingerprint` of the attachment the operation evaluated — for a
 *  locked op, the one in place when it ended (Join / Create replace it) —
 *  or null when the device was not attached. */
export type ConfigOutcome = OpOutcome<ConfigOpName>;

/** Snapshot of this device's relation to the config DB, for the status
 *  line. Not persisted: after a reload the last outcomes are unknown until
 *  the next operation or check. An outcome is given only when it was
 *  evaluated against the attachment in place now — a result about another
 *  root (or about not being joined) no longer describes the relation. */
export interface ConfigRelation {
    dbName: string;
    /** The participation record, or null when not joined. */
    attachment: ConfigAttachment | null;
    /** A Create of this device did not finish. */
    settingUp: boolean;
    /** The last Push, Pull, Join or Create. A check never replaces it: a
     *  check only reads, so its success says nothing about whether the
     *  write that failed would now succeed. */
    lastOp: ConfigOutcome | null;
    /** The last check (the filter tree's read-only inspect + listing). */
    lastCheck: ConfigOutcome | null;
}

/**
 * Everything an op encodes and decodes with, fixed for the op's whole run:
 * the codec from the attachment, the unlocked key, the cipher floor, and a
 * chunk hasher built from those two (HMAC under the key when the DB is
 * encrypted, xxhash64 otherwise — config and vault mint chunk ids in
 * disjoint spaces).
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

/** Why Join asks for the passphrase: no value to try, or none of the values
 *  it tried unlocks the DB. */
export type ConfigPassphraseReason = "missing" | "mismatch";

/**
 * Ask the user for the passphrase of the config DB being joined. The
 * prompt checks each answer with `tryUnlock` (true: it unlocks the root)
 * and stays open on a wrong one, so the user can correct it in place.
 * Resolves with the passphrase that unlocked, or null when the user
 * cancelled.
 */
export type AskConfigPassphrase = (
    reason: ConfigPassphraseReason,
    tryUnlock: (passphrase: string) => Promise<boolean>,
) => Promise<string | null>;

export interface ConfigJoinOptions {
    /** Asked when none of the passphrases at hand unlocks the DB. Omitted →
     *  the Join stops as `passphrase-missing` / `passphrase-mismatch`. */
    askPassphrase?: AskConfigPassphrase;
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
    private readonly outcomes = new OutcomeLedger<ConfigOpName>((op) => op === "check");

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
     *  schema stamp is checked here, before any content read, and the attachment read;
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
     *  shares its map with another (e.g. DEFAULT_SETTINGS) is never touched. */
    private async putEntry(rec: ConfigBindingRecord): Promise<void> {
        if (this.closed) return;
        const s = this.host.getSettings();
        s.configBindings = { ...(s.configBindings ?? {}), [this.key]: rec };
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

    /** Record how an operation ended. Called by the op runner (Push, Pull,
     *  Join, Create — not for a busy refusal or a cancellation) and by the
     *  filter tree's check. The rules are `OutcomeLedger`'s: a check reads
     *  and never writes, so its success does not clear a failed Push or
     *  Create; a successful operation read the server's `config:meta` with
     *  this device's key, so it clears a failed check. */
    record(o: ConfigOutcome): void {
        if (this.closed) return;
        this.outcomes.record(o);
    }

    /** This device's relation to the config DB now. */
    relation(): ConfigRelation {
        return {
            dbName: this.dbName,
            attachment: this.att,
            settingUp: this.entry()?.settingUp === true,
            ...this.outcomes.view(this.att?.metaFingerprint ?? null),
        };
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
     * already unlocked for the joined root with this binding's passphrase.
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
                && memo.passphrase === (this.entry()?.passphrase ?? "")) {
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
     *      passphrase is the one Create / Join saved on this binding's entry
     *      — never Step 1's or the vault's, so changing either after joining
     *      cannot stop config sync, and DBs with different passphrases keep
     *      their own
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
            const passphrase = this.entry()?.passphrase ?? "";
            if (!passphrase) throw configNotReady("passphrase-missing", this.ctx());
            crypto = await this.unlock(meta, metaFp, passphrase);
            throwIfAborted(signal);
            if (!crypto) throw configNotReady("passphrase-mismatch", this.ctx());
        }
        return { attachment: att, meta, crypto };
    }

    /**
     * Per-op readiness check for ops holding the op lock (Push, Pull):
     * `inspect`, then apply the verdict — ratchet the cipher floor (TOFU).
     * Returns the keys the op must use for its whole run.
     */
    async preflight(raw: ICouchClient, signal?: AbortSignal): Promise<ConfigOpKeys> {
        if (!this.closed) this.att = await this.readAttachment();
        const verdict = await this.inspect(raw, signal);
        const entry = this.entry();
        let floor = entry?.cipherFloor;
        const cv = verdict.meta.encryption.enabled
            ? verdict.meta.encryption.cipherVersion : undefined;
        if (cv !== undefined && cv > (floor ?? 0)) {
            floor = cv;
            await this.putEntry({ ...(entry ?? { settingUp: false }), cipherFloor: cv });
        }
        return makeConfigOpKeys(verdict.attachment.codec, verdict.crypto, floor, this.dbName);
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
     * the Step 1 settings — the DB's codec goes into the attachment, its
     * passphrase into this binding's entry.
     *
     *   1. read `config:meta` on the raw client and classify it
     *   2. a codec weaker than this device trusted for the DB (encryption
     *      removed, or a cipherVersion below the floor) needs the user's
     *      confirmation; cancelled → nothing changes
     *   3. encrypted root: unlock it (`unlockJoin`) — with a passphrase at
     *      hand, else with one the user enters; cancelled → nothing changes
     *   4. empty this binding's local store (cursors of any earlier root
     *      must not be reused) — Unattached from here until 6
     *   5. settings, in ONE save: the floor is SET to the root's (not
     *      ratcheted), the setup flag cleared, and — encrypted root only —
     *      the passphrase that unlocked it stored on this binding's entry.
     *      From here on every op on this DB unlocks with that value alone.
     *      A plaintext root stores no passphrase.
     *   6. commit: the attachment is written into the store
     *
     * Nothing is changed before 1–3 all succeeded. A crash in
     * 4–6 leaves the device Unattached with an empty store: Join again.
     */
    async join(raw: ICouchClient, signal: AbortSignal, opts: ConfigJoinOptions = {}): Promise<void> {
        const progress = opts.onProgress ?? (() => {});

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
            if (!ok) throw joinCancelled();
        }

        // 3. Unlock.
        let passphrase: string | undefined;
        if (meta.encryption.enabled) {
            progress("Unlocking config key...");
            passphrase = await this.unlockJoin(meta, metaFp, signal, opts.askPassphrase);
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
                `Config Join re-anchors the cipher floor of "${this.dbName}" ` +
                `from ${prevFloor} to ${floor ?? "none (unencrypted)"} (the joined root's).`,
            );
        }
        await this.putEntry({
            ...(floor !== undefined ? { cipherFloor: floor } : {}),
            settingUp: false,
            ...(passphrase !== undefined ? { passphrase } : {}),
        });

        // 6. Commit.
        await this.writeAttachment({ codec, metaFingerprint: metaFp });
    }

    /**
     * Find the passphrase that unlocks an encrypted root being joined.
     * First the values at hand, each tried once, in this order:
     *
     *   1. this binding's own passphrase (a re-Join of the same DB)
     *   2. the Step 1 passphrase (the value Create would encrypt with — on a
     *      device that joined before passphrases moved onto the binding, the
     *      value it synced with)
     *   3. the vault passphrase (config DBs often share it)
     *
     * at most three PBKDF2 derivations. When none unlocks, the user is asked
     * (`askPassphrase`), told whether none was set or none matched; the
     * prompt re-asks on a wrong answer. A cancelled prompt cancels the Join
     * with nothing changed.
     */
    private async unlockJoin(
        meta: ConfigMetaDoc,
        metaFp: string,
        signal: AbortSignal,
        ask: AskConfigPassphrase | undefined,
    ): Promise<string> {
        const s = this.host.getSettings();
        const candidates: string[] = [];
        for (const p of [this.entry()?.passphrase, s.configEncryptionPassphrase, s.encryptionPassphrase]) {
            if (p && !candidates.includes(p)) candidates.push(p);
        }
        for (const p of candidates) {
            const crypto = await this.unlock(meta, metaFp, p);
            throwIfAborted(signal);
            if (crypto) return p;
        }
        const reason: ConfigPassphraseReason = candidates.length === 0 ? "missing" : "mismatch";
        if (!ask) {
            throw configNotReady(
                reason === "missing" ? "passphrase-missing" : "passphrase-mismatch", this.ctx(),
            );
        }
        let unlockedWith: string | null = null;
        const answer = await ask(reason, async (p) => {
            if (!p || !(await this.unlock(meta, metaFp, p))) return false;
            unlockedWith = p;
            return true;
        });
        throwIfAborted(signal);
        if (answer === null || unlockedWith === null) throw joinCancelled();
        return unlockedWith;
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
     *  so an interrupted Create is never mistaken for a usable DB. Kept on the settings entry — it must survive
     *  the store being emptied — and blocks only THIS DB. */
    async beginCreate(): Promise<void> {
        await this.putEntry({ ...(this.entry() ?? {}), settingUp: true });
    }

    /**
     * Create succeeded (remote wiped, new root pushed). In ONE settings save
     * the entry gets the new root's floor and loses the setup flag, and —
     * encrypted root only — `passphrase` (the one Create encrypted with,
     * possibly inherited from the vault) becomes this binding's passphrase;
     * Step 1 is left as it is. Then the attachment (the root's codec and
     * fingerprint) is written into the emptied store — the commit point.
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
            ...(meta.encryption.enabled
                ? { cipherFloor: meta.encryption.cipherVersion, passphrase } : {}),
            settingUp: false,
        });
        await this.writeAttachment({ codec: metaCodec(meta), metaFingerprint: metaFp });
        if (!this.closed && crypto) this.keyCache = { metaFp, passphrase, crypto };
    }

    // ── Codec stack ────────────────────────────────────

    /**
     * Wrap a raw client for this config DB with the codec stack of `keys`
     * (an op's frozen keys, or an `inspect` verdict's), symmetric with
     * the vault's `wrapVaultClient`: the attachment's codec decides
     * whether the encrypt layer is applied, not the provider's existence.
     * Fail-closed: encrypted + no key → `key-missing`, never a plaintext
     * client against an encrypted DB.
     *
     * The cipher floor is client-local state (the settings entry), never
     * the server-writable meta. Compose order is
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

/** The user declined a confirmation or a passphrase prompt of Join. A
 *  cancellation (`AbortError`): it is not recorded as an outcome, and the
 *  notice reads "Config Join cancelled — nothing was changed." */
function joinCancelled(): Error {
    const e: any = new Error("Join cancelled — nothing was changed.");
    e.name = "AbortError";
    e.userMessage = "nothing was changed.";
    return e;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        const e: any = new Error("The operation was aborted.");
        e.name = "AbortError";
        throw e;
    }
}
