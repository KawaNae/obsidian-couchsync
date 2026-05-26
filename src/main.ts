import { Notice, Platform, Plugin, apiVersion } from "obsidian";
import { type CouchSyncSettings, DEFAULT_SETTINGS } from "./settings.ts";
import { LocalDB } from "./db/local-db.ts";
import { ConfigLocalDB } from "./db/config-local-db.ts";
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
import { initLog, logError, logWarn, notify } from "./ui/log.ts";
import { CouchSyncSettingTab } from "./settings-tab/index.ts";
import { ProgressNotice } from "./ui/notices.ts";
import { HistoryStorage } from "./history/storage.ts";
import { HistoryCapture } from "./history/history-capture.ts";
import { HistoryManager } from "./history/history-manager.ts";
import { LogStorage } from "./log/log-storage.ts";
import { LogManager } from "./log/log-manager.ts";
import { DiffHistoryView, VIEW_TYPE_DIFF_HISTORY } from "./ui/history-view.ts";
import { LogView, VIEW_TYPE_LOG } from "./ui/log-view.ts";
import { migrateSettings } from "./settings-migration.ts";
import { registerCommands } from "./commands.ts";
import { gcOrphanChunks } from "./db/chunk-gc.ts";
import { ObsidianVaultIO } from "./adapters/obsidian-vault-io.ts";
import { ObsidianAdapterIO } from "./adapters/obsidian-adapter-io.ts";
import { ObsidianVaultEvents } from "./adapters/obsidian-vault-events.ts";
import { ObsidianModalPresenter } from "./adapters/obsidian-modal-presenter.ts";
import { ObsidianCompositionTracker } from "./adapters/obsidian-composition-tracker.ts";
import { EditorAwareVaultWriter } from "./adapters/editor-aware-vault-writer.ts";
import { CompositionGate } from "./sync/composition-gate.ts";
import type { CryptoProvider } from "./db/crypto-provider.ts";
import { computeHash, type ChunkHashFn } from "./db/chunker.ts";
import { EncryptingCouchClient } from "./db/encrypting-couch-client.ts";
import { makeCouchClient } from "./db/couch-client.ts";
import { fetchEncryptionMeta, unlockWithPassphrase, deriveEncryption, pushEncryptionMeta } from "./db/encryption-meta.ts";
import { PassphraseModal } from "./ui/passphrase-modal.ts";
import type { ICouchClient } from "./db/interfaces.ts";

export default class CouchSyncPlugin extends Plugin {
    settings!: CouchSyncSettings;
    localDb!: LocalDB;
    /** Null when `couchdbConfigDbName === ""` (config sync disabled) */
    configLocalDb: ConfigLocalDB | null = null;
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
    private cryptoProvider?: CryptoProvider;

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
                    "CouchSync: this vault may have been copied from another installation. " +
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

        // Open the config-side local store only when the user has set
        // a config DB name. The local store is keyed by both vault name
        // and config DB name so switching device pools (e.g. mobile ↔
        // desktop) creates a fresh local store rather than mixing.
        if (this.settings.couchdbConfigDbName) {
            const configLocalName =
                `couchsync-${vaultName}-config-${this.settings.couchdbConfigDbName}`;
            this.configLocalDb = new ConfigLocalDB(configLocalName);
            this.configLocalDb.open();
        }

        initLog(
            () => this.settings,
            (msg, dur) => new Notice(`CouchSync: ${msg}`, dur),
        );
        const vaultIO = new ObsidianVaultIO(this.app);
        const adapterIO = new ObsidianAdapterIO(this.app);
        const vaultEvents = new ObsidianVaultEvents(this.app);
        this.modalPresenter = new ObsidianModalPresenter(this.app);
        const modalPresenter = this.modalPresenter;

        this.auth = new AuthGate();
        this.remoteOps = new VaultRemoteOps(this.localDb, () => this.settings, this.auth);
        this.historyStorage = new HistoryStorage(this.app.vault.getName());
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
        const hashFn: ChunkHashFn = (data) =>
            this.cryptoProvider
                ? this.cryptoProvider.hmacHash(data)
                : computeHash(data);
        this.vaultSync = new VaultSync(vaultIO, this.localDb, () => this.settings, this.vaultWriter, hashFn);
        this.changeTracker = new ChangeTracker(vaultEvents, this.vaultSync, () => this.settings);
        // Late-bind the writeIgnore once ChangeTracker exists. It is
        // used by VaultWriter only on the deletion path (the modify
        // path now relies on chunksEqual idempotency in fileToDb).
        this.vaultWriter.setWriteIgnore(this.changeTracker);
        // Late-bind the pending-edit probe (invariant 4). VaultSync uses
        // it from `hasUnpushedChanges` to detect debounced user edits
        // before applying a remote deletion.
        this.vaultSync.setPendingProbe(this.changeTracker);
        // SyncEngine constructed AFTER vaultSync so the pull-writer can
        // call vaultSync.dbToFile directly via constructor DI (replaces
        // the former events.onAsync("pull-write", ...) bus, whose catch-
        // all swallowed write errors and let `Pull: N written` lie).
        const encClientFactory: (s: CouchSyncSettings) => ICouchClient = (s) => {
            const raw = makeCouchClient(s.couchdbUri, s.couchdbDbName, s.couchdbUser, s.couchdbPassword);
            return this.cryptoProvider
                ? new EncryptingCouchClient(raw, this.cryptoProvider)
                : raw;
        };
        this.replicator = new SyncEngine(
            this.localDb,
            () => this.settings,
            (doc) => this.vaultSync.dbToFile(doc),
            Platform.isMobile,
            this.auth,
            encClientFactory,
        );
        const reconnectBridge: ReconnectBridge = {
            notifyTransient: () => {
                // Fire-and-forget: ConfigSync surfaces the original error to
                // the user via ProgressNotice/log; this only nudges the
                // vault session to verify reachability if it itself is
                // unhealthy. decideReconnect skips when vault is healthy.
                this.replicator.requestReconnect("config-failure").catch((e: any) =>
                    logError(`CouchSync: config-failure reconnect failed: ${e?.message ?? e}`),
                );
            },
        };
        const encConfigClientFactory = (s: CouchSyncSettings): ICouchClient | null => {
            if (!s.couchdbConfigDbName) return null;
            const raw = makeCouchClient(s.couchdbUri, s.couchdbConfigDbName, s.couchdbUser, s.couchdbPassword);
            return this.cryptoProvider
                ? new EncryptingCouchClient(raw, this.cryptoProvider)
                : raw;
        };
        this.configSync = new ConfigSync(
            adapterIO,
            modalPresenter,
            this.configLocalDb,
            this.auth,
            this.replicator.getVisibilityGate(),
            reconnectBridge,
            () => this.settings,
            encConfigClientFactory,
        );
        this.statusBar = new StatusBar(
            this,
            () => this.settings,
            () => this.replicator.getLastHealthyAt(),
            () => this.replicator.getLastErrorDetail(),
        );
        this.replicator.events.on("state-change", ({ state }) => this.statusBar.update(state));
        this.replicator.events.on("error", ({ message }) => notify(message, 8000));
        // Local DB handle is poisoned (typically iOS WebKit IDB after a
        // long suspend — only a page reload reseats the IDB connection).
        // Surface a sticky Notice with a "Reload now" button that fires
        // `app:reload`; emitted at most once per SyncEngine lifecycle.
        this.replicator.events.on("degraded", ({ message }) => {
            const notice = new Notice(`${message} Tap "Reload now" to recover.`, 0);
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
            (doc) => this.replicator.ensureFileChunks(doc),
        );
        this.setupService = new SetupService(
            vaultIO, this.localDb, this.remoteOps, this.vaultSync, this.reconciler,
        );
        this.historyManager = new HistoryManager(
            vaultIO, this.historyStorage, this.historyCapture, () => this.settings,
        );
        this.logStorage = new LogStorage(vaultName);
        this.logManager = new LogManager({
            storage: this.logStorage,
            getSettings: () => this.settings,
            getPluginVersion: () => this.manifest.version,
            getObsidianVersion: () => apiVersion,
            getPlatform: () => ({
                os: typeof process !== "undefined" && process.platform ? process.platform : "unknown",
                isMobile: Platform.isMobile,
            }),
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
            dbToFile: (doc) => this.vaultSync.dbToFile(doc),
            getSettings: () => this.settings,
            vault: vaultIO,
            vaultSync: this.vaultSync,
        });
        this.conflictOrchestrator.register();
        this.reconciler.setConflictOrchestrator(this.conflictOrchestrator);

        // Pull-driven deletions: if the remote deleted a file, apply
        // locally unless there are unpushed local edits (→ concurrent).
        // PR-B: hasUnpushedChanges is now chunks-aware (invariant 4)
        // and looks at the actual vault disk + ChangeTracker pending
        // state, not the in-lockstep vclock pair. Catches the silent
        // loss race where a remote tombstone arrives during the
        // ChangeTracker debounce window for a fresh user edit.
        this.replicator.events.onQuery("pull-delete", async ({ path }) => {
            if (await this.vaultSync.hasUnpushedChanges(path)) {
                return true; // → concurrent conflict
            }
            await this.vaultSync.applyRemoteDeletion(path);
            return false;
        });

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
            this.historyCapture.start();
            this.historyManager.startCleanup();
            this.logManager.start();
            this.compositionTracker.start();
            this.compositionGate.start();

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
                        ? `CouchSync: legacy config doc found in vault DB (${vaultLegacy}). ` +
                            "Open Settings → Maintenance → Clean up legacy configs from vault DB " +
                            "after running Config Init in Config Sync. Sync is paused until then."
                        : `CouchSync: old schema detected in vault DB (${vaultLegacy}). ` +
                            "Open Settings → Maintenance → Delete local vault database, " +
                            "then re-run Init or Clone. Sync is paused until then.";
                    notify(message, 15000);
                    logWarn(
                        `CouchSync: blocking replicator.start() — legacy vault doc: ${vaultLegacy}`,
                    );
                    this.fireReconcile("onload");
                    return;
                }

                if (this.configLocalDb) {
                    const configLegacy = await this.configLocalDb.findLegacyConfigDoc();
                    if (configLegacy) {
                        notify(
                            `CouchSync: old schema detected in config DB (${configLegacy}). ` +
                                "Open Settings → Maintenance → Delete local config database, " +
                                "then re-run Config Init or Pull. Sync is paused until then.",
                            15000,
                        );
                        logWarn(
                            `CouchSync: blocking replicator.start() — legacy config doc: ${configLegacy}`,
                        );
                        this.fireReconcile("onload");
                        return;
                    }
                }
            } catch (e) {
                logError(`CouchSync: schema guard probe failed: ${e?.message ?? e}`);
            }

            if (!this.settings.deviceId) {
                notify(
                    "CouchSync: Please set a device name (Settings → Vault Sync). " +
                        "Sync will not start until a device name is configured.",
                    15000,
                );
            } else if (this.isLegacyDeviceId(this.settings.deviceId)) {
                notify(
                    "CouchSync: Please set a device name (Settings → Vault Sync). " +
                        "Currently using an auto-generated ID.",
                    10000,
                );
            }

            // E2E encryption: require passphrase before sync starts.
            if (this.settings.encryptionEnabled && !this.cryptoProvider) {
                try {
                    const rawClient = makeCouchClient(
                        this.settings.couchdbUri,
                        this.settings.couchdbDbName,
                        this.settings.couchdbUser,
                        this.settings.couchdbPassword,
                    );
                    const meta = await fetchEncryptionMeta(rawClient);
                    if (!meta) {
                        notify("CouchSync: encryption:meta doc not found on server. Re-enable encryption from Settings.", 10000);
                        return;
                    }
                    const modal = new PassphraseModal(this.app, false);
                    const passphrase = await modal.waitForResult();
                    if (!passphrase) {
                        notify("CouchSync: passphrase required. Sync paused.", 8000);
                        return;
                    }
                    const result = await unlockWithPassphrase(meta, passphrase);
                    if (!result) {
                        notify("CouchSync: wrong passphrase. Sync paused.", 8000);
                        return;
                    }
                    this.cryptoProvider = result.crypto;
                    this.remoteOps.setClientWrapper((raw) =>
                        new EncryptingCouchClient(raw, this.cryptoProvider!));
                } catch (e: any) {
                    logError(`CouchSync: encryption unlock failed: ${e?.message ?? e}`);
                    return;
                }
            }

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
        this.reconciler?.destroy();
        this.statusBar?.destroy();
        this.historyStorage?.close();
        this.logStorage?.close();
        await this.localDb?.close();
        if (this.configLocalDb) {
            try {
                await this.configLocalDb.close();
            } catch (e) {
                logError(`CouchSync: failed to close config local DB: ${e?.message ?? e}`);
            }
            this.configLocalDb = null;
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

    async initVault(): Promise<void> {
        if (this.settings.encryptionEnabled && !this.cryptoProvider) {
            throw new Error("Encryption is enabled but passphrase not entered. Enter passphrase first.");
        }
        this.replicator.stop();
        this.changeTracker.stop();
        const progress = new ProgressNotice("Init");
        try {
            const result = await this.setupService.init((msg) => progress.update(msg));
            this.settings.connectionState = "setupDone";
            await this.saveSettings();
            progress.done(`Init complete! ${result.vaultFiles} files, ${result.totalDocs} docs pushed.`);
        } catch (e: any) {
            progress.fail(`Init failed: ${e?.message ?? e}`);
            throw e;
        }
    }

    async cloneFromRemote(): Promise<void> {
        if (this.settings.encryptionEnabled && !this.cryptoProvider) {
            throw new Error("Encryption is enabled but passphrase not entered. Enter passphrase first.");
        }
        this.replicator.stop();
        this.changeTracker.stop();
        const progress = new ProgressNotice("Clone");
        try {
            const result = await this.setupService.clone((msg) => progress.update(msg));
            this.settings.connectionState = "setupDone";
            await this.saveSettings();
            progress.done(`Clone complete! ${result.vaultFiles} files written.`);
        } catch (e: any) {
            progress.fail(`Clone failed: ${e?.message ?? e}`);
            throw e;
        }
    }

    async startSync(): Promise<void> {
        if (this.settings.connectionState !== "syncing") return;
        if (!this.settings.deviceId) {
            notify("CouchSync: Set a device name before starting sync.");
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

    async enableEncryption(passphrase: string): Promise<void> {
        this.stopSync();
        const progress = new ProgressNotice("Encryption");
        try {
            progress.update("Deriving encryption keys...");
            const { meta, crypto } = await deriveEncryption(passphrase);
            this.cryptoProvider = crypto;
            this.remoteOps.setClientWrapper((raw) =>
                new EncryptingCouchClient(raw, this.cryptoProvider!));

            progress.update("Re-initializing vault with encryption...");
            await this.setupService.init((msg) => progress.update(msg));

            progress.update("Writing encryption metadata...");
            await pushEncryptionMeta(this.remoteOps.makeClient(), meta);

            this.settings.encryptionEnabled = true;
            this.settings.connectionState = "setupDone";
            await this.saveSettings();
            progress.done("Encryption enabled!");
        } catch (e: any) {
            progress.fail(`Enable encryption failed: ${e?.message ?? e}`);
            throw e;
        }
    }

    async disableEncryption(): Promise<void> {
        this.stopSync();
        const progress = new ProgressNotice("Encryption");
        try {
            this.cryptoProvider = undefined;
            this.remoteOps.setClientWrapper(undefined);

            progress.update("Re-initializing vault without encryption...");
            await this.setupService.init((msg) => progress.update(msg));

            this.settings.encryptionEnabled = false;
            this.settings.connectionState = "setupDone";
            await this.saveSettings();
            progress.done("Encryption disabled!");
        } catch (e: any) {
            progress.fail(`Disable encryption failed: ${e?.message ?? e}`);
            throw e;
        }
    }

    private fireReconcile(reason: ReconcileReason): void {
        this.reconciler.reconcile(reason).catch((e) =>
            logError(`CouchSync: ${reason} reconcile failed: ${e?.message ?? e}`),
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
}
