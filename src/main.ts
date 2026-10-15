import { Platform, Plugin, apiVersion } from "obsidian";
import { type CouchSyncSettings, DEFAULT_SETTINGS } from "./settings.ts";
import { LocalDB } from "./db/local-db.ts";
import type { ConfigLocalDB } from "./db/config-local-db.ts";
import { SyncEngine } from "./db/sync-engine.ts";
import { AuthGate } from "./db/sync/auth-gate.ts";
import { VaultRemoteOps } from "./db/sync/vault-remote-ops.ts";
import { VaultSync } from "./sync/vault-sync.ts";
import { ConfigSync } from "./sync/config-sync.ts";
import type { ReconnectBridge } from "./sync/reconnect-bridge.ts";
import { SetupService } from "./sync/setup.ts";
import { ChangeTracker } from "./sync/change-tracker.ts";
import { Reconciler, type ReconcileReason } from "./sync/reconciler.ts";
import { ConflictOrchestrator } from "./conflict/conflict-orchestrator.ts";
import { checkInstallMarker } from "./sync/install-marker.ts";
import { StatusBar } from "./ui/status-bar.ts";
import { initLog, logInfo, logError, logWarn, notify } from "./ui/log.ts";
import { CouchSyncSettingTab } from "./settings-tab/index.ts";
import { ProgressNotice, showNotice } from "./ui/notices.ts";
import { HistoryStorage } from "./history/storage.ts";
import { HistoryCapture } from "./history/history-capture.ts";
import { HistoryManager } from "./history/history-manager.ts";
import { LogStorage } from "./log/log-storage.ts";
import { LogManager } from "./log/log-manager.ts";
import type { DeviceInfo } from "./log/markdown-formatter.ts";
import { DiffHistoryView, VIEW_TYPE_DIFF_HISTORY } from "./ui/history-view.ts";
import { LogView, VIEW_TYPE_LOG } from "./ui/log-view.ts";
import { deleteLegacyConfigStore, migrateSettings } from "./settings-migration.ts";
import { registerCommands } from "./commands.ts";
import { gcOrphanChunks } from "./db/chunk-gc.ts";
import { ObsidianVaultIO } from "./adapters/obsidian-vault-io.ts";
import { ObsidianAdapterIO } from "./adapters/obsidian-adapter-io.ts";
import { ObsidianVaultEvents } from "./adapters/obsidian-vault-events.ts";
import { ObsidianModalPresenter } from "./adapters/obsidian-modal-presenter.ts";
import { ObsidianCompositionTracker } from "./adapters/obsidian-composition-tracker.ts";
import { EditorAwareVaultWriter } from "./adapters/editor-aware-vault-writer.ts";
import { CompositionGate } from "./sync/composition-gate.ts";
import { makeCouchClient } from "./db/couch-client.ts";
import { VaultBinding } from "./sync/vault-binding.ts";
import { ReloadGuard } from "./sync/reload-guard.ts";
import { describeVaultSetupConfirm } from "./sync/vault-setup-confirm.ts";
import { PassphraseModal } from "./ui/passphrase-modal.ts";
import type { ICouchClient } from "./db/interfaces.ts";

export default class CouchSyncPlugin extends Plugin {
    settings!: CouchSyncSettings;
    localDb!: LocalDB;
    /** The current config binding's local store; null when config sync is
     *  disabled. A getter on purpose: `ConfigSync.rebind` (Apply) replaces
     *  the store at runtime, so callers must read it at use time. */
    get configLocalDb(): ConfigLocalDB | null {
        return this.configSync?.currentStore() ?? null;
    }
    replicator!: SyncEngine;
    auth!: AuthGate;
    remoteOps!: VaultRemoteOps;
    configSync!: ConfigSync;
    private vaultSync!: VaultSync;
    private setupService!: SetupService;
    private changeTracker!: ChangeTracker;
    reconciler!: Reconciler;
    private historyStorage!: HistoryStorage;
    private historyCapture!: HistoryCapture;
    historyManager!: HistoryManager;
    logStorage!: LogStorage;
    logManager!: LogManager;
    statusBar!: StatusBar;
    modalPresenter!: ObsidianModalPresenter;
    private conflictOrchestrator!: ConflictOrchestrator;
    private compositionTracker!: ObsidianCompositionTracker;
    private compositionGate!: CompositionGate;
    private vaultWriter!: EditorAwareVaultWriter;
    /** Owner of the vault DB's setup: the codec state, Init / Clone, the
     *  encryption-agreement check and their outcomes. */
    vaultBinding!: VaultBinding;
    /** Keeps the config ops that reload Obsidian and the operations a
     *  reload would break (vault Init / Clone, config Create / Join) apart. */
    readonly reloadGuard = new ReloadGuard();

    /** Cross-platform OS label for the log frontmatter. Desktop uses Node
     *  `process.platform` (win32/darwin/linux); mobile has no Node, so derive
     *  from Obsidian `Platform` + the userAgent version (the old code emitted
     *  a useless "unknown" on every mobile export). */
    private deriveOsLabel(): string {
        if (typeof process !== "undefined" && process.platform) return process.platform;
        const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
        if (Platform.isAndroidApp) {
            const m = /Android (\d+(?:\.\d+)?)/.exec(ua);
            return m ? `android ${m[1]}` : "android";
        }
        if (Platform.isIosApp) {
            const base = Platform.isTablet ? "ipados" : "ios";
            const m = /OS (\d+(?:_\d+)*)/.exec(ua); // "CPU OS 17_4 like Mac OS X"
            return m ? `${base} ${m[1].replace(/_/g, ".")}` : base;
        }
        return "unknown";
    }

    /** Best-effort device specs for the log frontmatter. Every field is
     *  collected defensively and platform-asymmetric (Node `os` is desktop
     *  only via `window.require`, kept off esbuild's static path; deviceMemory
     *  and performance.memory are absent on iOS WebKit). Missing fields are
     *  simply omitted from the export. */
    private collectDeviceInfo(): DeviceInfo {
        const d: DeviceInfo = {};
        try {
            if (typeof navigator !== "undefined") {
                if (typeof navigator.hardwareConcurrency === "number") {
                    d.cpuCores = navigator.hardwareConcurrency;
                }
                if (navigator.userAgent) d.userAgent = navigator.userAgent;
                const dm = (navigator as any).deviceMemory;
                if (typeof dm === "number") d.deviceMemoryGb = dm;
            }
        } catch { /* best effort */ }
        try {
            const pm = typeof performance !== "undefined" ? (performance as any).memory : undefined;
            if (pm) {
                if (typeof pm.usedJSHeapSize === "number") {
                    d.jsHeapUsedMb = Math.round(pm.usedJSHeapSize / 1048576);
                }
                if (typeof pm.jsHeapSizeLimit === "number") {
                    d.jsHeapLimitMb = Math.round(pm.jsHeapSizeLimit / 1048576);
                }
            }
        } catch { /* best effort */ }
        try {
            // Desktop (Electron) only. `window.require` keeps the node builtin
            // off esbuild's browser-target static analysis; undefined on mobile.
            const req = typeof window !== "undefined" ? (window as any).require : undefined;
            if (typeof req === "function") {
                const os = req("os");
                d.arch = os.arch();
                d.osRelease = os.release();
                const cpus = os.cpus();
                if (cpus?.length) {
                    d.cpuCores = cpus.length;
                    const model = (cpus[0]?.model ?? "").trim();
                    if (model) d.cpuModel = model;
                }
                d.totalRamGb = Math.round((os.totalmem() / 1073741824) * 10) / 10;
                d.freeRamGb = Math.round((os.freemem() / 1073741824) * 10) / 10;
            }
        } catch { /* best effort */ }
        return d;
    }

    async onload(): Promise<void> {
        await this.loadSettings();

        // Install-marker check (advisory only — does NOT regenerate deviceId).
        {
            const result = checkInstallMarker({
                lastInstallMarker: this.settings.lastInstallMarker,
                storage: {
                    get: (k) => window.localStorage.getItem(k),
                    set: (k, v) => window.localStorage.setItem(k, v),
                },
                generateUuid: () => crypto.randomUUID(),
            });
            if (result.markerMismatch) {
                notify(
                    "this vault may have been copied from another installation. " +
                        "Please verify your device name in Settings → Vault Sync.",
                    10000,
                );
            }
            this.settings.lastInstallMarker = result.nextInstallMarker;
            await this.saveSettings();
        }

        const vaultName = this.app.vault.getName();
        const dbName = `couchsync-${vaultName}`;
        this.localDb = new LocalDB(dbName);
        this.localDb.open();
        await this.localDb.ensureSchemaVersion();

        initLog(() => this.settings, showNotice);
        const vaultIO = new ObsidianVaultIO(this.app);
        const adapterIO = new ObsidianAdapterIO(this.app);
        const vaultEvents = new ObsidianVaultEvents(this.app);
        this.modalPresenter = new ObsidianModalPresenter(this.app);
        const modalPresenter = this.modalPresenter;

        this.auth = new AuthGate();
        // The vault binding owns the vault codec state; its chunk hasher and
        // client wrapper read the key on every call, so Init / Clone reach
        // every vault-side user (VaultRemoteOps, VaultSync, SyncEngine).
        // Vault and config each have their own hasher, so the two DBs mint
        // chunk ids in disjoint id spaces. Built before remoteOps, whose
        // pullAll verifies pulled chunks with the hasher.
        this.vaultBinding = new VaultBinding({
            getSettings: () => this.settings,
            saveSettings: () => this.saveSettings(),
            auth: this.auth,
            makeRawClient: () => makeCouchClient(
                this.settings.couchdbUri, this.settings.couchdbDbName,
                this.settings.couchdbUser, this.settings.couchdbPassword,
            ),
            setup: () => this.setupService,
            checkDatabase: (db) => this.remoteOps.checkDatabaseWith(
                this.settings.couchdbUri, this.settings.couchdbUser, this.settings.couchdbPassword, db,
            ),
            stopLive: () => this.stopSync(),
            startLive: () => this.startSync(),
            openProgress: (label) => new ProgressNotice(label),
            askPassphrase: (reason, tryUnlock) => new PassphraseModal(
                this.app, false,
                (reason === "missing"
                    ? "This vault is encrypted, and no passphrase is set on this device. "
                    : "The passphrase set on this device does not unlock this vault. ") +
                    "Enter the passphrase it was set up with.",
                {
                    validate: async (p) => (await tryUnlock(p))
                        ? null
                        : "This passphrase does not unlock the vault.",
                },
            ).waitForResult(),
            // Destructive: the dialog opens with the focus on Cancel.
            confirmSetup: (plan) => {
                const c = describeVaultSetupConfirm(plan);
                return modalPresenter.showConfirmModal(c.title, c.message, c.confirmText, true);
            },
            reloadGuard: this.reloadGuard,
        });
        const vaultChunkHasher = this.vaultBinding.chunkHasher;
        const wrapVaultClient = this.vaultBinding.wrapClient;
        this.remoteOps = new VaultRemoteOps(
            this.localDb, () => this.settings, this.auth, wrapVaultClient,
            vaultChunkHasher,
        );
        this.historyStorage = new HistoryStorage(this.app.vault.getName());
        await this.historyStorage.ensureSchemaVersion();
        this.historyCapture = new HistoryCapture(vaultIO, vaultEvents, this.historyStorage, () => this.settings);

        // Editor-aware write layer: defers vault writes while the
        // path's editor is in IME composition, dispatches CodeMirror
        // transactions instead of triggering Obsidian's external-edit
        // reload (which would break IME), and falls back to disk
        // write when no editor session exists.
        this.compositionTracker = new ObsidianCompositionTracker(this.app);
        this.compositionGate = new CompositionGate(this.compositionTracker);
        this.vaultWriter = new EditorAwareVaultWriter(
            this.app, vaultIO, this.compositionGate,
            null, this.historyCapture,
        );
        this.vaultSync = new VaultSync(vaultIO, this.localDb, () => this.settings, this.vaultWriter, vaultChunkHasher);
        this.changeTracker = new ChangeTracker(vaultEvents, this.vaultSync, () => this.settings);
        // Late-bind the writeIgnore once ChangeTracker exists. It is
        // used by VaultWriter only on the deletion path (the modify
        // path now relies on chunksEqual idempotency in fileToDb).
        this.vaultWriter.setWriteIgnore(this.changeTracker);
        // Late-bind the pending-edit probe. VaultSync uses
        // it from `hasUnpushedChanges` to detect debounced user edits
        // before applying a remote deletion.
        this.vaultSync.setPendingProbe(this.changeTracker);
        // SyncEngine constructed AFTER vaultSync so the pull-writer can
        // call vaultSync.dbToFile directly via constructor DI (replaces
        // the former events.onAsync("pull-write", ...) bus, whose catch-
        // all swallowed write errors and let `Pull: N written` lie).
        // No RetryingCouchClient here (unlike VaultRemoteOps.makeDataClient):
        // the live session owns retry, and a second layer would delay error
        // surfacing and skew stall detection.
        const encClientFactory: (s: CouchSyncSettings) => ICouchClient = (s) =>
            wrapVaultClient(
                makeCouchClient(s.couchdbUri, s.couchdbDbName, s.couchdbUser, s.couchdbPassword),
            );
        this.replicator = new SyncEngine(
            this.localDb,
            () => this.settings,
            (doc) => this.vaultSync.dbToFile(doc),
            (path) => this.vaultSync.hasUnpushedChanges(path),
            Platform.isMobile,
            this.auth,
            encClientFactory,
            {
                check: (signal) => this.vaultBinding.checkAgreement(signal),
                recheckRoot: (observed) => this.vaultBinding.recheckRoot(observed),
            },
            async () => { await this.vaultSync.stampVaultDrift(); },
        );
        // Verify pulled chunk bodies hash to their content-addressed id
        // (the inverse of the mint in splitIntoChunks). Reads the live
        // crypto provider, so encryption-state changes propagate.
        this.replicator.setChunkHasher(vaultChunkHasher);
        const reconnectBridge: ReconnectBridge = {
            notifyTransient: () => {
                // Fire-and-forget: ConfigSync surfaces the original error to
                // the user via ProgressNotice/log; this only nudges the
                // vault session to verify reachability if it itself is
                // unhealthy. decideReconnect skips when vault is healthy.
                this.replicator.requestReconnect("config-failure").catch((e: any) =>
                    logError(`config-failure reconnect failed: ${e?.message ?? e}`),
                );
            },
        };
        // ConfigSync owns the config binding (local store + cursors + key +
        // codec stack + chunk hasher); main only wires host services. The
        // store is keyed by vault name + server + config DB name, so switching
        // device pools (e.g. mobile ↔ desktop) or servers opens a separate
        // local store.
        this.configSync = new ConfigSync(
            adapterIO,
            modalPresenter,
            vaultName,
            this.auth,
            this.replicator.getVisibilityGate(),
            reconnectBridge,
            () => this.settings,
            {
                // This plugin's real folder, so ConfigSync excludes its
                // data.json and backups even under a renamed plugin folder,
                // and keeps Pull's backups there. manifest.dir is the actual
                // install dir; fall back to the configDir + id composition.
                pluginDir: this.manifest.dir
                    || `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
                // Pull writes config files that Obsidian holds in memory;
                // only a reload makes the app read them instead of writing
                // its in-memory settings back over them.
                reloadGuard: this.reloadGuard,
                reload: () => {
                    setTimeout(() => {
                        (this.app as any).commands.executeCommandById("app:reload");
                    }, 500);
                },
                // Pull unloads a plugin before writing or deleting its files,
                // so its unload cannot save in-memory settings over them.
                // `disablePlugin` only unloads; the enabled list on disk is
                // what the reload starts the plugins from.
                stopPlugins: async (dirs) => {
                    const plugins = (this.app as any).plugins;
                    const manifests = Object.values(plugins.manifests ?? {}) as Array<{ id: string; dir?: string }>;
                    const stopped: string[] = [];
                    for (const m of manifests) {
                        if (!m.dir || !dirs.includes(m.dir) || !plugins.plugins?.[m.id]) continue;
                        try {
                            await plugins.disablePlugin(m.id);
                            stopped.push(m.id);
                        } catch (e: any) {
                            logWarn(`could not stop plugin "${m.id}" before writing its config: ${e?.message ?? e}`);
                        }
                    }
                    return stopped;
                },
                // Receive-side platform gate: don't materialise desktop-only
                // plugins on a mobile device. Mirrors the getPlatform wiring.
                getIsMobile: () => Platform.isMobile,
                // Bindings persist their settings entry (cipher floor, setup
                // flag, the DB's passphrase).
                saveSettings: () => this.saveSettings(),
                // Join asks when none of the passphrases at hand unlocks the
                // DB; the modal checks each answer and stays open on a wrong
                // one.
                askPassphrase: (reason, tryUnlock) => new PassphraseModal(
                    this.app, false,
                    (reason === "missing"
                        ? "This config database is encrypted, and no passphrase is set on this device. "
                        : "The passphrases set on this device do not unlock this config database. ") +
                        "Enter the passphrase it was set up with.",
                    {
                        validate: async (p) => (await tryUnlock(p))
                            ? null
                            : "This passphrase does not unlock the config database.",
                    },
                ).waitForResult(),
            },
        );
        // Remove the local config store of the layout before config
        // bindings for the applied config DB (`couchsync-<vault>-config-<db>`,
        // exact name, see `legacyConfigStoreName`): the storage half of the
        // migration whose settings half ran in loadSettings. Idempotent; not
        // awaited — a store another window holds open would block the delete
        // until it closes.
        void deleteLegacyConfigStore(vaultName, this.settings.couchdbConfigDbName)
            .catch((e: any) => {
                logWarn(`could not delete the old local config store (retried next load): ${e?.message ?? e}`);
            });
        // Open the binding for the applied config DB name (no-op when empty).
        // Apply in the settings tab calls rebind again at runtime.
        // A config store that fails to open (e.g. schema stamp mismatch)
        // leaves config sync unbound — every config op then says so — but
        // must not take vault sync down with it.
        try {
            await this.configSync.rebind(this.settings.couchdbConfigDbName || null);
        } catch (e: any) {
            logError(
                `could not open the local config store for ` +
                `"${this.settings.couchdbConfigDbName}": ${e?.message ?? e}`,
            );
            notify(
                "config sync is inactive — its local store could not be " +
                    "opened. See the log.",
                10000,
            );
        }
        this.statusBar = new StatusBar(
            this,
            () => this.settings,
            () => this.replicator.getLastHealthyAt(),
            () => this.replicator.getLastErrorDetail(),
        );
        this.replicator.events.on("state-change", ({ state }) => this.statusBar.update(state));
        // Single notify authority. Only user-actionable errors warrant
        // a Notice; transient kinds (network / timeout / aborted / server /
        // not-found) auto-recover and are shown via the status bar alone —
        // toasting every blip was the spurious resume-notification noise.
        // encryption-paused additionally re-runs the onload reconcile,
        // preserving the local-state pass the old onload gate did on pause.
        this.replicator.events.on("error", ({ message, kind }) => {
            const userActionable =
                kind === "auth" || kind === "schema-mismatch" || kind === "encryption-paused";
            if (userActionable) {
                notify(message, kind === "auth" ? 8000 : 15000);
            }
            if (kind === "encryption-paused") {
                this.fireReconcile("onload");
            }
        });
        // Local DB handle is poisoned (typically iOS WebKit IDB after a
        // long suspend — only a page reload reseats the IDB connection).
        // Surface a sticky Notice with a "Reload now" button that fires
        // `app:reload`; emitted at most once per SyncEngine lifecycle.
        this.replicator.events.on("degraded", ({ message }) => {
            const notice = showNotice(`${message} Tap "Reload now" to recover.`, 0);
            const btn = notice.noticeEl.createEl("button", {
                text: "Reload now",
                cls: "mod-cta",
            });
            btn.style.marginLeft = "8px";
            btn.addEventListener("click", () => {
                notice.hide();
                (this.app as any).commands.executeCommandById("app:reload");
            });
        });
        this.reconciler = new Reconciler(
            vaultIO,
            this.localDb,
            this.vaultSync,
            () => this.settings,
            (msg) => notify(msg),
            this.replicator.pendingApply,
        );
        this.setupService = new SetupService(
            vaultIO, this.localDb, this.remoteOps, this.vaultSync, this.reconciler,
        );
        this.historyManager = new HistoryManager(
            vaultIO, this.historyStorage, this.historyCapture, () => this.settings,
        );
        this.logStorage = new LogStorage(vaultName);
        await this.logStorage.ensureSchemaVersion();
        this.logManager = new LogManager({
            storage: this.logStorage,
            getSettings: () => this.settings,
            getPluginVersion: () => this.manifest.version,
            getObsidianVersion: () => apiVersion,
            getPlatform: () => ({
                os: this.deriveOsLabel(),
                isMobile: Platform.isMobile,
            }),
            getDeviceInfo: () => this.collectDeviceInfo(),
            getSyncDiagnostics: () => {
                const snap = this.replicator.getDiagnosticsSnapshot();
                return {
                    state: snap.state,
                    connectionState: this.settings.connectionState,
                    lastPushedSeq: typeof snap.lastPushedSeq === "number" ? snap.lastPushedSeq : undefined,
                    remoteSeq: typeof snap.remoteSeq === "string" ? snap.remoteSeq : String(snap.remoteSeq),
                };
            },
            vault: vaultIO,
            doc: typeof document !== "undefined" ? document : undefined,
            win: typeof window !== "undefined" ? window : undefined,
        });
        this.conflictOrchestrator = new ConflictOrchestrator({
            modal: modalPresenter,
            localDb: this.localDb,
            replicator: this.replicator,
            historyCapture: this.historyCapture,
            dbToFile: (doc, opts) => this.vaultSync.dbToFile(doc, opts),
            getSettings: () => this.settings,
            vault: vaultIO,
            vaultSync: this.vaultSync,
        });
        this.conflictOrchestrator.register();
        this.reconciler.setConflictOrchestrator(this.conflictOrchestrator);

        // Pull-driven deletions are handled entirely inside the pull-writer
        // now: the unpushed-edit probe is the `probeUnpushed` DI wired
        // into SyncEngine below, and the deletion is applied through the same
        // durable accepted→pending-deletion→drain path as a soft-delete rather
        // than the former tx-external applyRemoteDeletion in this handler.

        // Reconcile AFTER catchup completes — never concurrent with pull.
        // This ordering guarantees reconcile sees the latest DB state.
        this.replicator.events.on("catchup-complete", () => this.fireReconcile("onload"));
        this.replicator.events.on("catchup-failed", () => this.fireReconcile("onload"));

        // Pull-write skip leaves LocalDB ahead of vault for N files.
        // Without this trigger, idle longpoll persists divergent state
        // until the next visibility/reconnect cycle. Fire reconcile so
        // dbToFile retries on the next pass — typically resolves the
        // divergence within seconds rather than hours.
        this.replicator.events.on("pull-skipped", () => this.fireReconcile("paused"));

        // Run orphan-chunk GC once after the first idle (catchup done,
        // no pending pull/push). Cleans up chunks left by pre-v0.15
        // non-atomic writes and stale content changes.
        this.replicator.events.onceIdle(() => {
            gcOrphanChunks(this.localDb).catch((e) =>
                logError(`Chunk GC failed: ${e?.message ?? e}`),
            );
        });

        this.addSettingTab(new CouchSyncSettingTab(this.app, this));

        this.registerView(VIEW_TYPE_DIFF_HISTORY, (leaf) => new DiffHistoryView(leaf, this));
        this.registerView(VIEW_TYPE_LOG, (leaf) => new LogView(leaf));

        this.addRibbonIcon("history", "Diff History", () => {
            this.activateHistoryView();
        });

        registerCommands(this);

        this.app.workspace.onLayoutReady(async () => {
            this.historyCapture.setOnDiffSaved((filePath) => {
                (this.app.workspace as any).trigger("couchsync:diff-saved", filePath);
            });
            this.historyCapture.start();
            this.historyManager.startCleanup();
            this.logManager.start();
            // Startup declaration — first persisted line of every session's log.
            // Pins exactly which build is running (version, build time, commit)
            // so a field report's log self-identifies. Logged right after
            // logManager.start() so it lands in the persistent buffer. typeof
            // guards keep it safe in the test runtime (build-time defines absent).
            {
                const built = typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "unknown";
                const commit = typeof __COMMIT_HASH__ !== "undefined" ? __COMMIT_HASH__ : "unknown";
                logInfo(`Starting v${this.manifest.version} — built ${built}, commit ${commit}`);
            }
            this.compositionTracker.start();
            this.compositionGate.start();

            // One-time notice after the legacy configSyncPaths → configSyncPolicy
            // migration. Surfaces the safe-side behaviour change (plugin code is
            // no longer synced) so it isn't silent. Cleared immediately so it
            // shows once.
            if (this.settings.configSyncPolicyMigrated) {
                this.settings.configSyncPolicyMigrated = false;
                await this.saveSettings();
                showNotice(
                    "Config sync filtering was upgraded to a " +
                    "meaning-based model. Plugin executable code is no longer " +
                    "synced by default (safety). Review Settings → Config Sync.",
                    12000,
                );
            }

            // Unlock the vault key FIRST, before the legacy guard: the
            // recovery the guard asks for (Vault Init) must mint HMAC chunk
            // ids on an encrypted vault, which needs the key. A failure
            // falls through — the guard runs anyway, and the live session's
            // agreement check judges the vault.
            //
            // The config key is not derived here: the config DB is its own
            // crypto principal and its key must not depend on the vault's
            // connectionState. Every config op unlocks it in the binding's
            // preflight (or Join / Create).
            if (this.settings.connectionState === "syncing" && this.settings.deviceId) {
                await this.vaultBinding.unlockAtStartup();
            }

            // Schema guard. Two checks:
            //
            //   1. The vault DB must NOT contain bare-path docs, missing
            //      vclock FileDocs, or `config:*` orphans (the latter
            //      indicates a pre-v0.11.0 DB where configs lived in
            //      the vault store and need migration).
            //   2. The config DB (if configured) must NOT contain
            //      non-config docs or vclock-less ConfigDocs.
            //
            // If either check fails we block replicator.start() and tell
            // the user to use the Maintenance tab to migrate / rebuild.
            try {
                const vaultLegacy = await this.localDb.findLegacyVaultDoc();
                if (vaultLegacy) {
                    const isConfigOrphan = vaultLegacy.startsWith("config:");
                    const message = isConfigOrphan
                        ? `legacy config doc found in vault DB (${vaultLegacy}). ` +
                            "Open Settings → Maintenance → Clean up legacy configs from vault DB " +
                            "after running Create (and Push) in Config Sync. Sync is paused until then."
                        : `old schema detected in vault DB (${vaultLegacy}). ` +
                            "Open Settings → Maintenance → Delete local vault database, " +
                            "then re-run Init or Clone. Sync is paused until then.";
                    notify(message, 15000);
                    logWarn(
                        `blocking replicator.start() — legacy vault doc: ${vaultLegacy}`,
                    );
                    this.fireReconcile("onload");
                    return;
                }

                const configStore = this.configLocalDb;
                if (configStore) {
                    const configLegacy = await configStore.findLegacyConfigDoc();
                    if (configLegacy) {
                        notify(
                            `old schema detected in config DB (${configLegacy}). ` +
                                "Open Settings → Maintenance → Delete local config database, " +
                                "then Join (or Create) and Pull in Config Sync. Sync is paused until then.",
                            15000,
                        );
                        logWarn(
                            `blocking replicator.start() — legacy config doc: ${configLegacy}`,
                        );
                        this.fireReconcile("onload");
                        return;
                    }
                }
            } catch (e) {
                logError(`schema guard probe failed: ${e?.message ?? e}`);
            }

            if (!this.settings.deviceId) {
                notify(
                    "Please set a device name (Settings → Vault Sync). " +
                        "Sync will not start until a device name is configured.",
                    15000,
                );
            } else if (this.isLegacyDeviceId(this.settings.deviceId)) {
                notify(
                    "Please set a device name (Settings → Vault Sync). " +
                        "Currently using an auto-generated ID.",
                    10000,
                );
            }

            // E2E encryption agreement + passphrase unlock now runs inside the
            // SyncEngine session as the supervised agreement check
            // (`VaultBinding.checkAgreement`), NOT as an unsupervised onload
            // gate. The old gate's catch `return`ed on a transient fetch
            // failure and left sync permanently dead until a manual reload.
            // Funnelling the single gate through openSession means a
            // network blip now throws into the retry loop and auto-recovers
            // when the network returns; user-actionable states pause via the
            // encryption-paused terminal kind. So onload just starts the
            // engine — start() → openSession → agreement.check does the rest.

            // Load vclock cache BEFORE reconciler or changeTracker run.
            // Without this, compareFileToDoc() misclassifies local edits
            // as "remote-pending" and overwrites them with stale DB content.
            await this.vaultSync.loadLastSyncedVclocks();

            if (this.settings.connectionState === "syncing" && this.settings.deviceId) {
                this.replicator.start();
                this.changeTracker.start();
                // Reconcile fires via onCatchupComplete/onCatchupFailed.
            } else {
                // Sync disabled: no catchup, reconcile directly.
                this.fireReconcile("onload");
            }
        });

    }

    async onunload(): Promise<void> {
        this.changeTracker?.stop();
        this.historyCapture?.stop();
        this.historyManager?.stopCleanup();
        this.logManager?.stop();
        this.vaultWriter?.flushAll();
        this.compositionGate?.stop();
        this.compositionTracker?.stop();
        this.replicator?.stop();
        await this.vaultSync?.teardown();
        // Latch disposal, then drain any in-flight reconcile BEFORE closing
        // localDb — otherwise a mid-flight vclock-adopt/restore writes through
        // a torn-down handle (DatabaseClosedError). destroy() stops new runs;
        // settle() waits for the current one.
        this.reconciler?.destroy();
        await this.reconciler?.settle();
        this.statusBar?.destroy();
        this.historyStorage?.close();
        this.logStorage?.close();
        await this.localDb?.close();
        try {
            await this.configSync?.close();
        } catch (e) {
            logError(`failed to close config local DB: ${e?.message ?? e}`);
        }
    }

    async loadSettings(): Promise<void> {
        const data = (await this.loadData()) ?? {};
        migrateSettings(data);
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    /** True if the deviceId looks like an auto-generated UUID (pre-v0.12). */
    isLegacyDeviceId(id: string): boolean {
        return /^[0-9a-f]{8}-/.test(id);
    }

    /** Start the live session when the vault is set up for it. The setup
     *  state itself is changed by `vaultBinding` only. */
    async startSync(): Promise<void> {
        if (this.settings.connectionState !== "syncing") return;
        if (!this.settings.deviceId) {
            notify("Set a device name before starting sync.");
            return;
        }
        await this.vaultSync.loadLastSyncedVclocks();
        this.replicator.stop();
        this.replicator.start();
        this.changeTracker.start();
        // Reconcile fires via onCatchupComplete.
    }

    stopSync(): void {
        this.replicator.stop();
        this.changeTracker.stop();
    }

    private fireReconcile(reason: ReconcileReason): void {
        this.reconciler.reconcile(reason).catch((e) =>
            logError(`${reason} reconcile failed: ${e?.message ?? e}`),
        );
    }

    async activateLogView(): Promise<void> {
        const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_LOG);
        if (existing.length > 0) {
            this.app.workspace.revealLeaf(existing[0]);
            return;
        }
        const leaf = this.app.workspace.getRightLeaf(false);
        if (leaf) {
            await leaf.setViewState({ type: VIEW_TYPE_LOG, active: true });
            this.app.workspace.revealLeaf(leaf);
        }
    }

    async activateHistoryView(): Promise<void> {
        const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_DIFF_HISTORY);
        if (existing.length > 0) {
            this.app.workspace.revealLeaf(existing[0]);
            return;
        }
        const leaf = this.app.workspace.getRightLeaf(false);
        if (leaf) {
            await leaf.setViewState({ type: VIEW_TYPE_DIFF_HISTORY, active: true });
            this.app.workspace.revealLeaf(leaf);
        }
    }

    async showHistory(filePath: string): Promise<void> {
        await this.activateHistoryView();
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_DIFF_HISTORY);
        if (leaves.length > 0) {
            const view = leaves[0].view as DiffHistoryView;
            await view.showFileHistory(filePath);
        }
    }

    async restoreFromHistory(filePath: string, recordId: number): Promise<boolean> {
        this.changeTracker.ignoreNextModify(filePath);
        const content = await this.historyManager.restoreToRecord(filePath, recordId);
        if (content === null) return false;
        try {
            await this.vaultSync.forceLocalEdit(filePath, {});
        } catch {
            // Sync propagation failure is non-fatal — file is already restored on disk.
        }
        return true;
    }
}
