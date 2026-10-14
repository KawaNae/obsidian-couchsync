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
import {
    DOC_ID,
    configPathFromId,
} from "../types/doc-id.ts";
import type { CouchSyncSettings } from "../settings.ts";
import { ProgressNotice } from "../ui/notices.ts";
import type { ICouchClient } from "../db/interfaces.ts";
import { makeCouchClient } from "../db/couch-client.ts";
import { logError, logInfo, logWarn } from "../ui/log.ts";
import { describeError } from "../ui/describe-error.ts";
import { classifyConfigPath } from "./config-policy/classify.ts";
import { participates, type DeviceContext } from "./config-policy/policy.ts";
import { readLocalIsDesktopOnly } from "./config-policy/manifest.ts";
import * as remoteCouch from "../db/remote-couch.ts";
import {
    ConfigOperation,
    CONFIG_TIMEOUTS,
    type ConfigOpContext,
} from "./config-operation.ts";
import type { ReconnectBridge } from "./reconnect-bridge.ts";
import { configLastSyncedKey } from "../db/sync/config-last-synced.ts";
import { ConfigPullWriter } from "../db/sync/config-pull-writer.ts";
import {
    ConfigPushPipeline,
    type ConfigPushHoldReason,
} from "../db/sync/config-push-pipeline.ts";
import {
    planPull,
    planPush,
    type PullPlan,
    type PullPlanEntry,
    type ReconcileDeps,
} from "./config-reconcile.ts";
import { backupConfigFiles } from "./config-backup.ts";
import {
    configLocalFirstKey,
    loadLocalFirst,
    migrateConfigBase,
} from "./config-migration.ts";
import { ConfigSetupService } from "./config-setup.ts";
import type { ConfigCreatePreview } from "./config-create-preview.ts";
import { fetchConfigMeta } from "../db/vault-meta.ts";
import { classifyError } from "../db/sync/errors.ts";
import { resolveConfigCodec } from "./config-codec-policy.ts";
import { configNotReady } from "./config-errors.ts";

/**
 * ConfigSync — replication of `.obsidian/` configuration files against a
 * SEPARATE CouchDB database from the vault (v0.11.0+).
 *
 * Why separate? Because vault content is shared across all peer devices,
 * but `.obsidian/` may legitimately differ between device pools (mobile
 * vs desktop). Putting them in the same DB would conflate "vault edit"
 * concurrency with "device-pool config drift" — different problems with
 * different resolution policies.
 *
 * Architecturally:
 *   - Local storage: `ConfigLocalDB` (Dexie-backed IndexedDB store). Its
 *     config docs are the shared versions — what the server accepted —
 *     and lastSynced is, per path, the shared version the disk took in
 *     (the base). A local change is the disk's difference from the base.
 *   - Remote storage: `settings.couchdbConfigDbName` on the same CouchDB
 *     server as the vault DB (auth shared via a common `AuthGate`)
 *   - Replication: every public op runs inside a `ConfigOperation` epoch
 *     that owns an AbortController, runs a 15s reachability probe, and
 *     waits for visibility=visible before fetching. Vault sync's session
 *     lifecycle disciplines the live loops; ConfigOperation is the same
 *     discipline for one-shot user-triggered ops.
 *   - Pull merges three-way (JSON key by key, other files as a whole);
 *     Push sends the local changes of paths whose shared version is
 *     current and holds the rest until a Pull merged them.
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

/** Optional ConfigSync wiring. Production sets `pluginDir`, `reload` and
 *  the persistence hooks; tests inject `storeFactory` / `rawClientFactory` /
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
    /** This plugin's folder (host passes `manifest.dir`). Its data.json —
     *  the deviceId and the plaintext CouchDB password / passphrase — and
     *  its `backups/` folder are excluded from replication, and Pull keeps
     *  its backups there. Falls back to the default folder name when
     *  omitted. */
    pluginDir?: string;
    /** Reload the app. Pull calls it after writing files; omitted in
     *  tests. */
    reload?: () => void;
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
     *  (Pull). Production passes `() => Platform.isMobile`; tests inject a
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

const HOLD_REASONS: Record<ConfigPushHoldReason, string> = {
    "remote-changed": "the server has a newer version",
    "not-merged": "this device has not taken in the shared version yet",
};

const OP_LABELS: Record<LockedConfigOp, string> = {
    push: "Config Push",
    pull: "Config Pull",
    join: "Config Join",
    create: "Config Create",
};

export class ConfigSync {
    private static readonly SKIP_DIRS = new Set(["node_modules", ".git"]);
    private static readonly SKIP_FILES = new Set(["workspace.json", "workspace-mobile.json"]);
    /** Fallback plugin folder, used only when the host does not supply the
     *  real install path. Fragile (assumes the default folder name). */
    private static readonly DEFAULT_PLUGIN_DIR = ".obsidian/plugins/obsidian-couchsync";

    /** This plugin's OWN data.json. It carries the deviceId AND the
     *  plaintext CouchDB password / encryption passphrase, so it must NEVER
     *  be pushed to the (untrusted) config server. Derived from the real
     *  install path the host passes in (`manifest.dir`), not a hardcoded
     *  folder name — a BRAT / manually-renamed plugin folder still gets its
     *  data.json excluded. */
    private readonly ownDataPath: string;
    /** This plugin's backups folder, excluded from replication like
     *  `ownDataPath`: the copies include other plugins' data.json, which
     *  may hold secrets. */
    private readonly backupsDir: string;
    /** Where Pull keeps copies of the files it overwrites. */
    private readonly backupRoot: string;
    private readonly reload: () => void;
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
        this.saveSettings = opts.saveSettings ?? (async () => {});
        this.askPassphrase = opts.askPassphrase;
        this.getIsMobile = opts.getIsMobile ?? (() => false);
        const pluginDir = opts.pluginDir ?? ConfigSync.DEFAULT_PLUGIN_DIR;
        this.ownDataPath = `${pluginDir}/data.json`;
        this.backupsDir = `${pluginDir}/backups`;
        this.backupRoot = `${this.backupsDir}/config`;
        this.reload = opts.reload ?? (() => {});
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

    /**
     * Push: send the disk's changes against the base.
     *
     *   1. plan: every file that takes part in sharing here, compared with
     *      its base (`planPush`); unchanged files are not sent
     *   2. send (`ConfigPushPipeline`): a path whose server doc is not the
     *      shared version held here, or whose disk has not taken that
     *      version in, is held — Pull & Reload merges it first
     *   3. the accepted docs become the shared version and the base
     *
     * Every change is sent; the config DB is written only for what the
     * server accepted. Returns the number of files pushed.
     */
    async push(): Promise<number> {
        return this.runOperation("push", async (ctx, progress, binding, keys) => {
            await binding.ensureCheckpointsLoaded();
            const writer = this.makePullWriter(binding, ctx, keys!);
            const deps = await this.prepare(binding, ctx, keys!, writer);

            const files: string[] = [];
            await this.listFilesRecursive(".obsidian", files);
            const plan = await planPush(deps, files, (path, i, total) => {
                progress.update(`Comparing: ${path} (${i}/${total})`);
            });

            const pipeline = new ConfigPushPipeline({
                db: binding.store,
                client: ctx.client,
                lastSynced: binding.lastSynced,
                hasher: keys!.hasher,
                getDeviceId: () => this.getSettings().deviceId,
                signal: ctx.signal,
            });
            const result = await pipeline.run(plan, (msg) => progress.update(msg));

            if (result.held.length > 0) {
                logWarn(
                    `Config Push held ${result.held.length} file(s); run Pull & Reload, then Push again:\n` +
                    result.held.map((h) => `  • ${h.path} (${HOLD_REASONS[h.reason]})`).join("\n"),
                );
            }
            if (result.failed.length > 0) {
                logWarn(
                    `Config Push: the server rejected ${result.failed.length} file(s):\n` +
                    result.failed.map((p) => `  • ${p}`).join("\n"),
                );
            }
            const parts: string[] = [];
            parts.push(result.pushed.length > 0
                ? `${result.pushed.length} file(s) pushed.`
                : plan.length === 0 ? "No local changes to push." : "Nothing pushed.");
            if (result.held.length > 0) {
                parts.push(
                    `${result.held.length} held: the server has changes this device has not ` +
                    `taken in — run Pull & Reload, then Push again.`,
                );
            }
            if (result.failed.length > 0) {
                parts.push(`${result.failed.length} rejected by the server (see log).`);
            }
            progress.done(parts.join(" "));
            return result.pushed.length;
        }, {
            // Push advances vclocks under this device's name.
            gate: (binding) => {
                if (!this.getSettings().deviceId) {
                    throw configNotReady("device-id-missing", { db: binding.dbName });
                }
            },
        });
    }

    /**
     * Pull & Reload.
     *
     *   1. copy: the server's docs since the cursor replace the config DB's
     *      (`ConfigPullWriter`)
     *   2. plan: each received path whose shared version the disk has not
     *      taken in is merged three-way with its base and the disk
     *      (`planPull`); nothing is written yet
     *   3. back up the files about to be written (`config-backup.ts`)
     *   4. write them, and move each path's base to its shared version
     *   5. one Notice, then reload Obsidian when a file was written — the
     *      app must re-read the files, or it writes its in-memory settings
     *      back over them
     *
     * Keys both sides changed keep the disk's value; they are counted on
     * the Notice and named (without values) in the log. Returns the number
     * of files written.
     */
    async pull(): Promise<number> {
        const written = await this.runOperation("pull", async (ctx, progress, binding, keys) => {
            await binding.ensureCheckpointsLoaded();
            const writer = this.makePullWriter(binding, ctx, keys!);
            const deps = await this.prepare(binding, ctx, keys!, writer);

            // A remote ConfigDoc shape this build cannot read throws
            // SchemaVersionMismatchError, whose `userMessage` names the
            // migration (Create, then Join on the other devices); it reaches
            // progress.fail as is.
            const received = await writer.run((msg) => progress.update(msg));

            const plan = await planPull(deps, (path, i, total) => {
                progress.update(`Comparing: ${path} (${i}/${total})`);
            });
            const count = await this.applyPullPlan(binding, plan, progress);

            const conflicts = plan.entries.filter((e) => e.decision.conflicts.length > 0);
            if (conflicts.length > 0) {
                logWarn(
                    `Config Pull kept this device's value where both sides changed ` +
                    `(${conflicts.length} file(s)); Push sends them, overwriting the shared value:\n` +
                    conflicts.map((e) => `  • ${e.path}: ${e.decision.conflicts
                        .map((p) => p === "" ? "(whole file)" : p).join(", ")}`).join("\n"),
                );
            }
            const parts: string[] = [];
            if (received.received + received.deleted > 0) {
                parts.push(`Received ${received.received + received.deleted} change(s).`);
            }
            if (conflicts.length > 0) {
                parts.push(`${conflicts.length} file(s) kept this device's value where both sides changed (see log).`);
            }
            if (plan.unavailable.length > 0) {
                parts.push(`${plan.unavailable.length} file(s) skipped (see log).`);
            }
            parts.push(count > 0
                ? `Wrote ${count} file(s). Reloading Obsidian...`
                : "No config files changed; no reload needed.");
            progress.done(parts.join(" "));
            return count;
        });
        if (written > 0) this.reload();
        return written;
    }

    /** Back up, then write the planned files; move every planned path's
     *  base to its shared version. A file that fails to write keeps its old
     *  base, so the next Pull tries it again. */
    private async applyPullPlan(
        binding: ConfigBinding,
        plan: PullPlan,
        progress: ProgressNotice,
    ): Promise<number> {
        const writes = plan.entries.filter((e) => e.decision.write !== null);
        const backups = writes
            .filter((e) => e.local !== null)
            .map((e) => ({ path: e.path, bytes: e.local! }));
        if (backups.length > 0) {
            progress.update(`Backing up ${backups.length} file(s)...`);
            await backupConfigFiles(this.vault, this.backupRoot, backups);
        }
        if (writes.length > 0) await binding.recordDiskWrite();

        let count = 0;
        for (let i = 0; i < writes.length; i++) {
            const e = writes[i];
            progress.update(`Writing: ${e.path} (${i + 1}/${writes.length})`);
            try {
                const buf = e.decision.write!.slice().buffer as ArrayBuffer;
                await this.ensureDir(e.path);
                if (await this.vault.exists(e.path)) {
                    await this.vault.writeBinary(e.path, buf);
                } else {
                    await this.vault.createBinary(e.path, buf);
                }
            } catch (err: any) {
                logError(`Failed to write config ${e.path}: ${err?.message ?? err}`);
                continue;
            }
            await this.settleBase(binding, [e]);
            count++;
        }
        await this.settleBase(binding, plan.entries.filter((e) => e.decision.write === null));
        return count;
    }

    /** The disk of `entries` has taken in their shared versions. */
    private async settleBase(binding: ConfigBinding, entries: readonly PullPlanEntry[]): Promise<void> {
        if (entries.length === 0) return;
        const values = entries.map((e) => ({
            path: e.path,
            value: { vclock: e.shared.vclock, size: e.shared.size, chunks: e.shared.chunks },
        }));
        await binding.store.runWriteTx({
            meta: values.flatMap(({ path, value }) => [
                { op: "put" as const, key: configLastSyncedKey(path), value },
                { op: "delete" as const, key: configLocalFirstKey(path) },
            ]),
            onCommit: () => {
                for (const { path, value } of values) binding.lastSynced.set(path, value);
            },
        });
    }

    private makePullWriter(binding: ConfigBinding, ctx: ConfigOpContext, keys: ConfigOpKeys): ConfigPullWriter {
        return new ConfigPullWriter({
            db: binding.store,
            client: ctx.client,
            checkpoints: binding.checkpoints,
            lastSynced: binding.lastSynced,
            signal: ctx.signal,
            hasher: keys.hasher,
        });
    }

    /**
     * Shared start of Push and Pull: drop the bases when another config
     * DB's Pull wrote the disk since this one was used
     * (`ConfigBinding.alignBasesWithDisk`), bring an old store to the
     * shared / base meaning once (`migrateConfigBase`), and build the
     * planner's inputs.
     * Right after that migration, the files whose disk differs from their
     * base are logged: the next Push sends them.
     */
    private async prepare(
        binding: ConfigBinding,
        ctx: ConfigOpContext,
        keys: ConfigOpKeys,
        writer: ConfigPullWriter,
    ): Promise<ReconcileDeps> {
        const participating = await this.participation();
        const dropped = await binding.alignBasesWithDisk();
        if (dropped > 0) {
            logInfo(
                `Config: another config database's Pull wrote this vault's config since ` +
                `"${binding.dbName}" was last used; ${dropped} file(s) are merged as after ` +
                `a Join (the shared values win, keys only this device has stay).`,
            );
        }
        const migration = await migrateConfigBase({
            store: binding.store,
            lastSynced: binding.lastSynced,
            client: ctx.client,
            signal: ctx.signal,
            participates: participating,
            ensureChunks: (doc) => writer.ensureChunks(doc).catch((e: any) => {
                logWarn(`config migration: chunks of ${doc._id}: ${e?.message ?? e}`);
            }),
        });
        const deps: ReconcileDeps = {
            vault: this.vault,
            store: binding.store,
            lastSynced: binding.lastSynced,
            hasher: keys.hasher,
            maxSize: ConfigSync.MAX_CONFIG_SIZE,
            participates: participating,
            fetchChunks: (doc) => writer.ensureChunks(doc),
            localFirst: await loadLocalFirst(binding.store),
        };
        if (migration.ran) {
            const files: string[] = [];
            await this.listFilesRecursive(".obsidian", files);
            const changed = await planPush(deps, files);
            if (changed.length > 0) {
                logInfo(
                    `Config: ${changed.length} file(s) differ from what this device last ` +
                    `took from the server; the next Push sends them:\n` +
                    changed.map((e) => `  • ${e.path}`).join("\n"),
                );
            }
        }
        return deps;
    }

    // ── Low-level operations ───────────────────────────

    /** Paths never replicated: workspace layout, this plugin's own
     *  data.json (credentials) and its backups folder (copies of other
     *  plugins' data.json). */
    private isExcluded(path: string): boolean {
        const name = path.split("/").pop() ?? "";
        if (ConfigSync.SKIP_FILES.has(name)) return true;
        if (path === this.ownDataPath) return true;
        return path === this.backupsDir || path.startsWith(this.backupsDir + "/");
    }

    /**
     * The one decision of which paths take part in sharing on this device,
     * for the op about to run: not physically excluded, and `participates`
     * under the policy and this device's state. Push and Pull both use it,
     * so a file is sent exactly when it would also be written here.
     */
    private async participation(): Promise<(path: string) => boolean> {
        const device = await this.buildDeviceContext();
        const policy = () => this.getSettings().configSyncPolicy;
        return (path) =>
            !this.isExcluded(path) && participates(policy(), classifyConfigPath(path), device);
    }

    /** Build the per-op device context: this device's platform + the set
     *  of locally-installed plugin folders + their local desktop-only flags.
     *  The plugins folder is listed once; each present plugin's local manifest
     *  is read only on mobile, where the desktop-only gate can fire. */
    private async buildDeviceContext(): Promise<DeviceContext> {
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
     *  SKIP_DIRS via listFilesRecursive, own data.json and backups).
     *  Policy is NOT applied here — the UI shows every selectable path and
     *  reflects the policy decision per node itself. */
    async listLocalConfigPaths(): Promise<string[]> {
        const files: string[] = [];
        await this.listFilesRecursive(".obsidian", files);
        return files
            .filter((f) => !this.isExcluded(f))
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
                if (this.isExcluded(folder)) continue;
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
