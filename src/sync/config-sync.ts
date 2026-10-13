import type { IVaultIO } from "../types/vault-io.ts";
import type { IModalPresenter } from "../types/modal-presenter.ts";
import type { ConfigLocalDB } from "../db/config-local-db.ts";
import {
    ConfigBinding,
    defaultConfigStoreFactory,
    makeConfigOpKeys,
    type ConfigOpKeys,
    type ConfigOpName,
    type AskConfigPassphrase,
    type ConfigStoreFactory,
} from "./config-binding.ts";
import { configBindingKey } from "./config-binding-record.ts";
import type { AuthGate } from "../db/sync/auth-gate.ts";
import type { VisibilityGate } from "../db/visibility-gate.ts";
import type { ConfigDoc, CouchSyncDoc, ChunkDoc } from "../types.ts";
import { CONFIG_SCHEMA_VERSION } from "../types.ts";
import {
    DOC_ID,
    makeConfigId,
    configPathFromId,
} from "../types/doc-id.ts";
import type { CouchSyncSettings } from "../settings.ts";
import { ProgressNotice } from "../ui/notices.ts";
import {
    splitIntoChunks,
    joinChunks,
    MAX_CHUNK_BYTES_CONFIG,
    type ChunkHasher,
} from "../db/chunker.ts";
import { incrementVC } from "./vector-clock.ts";
import { chunkListsEqual } from "./chunk-equality.ts";
import type { ICouchClient } from "../db/interfaces.ts";
import { makeCouchClient } from "../db/couch-client.ts";
import { logError, logWarn } from "../ui/log.ts";
import { describeError } from "../ui/describe-error.ts";
import { unsafeVaultPathReason } from "../utils/path.ts";
import { classifyConfigPath } from "./config-policy/classify.ts";
import {
    sendDecision,
    receiveDecision,
    type ReceiveContext,
} from "./config-policy/policy.ts";
import { readLocalIsDesktopOnly } from "./config-policy/manifest.ts";
import * as remoteCouch from "../db/remote-couch.ts";
import {
    ConfigOperation,
    CONFIG_TIMEOUTS,
    type ConfigOpContext,
} from "./config-operation.ts";
import type { ReconnectBridge } from "./reconnect-bridge.ts";
import { configLastSyncedKey } from "../db/sync/config-last-synced.ts";
import {
    ConfigPullWriter,
    type ConfigConcurrentEntry,
} from "../db/sync/config-pull-writer.ts";
import {
    ConfigPushPipeline,
    type ConfigPushDivergence,
} from "../db/sync/config-push-pipeline.ts";
import { ConflictResolver } from "../conflict/conflict-resolver.ts";
import { ConfigSetupService } from "./config-setup.ts";
import type { ConfigCreatePreview } from "./config-create-preview.ts";
import { fetchConfigMeta } from "../db/vault-meta.ts";
import { classifyError } from "../db/sync/errors.ts";
import { resolveConfigCodec } from "./config-codec-policy.ts";
import { configNotReady } from "./config-errors.ts";

/**
 * ConfigSync — scan-based replication of `.obsidian/` configuration files
 * against a SEPARATE CouchDB database from the vault (v0.11.0+).
 *
 * Why separate? Because vault content is shared across all peer devices,
 * but `.obsidian/` may legitimately differ between device pools (mobile
 * vs desktop). Putting them in the same DB would conflate "vault edit"
 * concurrency with "device-pool config drift" — different problems with
 * different resolution policies.
 *
 * Architecturally:
 *   - Local storage: `ConfigLocalDB` (Dexie-backed IndexedDB store)
 *   - Remote storage: `settings.couchdbConfigDbName` on the same CouchDB
 *     server as the vault DB (auth shared via a common `AuthGate`)
 *   - Replication: every public op runs inside a `ConfigOperation` epoch
 *     that owns an AbortController, runs a 15s reachability probe, and
 *     waits for visibility=visible before fetching. Vault sync's session
 *     lifecycle disciplines the live loops; ConfigOperation is the same
 *     discipline for one-shot user-triggered ops.
 *   - Ordering: every write increments the device's `vclock` counter,
 *     same VC discipline as FileDoc — concurrent edits are detected
 *     and surfaced rather than silently LWW-merged.
 */
function defaultClientFactory(settings: CouchSyncSettings): ICouchClient | null {
    if (!settings.couchdbConfigDbName) return null;
    return makeCouchClient(
        settings.couchdbUri,
        settings.couchdbConfigDbName,
        settings.couchdbUser,
        settings.couchdbPassword,
    );
}

/** Optional ConfigSync wiring. Production sets `ownDataJsonPath` and the
 *  persistence hooks; tests inject `storeFactory` / `rawClientFactory` /
 *  `clientFactory` fakes. Bundled into one object so call sites name what
 *  they pass.
 *
 *  Every client factory receives the settings with `couchdbUri` and
 *  `couchdbConfigDbName` replaced by the CURRENT BINDING's server and DB
 *  name — the binding, not the live settings, decides which remote an op
 *  talks to, so the store, cursors and key always belong to the remote
 *  being read or written. */
export interface ConfigSyncOptions {
    /** Builds the local store with a given IndexedDB name (derived from
     *  vault + server + config DB, `configStoreName`). Tests inject their
     *  own; production uses `defaultConfigStoreFactory`. */
    storeFactory?: ConfigStoreFactory;
    /** RAW (un-wrapped) client factory. Production uses `makeCouchClient`.
     *  Every op probes and preflights on it; wrapped clients are built as
     *  `binding.wrapClient(raw)`; Create's DB-level ops, Join and the
     *  never-encrypted `config:meta` use it as-is. */
    rawClientFactory?: (settings: CouchSyncSettings) => ICouchClient | null;
    /** Test seam: a pre-wrapped client factory that REPLACES
     *  `binding.wrapClient(raw, keys)` after the preflight. Production never
     *  sets it. */
    clientFactory?: (settings: CouchSyncSettings) => ICouchClient | null;
    /** The plugin's real own-data.json path (host passes `manifest.dir` +
     *  "/data.json"); excluded from replication. Falls back to the
     *  default-folder literal when omitted. */
    ownDataJsonPath?: string;
    /** Persist settings. Bindings write their settings entry
     *  (`settings.configBindings`: cipher floor, setup flag, the DB's
     *  passphrase) into the live settings object, then call this. Omitted
     *  in tests (in-memory only). */
    saveSettings?: () => Promise<void>;
    /** Ask the user for the config passphrase when none of the values at
     *  hand unlocks the DB being joined. Production opens the
     *  PassphraseModal, which re-asks on a wrong answer. Omitted → Join
     *  stops with `passphrase-missing` / `passphrase-mismatch`. */
    askPassphrase?: AskConfigPassphrase;
    /** Is this device mobile? Drives the receive-side desktop-only gate
     *  (`write`). Production passes `() => Platform.isMobile`; tests inject a
     *  fake. Omitted → treated as desktop (gate never fires). */
    getIsMobile?: () => boolean;
}

/** Result of the filter tree's best-effort remote listing. `ok` is false
 *  when the server was not listed (failed, not joined, or an op running);
 *  `paths` is then empty. Why is the status line's business — a failed
 *  check is recorded on the binding. `bindingKey` is the binding the listing
 *  was read for (null: none) — the listing runs outside the op lock, so a
 *  caller compares it with the current binding and drops a listing that
 *  belongs to a replaced one. */
export interface RemoteConfigListing {
    paths: string[];
    ok: boolean;
    bindingKey: string | null;
}

/** Options of `ConfigSync.rebind`. */
export interface ConfigRebindOptions {
    /** Server the new binding is opened for. Default: the live settings'
     *  `couchdbUri` (Apply of a DB name, onload). The CouchDB tab passes the
     *  server it is about to save. */
    serverUri?: string;
    /** Persist the settings that name the new binding (DB name / server).
     *  Runs under the rebind lock right after the switch — also when
     *  opening the new store failed (the device is then unbound under the
     *  new settings) — and NOT at all when the rebind is refused as busy.
     *  See the invariant on `ConfigSync.rebind`. */
    commit?: () => Promise<void>;
}

/** Config ops that run under the op lock (everything but the filter
 *  tree's check). */
type LockedConfigOp = Exclude<ConfigOpName, "check">;

const OP_LABELS: Record<LockedConfigOp, string> = {
    push: "Config Push",
    pull: "Config Pull",
    join: "Config Join",
    create: "Config Create",
};

export class ConfigSync {
    private static readonly SKIP_DIRS = new Set(["node_modules", ".git"]);
    private static readonly SKIP_FILES = new Set(["workspace.json", "workspace-mobile.json"]);
    /** Fallback own-data.json path, used only when the host does not supply
     *  the real install path. Fragile (assumes the default folder name) — see
     *  `skipPaths`, which prefers the manifest-derived path. */
    private static readonly DEFAULT_OWN_DATA_PATH =
        ".obsidian/plugins/obsidian-couchsync/data.json";

    /** Paths excluded from config replication. The plugin's OWN data.json
     *  carries the deviceId AND the plaintext CouchDB password / encryption
     *  passphrase, so it must NEVER be pushed to the (untrusted) config server.
     *  Derived from the real install path the host passes in (`manifest.dir`),
     *  not a hardcoded folder name — a BRAT / manually-renamed plugin folder
     *  still gets its data.json excluded. */
    private readonly skipPaths: Set<string>;
    private static readonly MAX_CONFIG_SIZE = 5 * 1024 * 1024; // 5MB

    /** In-flight op (a ConfigOperation, or a local `runExclusive` task),
     *  or null. Concurrent ops are rejected. */
    private inflight: { cancel(): void } | null = null;

    /** The config DB this device is pointed at, with its store, cursors,
     *  lastSynced cache and key memo. Null = config sync disabled (or the
     *  last rebind failed to open the store). Replaced only by `rebind`
     *  (and `close`); see the invariant on `rebind`. */
    private binding: ConfigBinding | null = null;

    /** Pending `rebind`, or null. Ops and a second rebind are refused while
     *  a switch is closing / opening stores. */
    private rebinding: Promise<void> | null = null;

    private readonly storeFactory: ConfigStoreFactory;

    /** RAW config-DB client factory (no codec wrapping). */
    private readonly rawClientFactory: (settings: CouchSyncSettings) => ICouchClient | null;

    /** Test seam replacing `binding.wrapClient(raw)`; see ConfigSyncOptions. */
    private readonly clientFactory?: (settings: CouchSyncSettings) => ICouchClient | null;

    /** vclock-based pull-time conflict classifier. Stateless; one
     *  shared instance is enough. Same class as vault sync. */
    private readonly conflictResolver: ConflictResolver;
    private readonly saveSettings: () => Promise<void>;
    private readonly askPassphrase?: AskConfigPassphrase;
    private readonly getIsMobile: () => boolean;

    constructor(
        private vault: IVaultIO,
        private modal: IModalPresenter,
        /** Obsidian vault name — half of the local store's identity. */
        private readonly vaultName: string,
        private auth: AuthGate,
        private visibility: VisibilityGate,
        private reconnectBridge: ReconnectBridge,
        private getSettings: () => CouchSyncSettings,
        // Optional wiring is bundled into one options object rather than a long
        // positional tail — the latter was easy to mis-order, since only
        // tests ever supplied most of these and a slot could be silently skipped.
        opts: ConfigSyncOptions = {},
    ) {
        this.storeFactory = opts.storeFactory ?? defaultConfigStoreFactory;
        this.rawClientFactory = opts.rawClientFactory ?? defaultClientFactory;
        this.clientFactory = opts.clientFactory;
        this.conflictResolver = new ConflictResolver();
        this.saveSettings = opts.saveSettings ?? (async () => {});
        this.askPassphrase = opts.askPassphrase;
        this.getIsMobile = opts.getIsMobile ?? (() => false);
        this.skipPaths = new Set([opts.ownDataJsonPath ?? ConfigSync.DEFAULT_OWN_DATA_PATH]);
    }

    // ── Binding lifecycle ──────────────────────────────

    /**
     * Point config sync at `dbName` (null / "" = disable) on `opts.serverUri`
     * (default: the live settings' server). The binding is (server, DB) —
     * `configBindingKey`. Closes the current binding — its store, cursors,
     * lastSynced cache and key memo — and opens the one for the new key, so
     * nothing cached for one config DB is ever used against another. The old
     * store stays on disk; switching back re-opens it with its cursors and
     * attachment intact. Re-binding to the current key keeps the binding.
     *
     * INVARIANT (settings ⇔ binding): whenever no rebind is running,
     * `binding` is either null or
     * `binding.key === configBindingKey(settings.couchdbUri,
     * settings.couchdbConfigDbName)`. Null with a DB name set means opening
     * that store failed (ops report it). It holds by construction:
     *   - the two settings change ONLY through this method's `opts.commit`
     *     (the Config Sync tab's Apply, the CouchDB tab's Apply) or at
     *     onload before the first rebind — no caller writes them itself;
     *   - `commit` runs inside the rebind lock, right after the switch, so
     *     no op can start between the binding change and the settings
     *     change (ops and rebinds are refused while `rebinding` is set);
     *   - a rebind refused as `busy` (an op or another rebind running) runs
     *     no `commit`: settings and binding both stay as they were. The tabs
     *     also disable Apply while `bindingChangeBlocker()` says so.
     * Because of it, the paths that read the binding WITHOUT the op lock
     * (Create's confirm preview, the filter tree listing, Maintenance) see
     * the binding the settings name, and an op never has to re-align.
     *
     * If opening the new store fails the device is left unbound (never on
     * the old binding), `commit` still runs, and the error propagates.
     */
    async rebind(dbName: string | null, opts: ConfigRebindOptions = {}): Promise<void> {
        const blocked = this.bindingChangeBlocker();
        if (blocked) throw configNotReady("busy");
        const serverUri = opts.serverUri ?? this.getSettings().couchdbUri;
        const target = dbName || null;
        const run = (async () => {
            const same = target
                ? this.binding?.key === configBindingKey(serverUri, target)
                : this.binding === null;
            let openError: unknown = null;
            if (!same) {
                try {
                    await this.switchBinding(serverUri, target);
                } catch (e) {
                    openError = e;
                }
            }
            await opts.commit?.();
            if (openError) throw openError;
        })();
        this.rebinding = run;
        try {
            await run;
        } finally {
            this.rebinding = null;
        }
    }

    /** Why the binding cannot be changed right now (an op or a rebind is
     *  running), or null. The settings tabs disable their Apply with this
     *  text; `rebind` refuses as `busy` under the same condition. */
    bindingChangeBlocker(): string | null {
        if (this.inflight !== null || this.rebinding !== null) {
            return "A config operation is running — Apply is available when it finishes.";
        }
        return null;
    }

    private async switchBinding(serverUri: string, target: string | null): Promise<void> {
        const old = this.binding;
        this.binding = null;
        if (old) {
            try {
                await old.close();
            } catch (e: any) {
                logError(`failed to close config store "${old.dbName}": ${e?.message ?? e}`);
            }
        }
        if (target) {
            this.binding = await ConfigBinding.open(
                this.vaultName,
                serverUri,
                target,
                { getSettings: this.getSettings, saveSettings: () => this.saveSettings() },
                this.storeFactory,
            );
        }
    }

    /** Plugin unload: cancel any running op and close the binding without
     *  the busy check (nothing may outlive the plugin). */
    async close(): Promise<void> {
        this.cancelCurrent();
        const old = this.binding;
        this.binding = null;
        await old?.close();
    }

    /** The current binding, or null when config sync is disabled. */
    currentBinding(): ConfigBinding | null {
        return this.binding;
    }

    /** The current binding's local store, or null. Read it at use time —
     *  never hold on to it across a rebind. */
    currentStore(): ConfigLocalDB | null {
        return this.binding?.store ?? null;
    }

    // ── Remote URL + auth helpers ──────────────────────

    /** Settings as seen by the client factories: the live settings (with
     *  their credentials), with the server and DB name pinned to the
     *  binding's. */
    private settingsFor(binding: ConfigBinding): CouchSyncSettings {
        return {
            ...this.getSettings(),
            couchdbUri: binding.serverUri,
            couchdbConfigDbName: binding.dbName,
        };
    }

    /** Codec-wrapped client over `raw` for `binding`, with `keys` — the
     *  keys an op's preflight froze (or an `inspect` verdict's). */
    private wrapFor(binding: ConfigBinding, raw: ICouchClient, keys: ConfigOpKeys): ICouchClient {
        if (this.clientFactory) {
            const c = this.clientFactory(this.settingsFor(binding));
            if (!c) throw configNotReady("not-configured");
            return c;
        }
        return binding.wrapClient(raw, keys);
    }

    /** Raw (un-wrapped) client for the bound DB: every op's probe and
     *  preflight, Create's DB-level ops and `config:meta` push, and Join.
     *  The raw client never needs the key, so the FIRST encrypted Create
     *  works (#config-init). */
    private makeRawClient(binding: ConfigBinding): ICouchClient | null {
        return this.rawClientFactory(this.settingsFor(binding));
    }

    // ── Operation runner ───────────────────────────────

    /**
     * Run a config operation inside a ProgressNotice and a ConfigOperation
     * epoch. Order is fixed so NO failure escapes unreported:
     *
     *   1. ProgressNotice — created first, before any check can throw.
     *   2. Busy check (another op in flight); the op lock is taken.
     *   3. The binding (it always matches the settings — see `rebind`) and
     *      the caller's synchronous `gate` (e.g. Push's device name).
     *   4. ConfigOperation — auth, visibility, raw client, reachability
     *      probe, then (Push, Pull) the binding's preflight, which freezes
     *      the op's keys, and the codec wrap with them, then the body.
     *
     * The catch below is the one exit of a config op's failure: it records
     * the outcome on the binding (the status line reads it) and hands the
     * error to `progress.fail`, which words it (`describeError`), shows and
     * logs it. The error is rethrown, so the settings tab's catch only has
     * to restore its button. A success is recorded too. Neither a busy
     * refusal (nothing ran) nor a cancellation (the user chose it) is an
     * outcome of the relation, so neither is recorded.
     *
     * Per op:
     *   - push / pull: preflight + wrapped client; the body gets the frozen
     *     keys (its chunk hasher included)
     *   - join: raw client, no preflight — Join is what attaches
     *   - create: raw client, no preflight, a missing DB is fine
     */
    private async runOperation<T>(
        opName: LockedConfigOp,
        body: (
            ctx: ConfigOpContext,
            progress: ProgressNotice,
            binding: ConfigBinding,
            keys: ConfigOpKeys | undefined,
        ) => Promise<T>,
        opts: { gate?: (binding: ConfigBinding) => void } = {},
    ): Promise<T> {
        const progress = new ProgressNotice(OP_LABELS[opName]);
        if (this.inflight !== null || this.rebinding !== null) {
            // Nothing was started — the running op (if any) keeps its lock.
            const e = configNotReady("busy");
            progress.fail(e);
            throw e;
        }
        const at = Date.now();
        let op: ConfigOperation | null = null;
        let cancelled = false;
        let binding: ConfigBinding | null = null;
        this.inflight = { cancel: () => { cancelled = true; op?.cancel(); } };
        try {
            const b = this.requireBinding();
            binding = b;
            opts.gate?.(b);
            if (cancelled) throw abortError();
            let keys: ConfigOpKeys | undefined;
            const sync = opName === "push" || opName === "pull";
            op = new ConfigOperation({
                auth: this.auth,
                visibility: this.visibility,
                reconnectBridge: this.reconnectBridge,
                makeClient: () => this.makeRawClient(b),
                prepare: sync
                    ? async (raw, signal) => {
                        keys = await b.preflight(raw, signal);
                        return this.wrapFor(b, raw, keys);
                    }
                    : undefined,
                allowMissingDb: opName === "create",
                dbName: b.dbName,
            });
            const result = await op.run((ctx) => body(ctx, progress, b, keys));
            b.record({ op: opName, at, against: b.attachment?.metaFingerprint ?? null, error: null });
            return result;
        } catch (e) {
            if (binding && !describeError(e).cancelled) {
                binding.record({
                    op: opName, at, against: binding.attachment?.metaFingerprint ?? null, error: e,
                });
            }
            progress.fail(e);
            throw e;
        } finally {
            this.inflight = null;
        }
    }

    /**
     * Run local-only work on the current binding's store under the op lock
     * (Maintenance "Delete local config database", the config GC command),
     * so it never runs under a live Push / Pull / Join / Create and a
     * rebind cannot close the store mid-way. Throws `busy` / `not-configured`
     * without running `fn`; the caller reports.
     */
    async runExclusive<T>(fn: (binding: ConfigBinding) => Promise<T>): Promise<T> {
        if (this.inflight !== null || this.rebinding !== null) {
            throw configNotReady("busy");
        }
        const binding = this.requireBinding();
        this.inflight = { cancel: () => {} };
        try {
            return await fn(binding);
        } finally {
            this.inflight = null;
        }
    }

    /** Cancel the in-flight op (if any). Idempotent / noop when idle. */
    cancelCurrent(): void {
        this.inflight?.cancel();
    }

    /** True iff an op is currently running. UI uses this to disable buttons. */
    isInflight(): boolean {
        return this.inflight !== null;
    }

    // ── High-level operations ──────────────────────────

    /**
     * Create (formerly Config Init): a real clean slate with a new root.
     *
     * Destroys and re-creates the remote config DB, empties this binding's
     * local store, and pins a fresh SELF-CONTAINED `config:meta` (new generation id, fresh salt
     * + own keyCheck, so it is the DB's own crypto root) built from the current settings' codec.
     * On success this device is joined (its record names the new root) and
     * the passphrase Create encrypted with is saved on the binding's entry
     * (`ConfigBinding.commitCreate`). Structural only: the user's next Push
     * seeds the content. Every other device must Join again.
     *
     * The codec and passphrase are the Step 1 settings (Step 1 is defined as
     * the input of the next Create; an empty passphrase inherits the
     * vault's); the new root's codec becomes the attachment every later
     * Push / Pull uses. Encryption on with no passphrase at all stops as
     * `create-passphrase-missing` before anything is destroyed.
     */
    async create(): Promise<void> {
        return this.runOperation("create", async (ctx, progress, binding) => {
            const codec = resolveConfigCodec(this.getSettings());
            if (codec.encryption && !codec.passphrase) {
                throw configNotReady("create-passphrase-missing", { db: binding.dbName });
            }
            const setup = new ConfigSetupService(
                () => this.settingsFor(binding),
                {
                    beginSetup: () => binding.beginCreate(),
                    resetLocal: () => binding.resetStore(),
                    makeRawConfigClient: () => {
                        const c = this.makeRawClient(binding);
                        if (!c) throw new Error("ConfigSync: raw client factory returned null");
                        return c;
                    },
                    commit: (meta, crypto) => binding.commitCreate(meta, crypto, codec.passphrase),
                },
            );
            await setup.create(
                ctx.client,
                ctx.signal,
                (msg) => progress.update(msg),
                codec,
            );
            progress.done(
                "Config DB created. Now run Push to send this device's config. " +
                "Other devices must Join again.",
            );
        });
    }

    /**
     * What Create would delete, for its confirm dialog: the remote doc
     * count and whether `config:meta` is there (with its codec). Read on
     * the raw client (no key needed), outside the op lock and without a
     * ProgressNotice — it is a read-only look before the user decides. Never
     * throws: a server that cannot be read is reported as `unreadable` (and
     * logged), so the dialog says so instead of guessing a count.
     *
     * `bindingKey` names the binding it read. The caller starts Create only
     * if that is still the current binding, in the same tick as the check
     * (`create()` takes the op lock synchronously), so the dialog can never
     * describe one DB while Create wipes another.
     */
    async previewCreate(): Promise<ConfigCreatePreview> {
        const binding = this.binding;
        if (!binding) {
            return {
                kind: "unreadable", message: "Config sync is not active on this device.",
                bindingKey: null,
            };
        }
        const bindingKey = binding.key;
        try {
            const raw = this.makeRawClient(binding);
            if (!raw) {
                return {
                    kind: "unreadable", message: configNotReady("not-configured").message, bindingKey,
                };
            }
            const quick = raw.withTimeout(CONFIG_TIMEOUTS.reachability);
            let docCount: number;
            try {
                docCount = (await quick.info()).doc_count ?? 0;
            } catch (e) {
                if (classifyError(e).kind === "not-found") return { kind: "missing", bindingKey };
                throw e;
            }
            const meta = await fetchConfigMeta(quick);
            if (!meta) return { kind: "read", docCount, meta: "absent", bindingKey };
            if (meta.schemaVersion !== 2) {
                return { kind: "read", docCount, meta: "legacy", bindingKey };
            }
            return {
                kind: "read", docCount, meta: "present", bindingKey,
                codec: {
                    encryption: meta.encryption.enabled,
                    compression: meta.compression.enabled,
                    ...(meta.encryption.enabled
                        ? { cipherVersion: meta.encryption.cipherVersion } : {}),
                },
            };
        } catch (e: any) {
            const text = describeError(e).text;
            logWarn(
                `reading config database "${binding.dbName}" before Create ` +
                `failed: ${text}`,
            );
            return { kind: "unreadable", message: text, bindingKey };
        }
    }

    /**
     * Join: accept the bound config DB's existing root and attach this
     * device (see `ConfigBinding.join`). Never writes to the server, touches
     * no config file and leaves the Step 1 codec settings alone; the data
     * arrives with the next Pull. Asks for the passphrase through
     * `askPassphrase` when none at hand unlocks the DB, and for a
     * confirmation before adopting a codec weaker than this device trusted
     * for the DB.
     */
    async join(): Promise<void> {
        return this.runOperation("join", async (ctx, progress, binding) => {
            await binding.join(ctx.client, ctx.signal, {
                askPassphrase: this.askPassphrase,
                confirmWeaker: (title, message) =>
                    this.modal.showConfirmModal(title, message, "Join anyway", true),
                onProgress: (msg) => progress.update(msg),
            });
            progress.done(`Joined config database "${binding.dbName}". Run Pull to receive its config.`);
        });
    }

    /** Push: scan .obsidian/ → enumerate local delta via changes feed →
     *  per-doc remote-rev fetch → bulkDocs.
     *
     *  Replaces the snapshot-style push (full `fetchRemoteConfigDocs` +
     *  `pushDocs` by id list). Divergence is
     *  detected per pair via `compareVC`; on hit, the modal asks for
     *  confirm-and-overwrite (matches the prior UX). Confirmed → bump
     *  local vclocks above remote and re-run the pipeline. */
    async push(): Promise<number> {
        return this.runOperation("push", async (ctx, progress, binding, keys) => {
            await binding.ensureCheckpointsLoaded();

            // Chunk ids are minted with the op's frozen hasher: the same key
            // space the wrapped client encrypts under, for the whole run.
            const scanned = await this.scanWith(binding, keys!.hasher, (path, i, total) => {
                progress.update(`Scanning: ${path} (${i}/${total})`);
            });

            const pipeline = new ConfigPushPipeline({
                db: binding.store,
                client: ctx.client,
                checkpoints: binding.checkpoints,
                getDeviceId: () => this.getSettings().deviceId,
                signal: ctx.signal,
            });

            let result = await pipeline.run((msg) => progress.update(msg));

            if (result.divergent.length > 0) {
                const ok = await this.confirmPushDivergence(result.divergent);
                if (!ok) {
                    throw abortError(
                        "the divergent doc(s) were not overwritten; the others were pushed.",
                    );
                }
                progress.update("Resolving divergence (advancing vclocks)...");
                await pipeline.forcePushAdvanceVclocks(result.divergent);
                result = await pipeline.run((msg) => progress.update(msg));
            }

            const summaryParts: string[] = [];
            if (result.stats.pushed) summaryParts.push(`${result.stats.pushed} pushed`);
            if (result.stats.skipped) summaryParts.push(`${result.stats.skipped} skipped`);
            if (result.stats.conflicts) summaryParts.push(`${result.stats.conflicts} conflicts (will retry)`);
            const summary = summaryParts.length > 0 ? summaryParts.join(", ") : "no changes";
            progress.done(`${summary}. (Scanned ${scanned} local file(s).)`);
            return result.stats.pushed;
        }, {
            // Push advances vclocks under this device's name.
            gate: (binding) => {
                if (!this.getSettings().deviceId) {
                    throw configNotReady("device-id-missing", { db: binding.dbName });
                }
            },
        });
    }

    /** Pull: incremental `_changes`-based delta + write the policy-selected config to filesystem.
     *
     *  Replaces the snapshot-style pullByPrefix.
     *  Concurrent edits are surfaced AFTER the batch commit (informational),
     *  not pre-flight — the resolver classifies them as keep-local equivalents
     *  and the cursor advances past them, so re-running pull() will surface
     *  them again until manually resolved (matches vault-sync semantics).
     *  Returns the number of files written; 0 means the disk already
     *  matched and there is nothing to reload. */
    async pull(): Promise<number> {
        return this.runOperation("pull", async (ctx, progress, binding, keys) => {
            await binding.ensureCheckpointsLoaded();

            const writer = new ConfigPullWriter({
                db: binding.store,
                client: ctx.client,
                checkpoints: binding.checkpoints,
                lastSynced: binding.lastSynced,
                getConflictResolver: () => this.conflictResolver,
                signal: ctx.signal,
                hasher: keys!.hasher,
            });
            // A remote ConfigDoc shape this build cannot read throws
            // SchemaVersionMismatchError, whose `userMessage` names the
            // migration (Create, then Join on the other devices); it reaches
            // progress.fail as is.
            const result = await writer.run((msg) => progress.update(msg));

            if (result.concurrent.length > 0) {
                this.notifyConcurrentPull(result.concurrent);
            }

            progress.update("Writing config files...");
            const written = await this.write((path, i, total) => {
                progress.update(`Writing: ${path} (${i}/${total})`);
            });

            const summaryParts: string[] = [];
            if (result.stats.accepted) summaryParts.push(`${result.stats.accepted} accepted`);
            if (result.stats.deleted) summaryParts.push(`${result.stats.deleted} deleted`);
            if (result.stats.convergedSkip) summaryParts.push(`${result.stats.convergedSkip} converged`);
            if (result.stats.concurrent) summaryParts.push(`${result.stats.concurrent} concurrent`);
            const summary = summaryParts.length > 0 ? summaryParts.join(", ") : "no changes";
            progress.done(written > 0
                ? `${summary}. Wrote ${written} file(s). Reload Obsidian to apply.`
                : `${summary}. Files up to date.`);
            return written;
        });
    }

    /**
     * Surface concurrent-edit findings collected during a diff pull.
     * Pull is already committed by the time this runs — concurrent docs
     * were filtered out of `accepted` by the resolver, so the only effect
     * here is informational. Logs the full list and shows a single-button
     * notice modal so the user can investigate without blocking the op.
     *
     * Re-running pull() will re-classify the same docs as concurrent
     * until the local copy is causally advanced (i.e., the user edits
     * the file or accepts a manual resolve), matching the vault-sync
     * conflict-orchestrator UX.
     */
    private notifyConcurrentPull(entries: ConfigConcurrentEntry[]): void {
        const paths = entries.map((e) => `  • ${e.path}`).join("\n");
        logWarn(
            `Config pull surfaced ${entries.length} concurrent edit(s):\n${paths}`,
        );
        const previewLimit = 5;
        const preview = entries.slice(0, previewLimit).map((e) => e.path).join(", ");
        const more = entries.length > previewLimit ? ` (+${entries.length - previewLimit} more)` : "";
        // Fire-and-forget: this is informational, the op already completed.
        // Observe rejection so a modal-presentation failure lands in the log
        // instead of an unhandled promise rejection.
        this.modal.showConfirmModal(
            `Config pull: ${entries.length} concurrent edit(s) detected`,
            `Local copies of ${preview}${more} have diverged from remote. ` +
            `See the Log View for the full list. ` +
            `To keep this device's copy, edit the file here and Push (confirm the overwrite).`,
            "OK",
            false,
        ).catch((e) => logWarn(`config concurrent-pull notice failed: ${e?.message ?? e}`));
    }

    /**
     * Push-side confirm for divergent local↔remote vclock pairs.
     * Returns true on "push anyway", false on cancel.
     *
     * "Push anyway" means: bump each divergent doc's local vclock to
     * dominate remote (mergeVC + bump), then retry the push pipeline.
     * Peers will see the new revision as a normal `dominated` update,
     * not a conflict — same end-state as the legacy snapshot push, but
     * without the rev-tree inflation.
     */
    private async confirmPushDivergence(
        divergent: ConfigPushDivergence[],
    ): Promise<boolean> {
        const paths = divergent
            .map((d) => `  • ${d.path} (${d.relation})`).join("\n");
        logWarn(
            `Config push would overwrite ${divergent.length} divergent doc(s):\n${paths}`,
        );
        const previewLimit = 5;
        const preview = divergent.slice(0, previewLimit)
            .map((d) => d.path).join(", ");
        const more = divergent.length > previewLimit
            ? ` (+${divergent.length - previewLimit} more)` : "";
        const message =
            `Pushing would overwrite remote for ${divergent.length} doc(s) ` +
            `with concurrent / outdated edits: ${preview}${more}. ` +
            `See the Log View for the full list. Continue anyway?`;
        return await this.modal.showConfirmModal(
            `Config push: ${divergent.length} divergent doc(s)`,
            message,
            "Push anyway",
            true,
        );
    }

    // ── Low-level operations ───────────────────────────

    /** Scan entire .obsidian/ directory to local DB.
     *
     *  Short-circuit: if the per-path lastSynced cache reports a matching
     *  `{size, chunks}`, skip the rewrite entirely. v0.26 symmetric to
     *  VaultSync.fileToDb's `chunksEqual` early-out — without it every
     *  scan rev-bumps every config doc, which inflates the remote rev
     *  tree and produces phantom divergence for peers.
     *  Chunk-list comparison is O(N) over chunk ids; the full payload
     *  is never re-encoded for the equality check.
     *
     *  v0.26 chunking: each config file is split into ChunkDocs via
     *  `splitIntoChunks` (256 KiB chunks). The ConfigDoc carries only
     *  `chunks: string[]`; chunk bodies live as separate docs with
     *  envelope-formatted attachment "c" (gzip + encrypt transparently
     *  applied by the wrapped client). */
    async scan(onProgress?: (path: string, index: number, total: number) => void): Promise<number> {
        const binding = this.requireBinding();
        // Encrypted DB with no key unlocked this session → key-missing
        // (never the plaintext hasher).
        return this.scanWith(binding, binding.currentKeys().hasher, onProgress);
    }

    /** `scan` with an explicit chunk hasher (Push passes its op's). */
    private async scanWith(
        binding: ConfigBinding,
        hasher: ChunkHasher,
        onProgress?: (path: string, index: number, total: number) => void,
    ): Promise<number> {
        const db = binding.store;
        const lastSynced = binding.lastSynced;
        await lastSynced.ensureLoaded();

        const files: string[] = [];
        await this.listFilesRecursive(".obsidian", files);

        const deviceId = this.getSettings().deviceId;
        let count = 0;
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const fileName = file.split("/").pop() ?? "";
            if (ConfigSync.SKIP_FILES.has(fileName)) continue;
            if (this.skipPaths.has(file)) continue;
            // Policy SEND projection. Excluded files never enter the local
            // config DB, so they never reach the push pipeline's changes feed
            // — the lastPushSeq cursor stays consistent without the pipeline
            // knowing anything about the policy (it remains a pure transport).
            if (!sendDecision(this.getSettings().configSyncPolicy, classifyConfigPath(file))) {
                continue;
            }

            try {
                onProgress?.(file, i + 1, files.length);
                const stat = await this.vault.stat(file);
                if (!stat || stat.size > ConfigSync.MAX_CONFIG_SIZE) continue;

                const buf = await this.vault.readBinary(file);
                const chunks = await splitIntoChunks(
                    buf,
                    { hasher, chunkBytes: MAX_CHUNK_BYTES_CONFIG },
                );
                const chunkIds = chunks.map((c) => c._id);

                const cached = lastSynced.get(file);
                if (cached && cached.size === stat.size
                    && chunkListsEqual(cached.chunks, chunkIds)) {
                    continue; // unchanged since last sync — no rewrite
                }

                const configId = makeConfigId(file);
                await db.runWriteBuilder(async (snap) => {
                    const existing = (await snap.get(configId)) as ConfigDoc | null;
                    const newVclock = incrementVC(existing?.vclock, deviceId);
                    const doc: ConfigDoc = {
                        _id: configId,
                        schemaVersion: CONFIG_SCHEMA_VERSION,
                        type: "config",
                        chunks: chunkIds,
                        mtime: stat.mtime,
                        size: stat.size,
                        vclock: newVclock,
                    };
                    return {
                        chunks: chunks as unknown as CouchSyncDoc[],
                        docs: [{ doc: doc as unknown as CouchSyncDoc }],
                        meta: [{
                            op: "put",
                            key: configLastSyncedKey(file),
                            value: {
                                vclock: newVclock,
                                size: stat.size,
                                chunks: chunkIds,
                            },
                        }],
                        onCommit: () => {
                            lastSynced.set(file, {
                                vclock: newVclock,
                                size: stat.size,
                                chunks: chunkIds,
                            });
                        },
                    };
                });
                count++;
            } catch (e) {
                logError(`Failed to scan config ${file}: ${e?.message ?? e}`);
            }
        }
        return count;
    }

    /** Write config docs to filesystem, filtered by the policy RECEIVE
     *  projection (`receiveDecision`): the meaning-unit selection narrowed by
     *  this device's platform + which plugins are installed locally.
     *
     *  v0.26 chunking: assembles each config file's binary content by
     *  fetching the referenced ChunkDocs from the config DB and joining
     *  them. Missing chunks cause a WARN + skip (symmetric with
     *  VaultSync.dbToFile); the missing chunk is expected to arrive on
     *  the next pull. Tombstones (`deleted: true`) are silently skipped
     *  \u2014 config-sync currently has no continuous tombstone-driven flow,
     *  but the field is honoured for safety.
     *
     *  Idempotent: only files whose disk content differs from the DB are
     *  written (symmetric to `scanWith`'s unchanged short-circuit on the
     *  push side). Returns the number of files actually written, so 0
     *  means the disk already matched. */
    async write(onProgress?: (path: string, index: number, total: number) => void): Promise<number> {
        const binding = this.requireBinding();
        // Local-only: refuse a half-built DB, but don't demand a Join (the
        // store's docs are this device's own).
        binding.assertLocalReady({ requireAttached: false });
        const db = binding.store;
        const policy = this.getSettings().configSyncPolicy;
        // Build the receive-side context once per write (not per doc): this
        // device's platform + which plugins are installed locally + their
        // local desktop-only flags. These are the receiver-only inputs the
        // sender cannot know \u2014 see receiveDecision.
        const ctx = await this.buildReceiveContext();

        // Enumerate every config doc and apply the policy RECEIVE projection
        // (replaces the legacy per-path/prefix configSyncPaths lookup).
        const result = await db.allDocs({
            startkey: DOC_ID.CONFIG,
            endkey: DOC_ID.CONFIG + "\ufff0",
            include_docs: true,
        });
        const docs: ConfigDoc[] = [];
        for (const row of result.rows) {
            if (!row.doc) continue;
            const doc = row.doc as unknown as ConfigDoc;
            if (doc.type !== "config" || doc.deleted) continue;
            docs.push(doc);
        }

        let count = 0;
        for (let i = 0; i < docs.length; i++) {
            const doc = docs[i];
            const path = configPathFromId(doc._id);
            // Trust boundary: config paths are written via the adapter
            // (mkdir + writeBinary) with no index mediation — the most direct
            // traversal vector. Reject vault-escaping paths before ensureDir.
            const pathViolation = unsafeVaultPathReason(path);
            if (pathViolation) {
                logWarn(`rejecting unsafe remote config path "${path}" — ${pathViolation}`);
                continue;
            }
            if (this.skipPaths.has(path)) continue;
            // Policy RECEIVE projection = SEND projection ∩ receiver gates
            // (local plugin presence / platform). receive ⊆ send.
            if (!receiveDecision(policy, classifyConfigPath(path), ctx)) continue;
            try {
                onProgress?.(path, i + 1, docs.length);
                const chunks = await db.getChunks(doc.chunks);
                // Availability: a content-less chunk doc is
                // unavailable, same as an absent one. Filter to usable chunks
                // before the completeness check so config write skips cleanly
                // (its existing non-throwing policy) instead of letting a
                // content-less doc reach joinChunks.
                const usableIds = new Set(
                    chunks
                        .filter((c) => c.content instanceof Uint8Array)
                        .map((c) => c._id),
                );
                if (usableIds.size !== doc.chunks.length) {
                    const missing = doc.chunks.filter((id) => !usableIds.has(id));
                    logWarn(
                        `Skipping config write ${path} \u2014 ` +
                        `missing ${missing.length} chunk(s): ${missing.slice(0, 3).join(", ")}`,
                    );
                    continue;
                }
                // Size ceiling before assembleChunks allocates the full
                // buffer — symmetric to the push scan's MAX_CONFIG_SIZE gate.
                const sizeBytes = chunks.reduce(
                    (n, c) => n + (c.content instanceof Uint8Array ? c.content.length : 0), 0,
                );
                if (sizeBytes > ConfigSync.MAX_CONFIG_SIZE) {
                    logWarn(
                        `Skipping config write ${path} — ` +
                        `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB exceeds ` +
                        `${ConfigSync.MAX_CONFIG_SIZE / (1024 * 1024)} MB config limit`,
                    );
                    continue;
                }
                const buf = ConfigSync.assembleChunks(doc.chunks, chunks);
                // A file whose bytes already match is left alone: rewriting
                // it bumps its mtime, and Obsidian re-reads app.json,
                // appearance.json or a plugin's data.json on that, replacing
                // settings held in memory.
                if (await this.diskMatches(path, buf)) continue;
                await this.ensureDir(path);
                if (await this.vault.exists(path)) {
                    await this.vault.writeBinary(path, buf);
                } else {
                    await this.vault.createBinary(path, buf);
                }
                count++;
            } catch (e) {
                logError(`Failed to write config ${path}: ${e?.message ?? e}`);
            }
        }
        return count;
    }

    /** True when `path` is a file on disk whose bytes equal `buf`. The size
     *  is compared first, so most changed files are told apart without a
     *  read. */
    private async diskMatches(path: string, buf: ArrayBuffer): Promise<boolean> {
        const stat = await this.vault.stat(path);
        if (!stat || stat.size !== buf.byteLength) return false;
        const disk = new Uint8Array(await this.vault.readBinary(path));
        const want = new Uint8Array(buf);
        if (disk.length !== want.length) return false;
        for (let i = 0; i < want.length; i++) {
            if (disk[i] !== want[i]) return false;
        }
        return true;
    }

    /** Build the per-write receive context: this device's platform + the set
     *  of locally-installed plugin folders + their local desktop-only flags.
     *  The plugins folder is listed once; each present plugin's local manifest
     *  is read only on mobile, where the desktop-only gate can fire. */
    private async buildReceiveContext(): Promise<ReceiveContext> {
        const isMobile = this.getIsMobile();
        const present = new Set<string>();
        try {
            const listing = await this.vault.list(".obsidian/plugins");
            for (const folder of listing.folders) present.add(folder);
        } catch {
            // No plugins dir (vault with no plugins) — empty set is correct.
        }
        const desktopOnly = new Map<string, boolean | undefined>();
        if (isMobile) {
            for (const dir of present) {
                desktopOnly.set(dir, await readLocalIsDesktopOnly(this.vault, dir));
            }
        }
        return {
            isMobile,
            pluginPresent: (dir) => present.has(dir),
            isDesktopOnly: (dir) => desktopOnly.get(dir),
        };
    }

    /** Order the fetched chunks by the ConfigDoc.chunks reference list
     *  and join into a single ArrayBuffer. The fetch order from
     *  `getChunks` is not guaranteed (keys-array allDocs returns rows
     *  in id order, not request order), so we re-order through a map. */
    private static assembleChunks(
        order: readonly string[],
        chunks: readonly ChunkDoc[],
    ): ArrayBuffer {
        const byId = new Map<string, ChunkDoc>();
        for (const c of chunks) byId.set(c._id, c);
        const ordered = order
            .map((id) => byId.get(id))
            .filter((c): c is ChunkDoc => c != null);
        return joinChunks(ordered as ChunkDoc[]);
    }

    // ── Utilities (public for settings UI) ─────────────

    /** True when config sync is bound to a config DB. */
    isConfigured(): boolean {
        return this.binding !== null;
    }

    /** Return the current binding, throwing `not-configured` when there is
     *  none. Apply rebinds immediately, so being unbound means either no DB
     *  name is applied, or opening its local store failed on the last rebind
     *  (the cause is in the log). */
    private requireBinding(): ConfigBinding {
        if (this.binding) return this.binding;
        const name = this.getSettings().couchdbConfigDbName;
        throw configNotReady("not-configured", name ? { db: name } : {});
    }

    /** Quiet remote config path list for the settings filter tree's "on
     *  server" provenance. It does NOT run inside a ConfigOperation epoch —
     *  no ProgressNotice (the tree fetches this on every render) and no op
     *  lock.
     *
     *  It is also the tab's check of the relation: its outcome is recorded
     *  on the binding as a `check`, so the Step 3 status line shows a
     *  server that cannot be reached, a changed root or a wrong passphrase
     *  before the next Push or Pull. A device that has not joined, or whose
     *  Create did not finish, has nothing to check — the status line already
     *  says so — and the server is not contacted.
     *
     *  Without the lock it must not change the binding: it runs the
     *  read-only `inspect` (never `preflight`) and reads through a client
     *  wrapped with the verdict's own keys, leaving the floor alone. While an
     *  op (or a rebind) runs it does not touch the server at all; the tree
     *  keeps its cached listing.
     *
     *  Reads through the WRAPPED client: when the config DB is encrypted,
     *  remote doc ids are `config:<hmac>` (EncryptingCouchClient HMACs the
     *  path), and only the wrapped allDocs decrypts the bodies back to
     *  `config:<path>` ids. A raw client would only see hashes.
     *
     *  Non-throwing: a failure is recorded, logged as a warning, and the tree
     *  falls back to the local-only view. */
    async listRemoteConfigPathsQuiet(): Promise<RemoteConfigListing> {
        const binding = this.binding;
        const bindingKey = binding?.key ?? null;
        if (!binding) {
            // Config sync disabled: nothing to list, and nothing failed. A
            // name without a binding (its store failed to open) is shown by
            // the status line.
            return { paths: [], ok: !this.getSettings().couchdbConfigDbName, bindingKey };
        }
        if (this.inflight !== null || this.rebinding !== null) {
            return { paths: [], ok: false, bindingKey };
        }
        const rel = binding.relation();
        if (!rel.attachment || rel.settingUp) return { paths: [], ok: false, bindingKey };

        const at = Date.now();
        const against = rel.attachment.metaFingerprint;
        try {
            const raw = this.makeRawClient(binding);
            if (!raw) throw configNotReady("not-configured");
            const quick = raw.withTimeout(CONFIG_TIMEOUTS.reachability);
            const signal = new AbortController().signal;
            const verdict = await binding.inspect(quick, signal);
            const keys = makeConfigOpKeys(
                verdict.attachment.codec, verdict.crypto, binding.entry()?.cipherFloor,
                binding.dbName,
            );
            const client = this.wrapFor(binding, quick, keys);
            const ids = await remoteCouch.listRemoteByPrefix(client, DOC_ID.CONFIG, signal);
            binding.record({ op: "check", at, against, error: null });
            return {
                ok: true,
                bindingKey,
                paths: ids
                    .map(configPathFromId)
                    .filter((p) => p.startsWith(".obsidian/")),
            };
        } catch (e) {
            binding.record({ op: "check", at, against, error: e });
            logWarn(`config remote listing failed: ${describeError(e).text}`);
            return { paths: [], ok: false, bindingKey };
        }
    }

    /** List installed plugin folder paths (fallback when remote unavailable) */
    async listPluginFolders(): Promise<string[]> {
        const folders: string[] = [];
        try {
            const listing = await this.vault.list(".obsidian/plugins");
            for (const folder of listing.folders) {
                folders.push(folder + "/");
            }
        } catch (e: any) {
            // A missing plugins dir is expected (vault with no plugins).
            // Anything else is unexpected — surface it rather than silently
            // returning an empty list, which would look like "no plugins".
            logWarn(`listPluginFolders failed: ${e?.message ?? e}`);
        }
        return folders.sort();
    }

    /** List all local `.obsidian/` config file paths for the settings tree
     *  UI, applying the same physical exclusions as `scan` (SKIP_FILES /
     *  SKIP_DIRS via listFilesRecursive, and the own-data.json skipPaths).
     *  Policy is NOT applied here — the UI shows every selectable path and
     *  reflects the policy decision per node itself. */
    async listLocalConfigPaths(): Promise<string[]> {
        const files: string[] = [];
        await this.listFilesRecursive(".obsidian", files);
        return files
            .filter((f) => {
                const name = f.split("/").pop() ?? "";
                return !ConfigSync.SKIP_FILES.has(name) && !this.skipPaths.has(f);
            })
            .sort();
    }

    getCommonConfigPaths(): string[] {
        return [
            ".obsidian/app.json",
            ".obsidian/appearance.json",
            ".obsidian/hotkeys.json",
            ".obsidian/community-plugins.json",
            ".obsidian/core-plugins.json",
            ".obsidian/core-plugins-migration.json",
        ];
    }

    // ── Private ────────────────────────────────────────

    private async ensureDir(filePath: string): Promise<void> {
        const dir = filePath.split("/").slice(0, -1).join("/");
        if (dir && !(await this.vault.exists(dir))) {
            await this.vault.createFolder(dir);
        }
    }

    private async listFilesRecursive(dir: string, result: string[]): Promise<void> {
        try {
            const listing = await this.vault.list(dir);
            for (const file of listing.files) {
                result.push(file);
            }
            for (const folder of listing.folders) {
                const folderName = folder.split("/").pop() ?? "";
                if (ConfigSync.SKIP_DIRS.has(folderName)) continue;
                await this.listFilesRecursive(folder, result);
            }
        } catch (e: any) {
            // Skip inaccessible dirs, but log — a dir that was listed by its
            // parent yet errors on its own listing is unexpected (race or
            // permission issue), not normal operation, and silently dropping
            // its files would under-sync config without any trace.
            logWarn(`listFilesRecursive skipped ${dir}: ${e?.message ?? e}`);
        }
    }
}

/** A cancellation. `userMessage`, when given, says what the cancel left
 *  behind; ProgressNotice shows it after "<label> cancelled". */
function abortError(userMessage?: string): Error {
    const e: any = new Error("The operation was aborted.");
    e.name = "AbortError";
    if (userMessage) e.userMessage = userMessage;
    return e;
}
