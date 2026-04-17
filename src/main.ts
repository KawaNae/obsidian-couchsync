import { Notice, Platform, Plugin } from "obsidian";
import { type CouchSyncSettings, DEFAULT_SETTINGS } from "./settings.ts";
import { LocalDB } from "./db/local-db.ts";
import { ConfigLocalDB } from "./db/config-local-db.ts";
import { DexieStore } from "./db/dexie-store.ts";
import { SyncEngine } from "./db/sync-engine.ts";
import { AuthGate } from "./db/sync/auth-gate.ts";
import { VaultRemoteOps } from "./db/sync/vault-remote-ops.ts";
import { VaultSync } from "./sync/vault-sync.ts";
import { ConfigSync } from "./sync/config-sync.ts";
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
import { DiffHistoryView, VIEW_TYPE_DIFF_HISTORY } from "./ui/history-view.ts";
import { LogView, VIEW_TYPE_LOG } from "./ui/log-view.ts";
import { migrateSettings } from "./settings-migration.ts";
import { registerCommands } from "./commands.ts";
import { gcOrphanChunks } from "./db/chunk-gc.ts";
import { ObsidianVaultIO } from "./adapters/obsidian-vault-io.ts";
import { ObsidianAdapterIO } from "./adapters/obsidian-adapter-io.ts";
import { ObsidianVaultEvents } from "./adapters/obsidian-vault-events.ts";
import { ObsidianModalPresenter } from "./adapters/obsidian-modal-presenter.ts";

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
    statusBar!: StatusBar;
    private conflictOrchestrator!: ConflictOrchestrator;

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
            this.configLocalDb = new ConfigLocalDB(
                new DexieStore(configLocalName),
            );
        }

        initLog(
            () => this.settings,
            (msg, dur) => new Notice(`CouchSync: ${msg}`, dur),
        );
        const vaultIO = new ObsidianVaultIO(this.app);
        const adapterIO = new ObsidianAdapterIO(this.app);
        const vaultEvents = new ObsidianVaultEvents(this.app);
        const modalPresenter = new ObsidianModalPresenter(this.app);

        this.auth = new AuthGate();
        this.remoteOps = new VaultRemoteOps(this.localDb, () => this.settings, this.auth);
        this.replicator = new SyncEngine(this.localDb, () => this.settings, Platform.isMobile, this.auth);
        this.historyStorage = new HistoryStorage(this.app.vault.getName());
        this.historyCapture = new HistoryCapture(vaultIO, vaultEvents, this.historyStorage, () => this.settings);
        this.vaultSync = new VaultSync(vaultIO, this.localDb, () => this.settings, this.historyCapture);
        this.changeTracker = new ChangeTracker(vaultEvents, this.vaultSync, () => this.settings);
        this.vaultSync.setWriteIgnore(this.changeTracker);
        this.configSync = new ConfigSync(adapterIO, modalPresenter, this.configLocalDb, this.auth, () => this.settings);
        this.statusBar = new StatusBar(
            this,
            () => this.settings,
            () => this.replicator.getLastHealthyAt(),
            () => this.replicator.getLastErrorDetail(),
        );
        this.replicator.events.on("state-change", ({ state }) => this.statusBar.update(state));
        this.replicator.events.on("error", ({ message }) => notify(message, 8000));
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
        this.conflictOrchestrator = new ConflictOrchestrator({
            modal: modalPresenter,
            localDb: this.localDb,
            replicator: this.replicator,
            historyCapture: this.historyCapture,
            dbToFile: (doc) => this.vaultSync.dbToFile(doc),
            getSettings: () => this.settings,
        });
        this.conflictOrchestrator.register();

        // Pull-driven vault writes: accepted FileDocs are written directly
        // to vault in the pull path. Reconciler handles only drift detection.
        this.replicator.events.onAsync("pull-write", async ({ doc }) => {
            await this.vaultSync.dbToFile(doc);
        });

        // Pull-driven deletions: if the remote deleted a file, apply
        // locally unless there are unpushed local edits (→ concurrent).
        this.replicator.events.onQuery("pull-delete", async ({ path, localDoc }) => {
            if (this.vaultSync.hasUnpushedChanges(path, localDoc.vclock)) {
                return true; // → concurrent conflict
            }
            await this.vaultSync.applyRemoteDeletion(path);
            return false;
        });

        // Reconcile AFTER catchup completes — never concurrent with pull.
        // This ordering guarantees reconcile sees the latest DB state.
        this.replicator.events.on("catchup-complete", () => this.fireReconcile("onload"));
        this.replicator.events.on("catchup-failed", () => this.fireReconcile("onload"));

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
        this.replicator?.stop();
        await this.vaultSync?.teardown();
        this.reconciler?.destroy();
        this.statusBar?.destroy();
        this.historyStorage?.close();
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
