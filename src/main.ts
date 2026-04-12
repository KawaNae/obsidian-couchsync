import { Platform, Plugin } from "obsidian";
import { type CouchSyncSettings, DEFAULT_SETTINGS } from "./settings.ts";
import { LocalDB } from "./db/local-db.ts";
import { ConfigLocalDB } from "./db/config-local-db.ts";
import { DexieStore } from "./db/dexie-store.ts";
import { SyncEngine } from "./db/sync-engine.ts";
import { VaultSync } from "./sync/vault-sync.ts";
import { ConfigSync } from "./sync/config-sync.ts";
import { SetupService } from "./sync/setup.ts";
import { ChangeTracker } from "./sync/change-tracker.ts";
import { Reconciler, type ReconcileReason } from "./sync/reconciler.ts";
import { ConflictResolver } from "./conflict/conflict-resolver.ts";
import { checkInstallMarker } from "./sync/install-marker.ts";
import { StatusBar } from "./ui/status-bar.ts";
import { initLog } from "./ui/log.ts";
import { CouchSyncSettingTab } from "./settings-tab/index.ts";
import { showNotice, ProgressNotice } from "./ui/notices.ts";
import { HistoryStorage } from "./history/storage.ts";
import { HistoryCapture } from "./history/history-capture.ts";
import { HistoryManager } from "./history/history-manager.ts";
import { DiffHistoryView, VIEW_TYPE_DIFF_HISTORY } from "./ui/history-view.ts";
import { ConsistencyReportModal } from "./ui/consistency-report-modal.ts";
import { totalDiscrepancies } from "./sync/reconciler.ts";
import { isDiffableText } from "./utils/binary.ts";
import { joinChunks } from "./db/chunker.ts";

export default class CouchSyncPlugin extends Plugin {
    settings!: CouchSyncSettings;
    localDb!: LocalDB;
    /** Null when `couchdbConfigDbName === ""` (config sync disabled) */
    configLocalDb: ConfigLocalDB | null = null;
    replicator!: SyncEngine;
    conflictResolver!: ConflictResolver;
    /** Null when config sync is disabled */
    configConflictResolver: ConflictResolver | null = null;
    configSync!: ConfigSync;
    private vaultSync!: VaultSync;
    private setupService!: SetupService;
    private changeTracker!: ChangeTracker;
    private reconciler!: Reconciler;
    private historyStorage!: HistoryStorage;
    private historyCapture!: HistoryCapture;
    historyManager!: HistoryManager;
    statusBar!: StatusBar;

    async onload(): Promise<void> {
        await this.loadSettings();

        // Ensure previousDeviceIds exists (migration from pre-v0.12 settings)
        if (!this.settings.previousDeviceIds) {
            this.settings.previousDeviceIds = [];
        }

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
                showNotice(
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

        initLog(() => this.settings, showNotice);
        this.replicator = new SyncEngine(this.localDb, () => this.settings, Platform.isMobile);
        this.vaultSync = new VaultSync(this.app, this.localDb, () => this.settings);
        // ConfigSync needs *some* ConfigLocalDB even when sync is disabled,
        // so we satisfy the type with a stand-in backed by a throwaway store.
        // The runtime guard `isConfigured()` blocks all DB I/O before it
        // could touch the wrong store.
        const configDbForSync = this.configLocalDb ?? new ConfigLocalDB(
            new DexieStore(`${dbName}-config-stub`),
        );
        this.configSync = new ConfigSync(this.app, configDbForSync, this.replicator, () => this.settings);
        this.statusBar = new StatusBar(
            this,
            () => this.settings,
            () => this.replicator.getLastHealthyAt(),
            () => this.replicator.getLastErrorDetail(),
        );
        this.replicator.onStateChange((state) => this.statusBar.update(state));
        this.replicator.onError((msg) => showNotice(msg, 8000));
        this.reconciler = new Reconciler(
            this.app,
            this.localDb,
            this.vaultSync,
            () => this.settings,
            (msg) => showNotice(msg),
        );
        this.setupService = new SetupService(
            this.app, this.localDb, this.replicator, this.vaultSync, this.reconciler,
        );
        this.changeTracker = new ChangeTracker(this.app, this.vaultSync, () => this.settings);
        this.vaultSync.setChangeTracker(this.changeTracker);
        this.historyStorage = new HistoryStorage(this.app.vault.getName());
        this.historyCapture = new HistoryCapture(this.app, this.historyStorage, () => this.settings);
        this.vaultSync.setHistoryCapture(this.historyCapture);
        this.historyManager = new HistoryManager(
            this.app.vault, this.historyStorage, this.historyCapture, () => this.settings,
        );
        this.conflictResolver = new ConflictResolver(
            async (filePath, winnerDoc, loserDocs) => {
                // ConflictResolver passes us either FileDoc or ConfigDoc;
                // history capture only knows about file content, so we
                // narrow to FileDoc here. ConfigDoc auto-resolutions
                // are silently logged via the resolver's console.log.
                if (!("chunks" in winnerDoc)) return;
                try {
                    const winnerChunks = await this.localDb.getChunks(winnerDoc.chunks);
                    const winnerBuf = joinChunks(winnerChunks);
                    if (!isDiffableText(winnerBuf)) return;
                    const dec = new TextDecoder("utf-8");
                    const winnerText = dec.decode(winnerBuf);
                    for (const loser of loserDocs) {
                        if (!("chunks" in loser)) continue;
                        const loserChunks = await this.localDb.getChunks(loser.chunks);
                        const loserBuf = joinChunks(loserChunks);
                        if (!isDiffableText(loserBuf)) continue;
                        await this.historyCapture.saveConflict(
                            filePath,
                            dec.decode(loserBuf),
                            winnerText,
                        );
                    }
                    showNotice(
                        `Conflict auto-resolved: ${filePath.split("/").pop()}. Losing version(s) saved to history.`,
                    );
                } catch (e) {
                    console.error("CouchSync: Failed to save conflict to history:", e);
                }
            },
        );
        // Concurrent (VC-incomparable) conflicts need human judgment. For
        // now we raise a persistent Notice directing the user to history;
        // a Side-by-side diff modal is planned for the v2 design's Phase 3
        // work. Critically, we do NOT silently pick a winner.
        this.conflictResolver.setOnConcurrent(async (filePath, revisions) => {
            console.warn(
                `CouchSync: concurrent edit on ${filePath} — ${revisions.length} revisions, none dominate`,
            );
            // Persist every revision as a history entry so the user can
            // recover any version manually. Only FileDocs have chunks.
            try {
                const dec = new TextDecoder("utf-8");
                for (const rev of revisions) {
                    if (!("chunks" in rev)) continue;
                    const chunks = await this.localDb.getChunks(rev.chunks);
                    const buf = joinChunks(chunks);
                    if (!isDiffableText(buf)) continue;
                    await this.historyCapture.saveConflict(
                        filePath,
                        dec.decode(buf),
                        dec.decode(buf),
                    );
                }
            } catch (e) {
                console.error("CouchSync: Failed to persist concurrent-conflict history:", e);
            }
            showNotice(
                `CouchSync: concurrent edit on ${filePath.split("/").pop()} — ` +
                    "check Diff History and manually reconcile. No version has been silently dropped.",
                15000,
            );
        });

        // Config-side conflict resolver (only when config sync is enabled)
        if (this.configLocalDb) {
            this.configConflictResolver = new ConflictResolver(
                async (configPath, winnerDoc, _loserDocs) => {
                    // ConfigDoc auto-resolution: log + Notice. History
                    // capture is text-oriented (vault notes), so we don't
                    // try to push binary config blobs into Dexie.
                    showNotice(
                        `Config conflict auto-resolved: ${configPath.split("/").pop()}.`,
                        5000,
                    );
                },
            );
            this.configConflictResolver.setOnConcurrent(async (configPath, revisions) => {
                console.warn(
                    `CouchSync: concurrent config edit on ${configPath} — ${revisions.length} revisions, none dominate`,
                );
                showNotice(
                    `CouchSync: concurrent config edit on ${configPath.split("/").pop()} — ` +
                        "manual resolution needed. The config DB conflict tree is preserved.",
                    15000,
                );
            });
        }

        // Reconciler runs after every replication batch. The cursor + manifest
        // short-circuit makes the steady-state cost negligible.
        // In the SyncEngine architecture, Reconciler is the SOLE vault write
        // path — there is no onChange→dbToFile direct shortcut.
        this.replicator.onPaused(() => this.fireReconcile("paused"));

        this.addSettingTab(new CouchSyncSettingTab(this.app, this));

        this.registerView(VIEW_TYPE_DIFF_HISTORY, (leaf) => new DiffHistoryView(leaf, this));

        this.addRibbonIcon("history", "Diff History", () => {
            this.activateHistoryView();
        });

        this.addCommand({
            id: "couchsync-show-history",
            name: "Show file history",
            callback: () => {
                const file = this.app.workspace.getActiveFile();
                if (file) this.showHistory(file.path);
            },
        });

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
                    showNotice(message, 15000);
                    console.warn(
                        `CouchSync: blocking replicator.start() — legacy vault doc: ${vaultLegacy}`,
                    );
                    this.fireReconcile("onload");
                    return;
                }

                if (this.configLocalDb) {
                    const configLegacy = await this.configLocalDb.findLegacyConfigDoc();
                    if (configLegacy) {
                        showNotice(
                            `CouchSync: old schema detected in config DB (${configLegacy}). ` +
                                "Open Settings → Maintenance → Delete local config database, " +
                                "then re-run Config Init or Pull. Sync is paused until then.",
                            15000,
                        );
                        console.warn(
                            `CouchSync: blocking replicator.start() — legacy config doc: ${configLegacy}`,
                        );
                        this.fireReconcile("onload");
                        return;
                    }
                }
            } catch (e) {
                console.error("CouchSync: schema guard probe failed:", e);
            }

            if (!this.settings.deviceId) {
                showNotice(
                    "CouchSync: デバイス名を設定してください（Settings → Vault Sync）。" +
                        "設定するまで同期は開始されません。",
                    15000,
                );
            } else if (this.isLegacyDeviceId(this.settings.deviceId)) {
                showNotice(
                    "CouchSync: デバイス名を設定してください（Settings → Vault Sync）。" +
                        "現在は自動生成 ID を使用中です。",
                    10000,
                );
            }

            if (this.settings.connectionState === "syncing" && this.settings.deviceId) {
                this.replicator.start();
                this.changeTracker.start();
            }
            // Always reconcile on load: initialises the manifest on first run
            // and catches any drift accumulated while the plugin was offline.
            this.fireReconcile("onload");
        });

        // Foreground return: SyncEngine handles reconnect internally
        // (via handleVisibilityChange registered in start()). Reconcile
        // runs independently — it catches local vault ↔ local DB drift
        // regardless of whether the sync session was restarted.
        this.registerDomEvent(document, "visibilitychange", () => {
            if (
                document.visibilityState === "visible" &&
                this.settings.connectionState === "syncing"
            ) {
                this.fireReconcile("foreground");
            }
        });

        // Reconcile on network reconnection — runs independently of the
        // gateway's sync decision. Even if the gateway skipped the restart
        // (cool-down, auth latch), drift may have accumulated.
        this.replicator.onReconnect(() => {
            if (this.settings.connectionState === "syncing") {
                this.fireReconcile("reconnect");
            }
        });

        this.addCommand({
            id: "couchsync-force-sync",
            name: "Force sync all files now",
            callback: async () => {
                const report = await this.reconciler.reconcile("manual");
                if (this.settings.connectionState === "syncing") {
                    // Funnel through the gateway so this command honours
                    // the auth latch and cool-down like every other
                    // reconnect path.
                    await this.replicator.requestReconnect("manual");
                }
                const total =
                    report.pushed.length +
                    report.localWins.length +
                    report.remoteWins.length +
                    report.deleted.length +
                    report.restored.length;
                showNotice(`Force sync: ${total} change(s) applied.`);
            },
        });

        this.addCommand({
            id: "couchsync-verify-consistency",
            name: "Verify consistency (vault ↔ local DB ↔ remote)",
            callback: async () => {
                const progress = new ProgressNotice("Verify");
                try {
                    if (this.settings.connectionState === "syncing") {
                        progress.update("Pulling latest from remote...");
                        try {
                            await this.replicator.pullFromRemote();
                        } catch (e) {
                            console.warn("CouchSync: verify pull failed, continuing with local view:", e);
                        }
                    }
                    progress.update("Reconciling...");
                    const report = await this.reconciler.reconcile("manual", { mode: "report" });
                    const total = totalDiscrepancies(report);
                    progress.done(`Verify: ${total} discrepancy(ies)`);
                    new ConsistencyReportModal(this.app, report, async () => {
                        await this.reconciler.reconcile("manual-repair");
                    }).open();
                } catch (e: any) {
                    progress.done(`Verify failed: ${e.message ?? e}`);
                }
            },
        });

        // Config sync commands: each configSync.* call already owns a
        // ProgressNotice that summarises the result in its done() — the
        // command callbacks just invoke them and swallow the return value.
        this.addCommand({
            id: "couchsync-config-init",
            name: "Init config sync (clean rebuild)",
            callback: async () => {
                await this.configSync.init();
            },
        });

        this.addCommand({
            id: "couchsync-config-push",
            name: "Push config files to remote",
            callback: async () => {
                await this.configSync.push();
            },
        });

        this.addCommand({
            id: "couchsync-config-pull",
            name: "Pull config files from remote",
            callback: async () => {
                await this.configSync.pull();
            },
        });

        // Manual reconnect — surfaces the gateway's "manual" reason via
        // Command Palette so users can recover from any disconnected /
        // error state without opening Settings → Maintenance. Especially
        // useful on mobile when the visibilitychange path didn't fire
        // (e.g. the app was already foregrounded but the server was
        // briefly unavailable).
        this.addCommand({
            id: "couchsync-reconnect",
            name: "Reconnect sync",
            callback: async () => {
                if (this.replicator.isAuthBlocked()) {
                    showNotice(
                        "CouchSync: auth is blocked. Update credentials in " +
                            "Vault Sync (Step 1) before reconnecting.",
                        8000,
                    );
                    return;
                }
                if (this.settings.connectionState !== "syncing") {
                    showNotice(
                        "CouchSync: enable Live Sync in Vault Sync (Step 3) first.",
                        5000,
                    );
                    return;
                }
                await this.replicator.requestReconnect("manual");
                showNotice("CouchSync: reconnect requested.", 3000);
            },
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
                console.error("CouchSync: failed to close config local DB:", e);
            }
            this.configLocalDb = null;
        }
    }

    async loadSettings(): Promise<void> {
        const data = (await this.loadData()) ?? {};

        // Migrate old boolean flags to connectionState enum
        if (data.connectionState === undefined) {
            if (data.syncEnabled) data.connectionState = "syncing";
            else if (data.setupComplete) data.connectionState = "setupDone";
            else if (data.connectionTested) data.connectionState = "tested";
            else data.connectionState = "editing";
            delete data.connectionTested;
            delete data.setupComplete;
            delete data.syncEnabled;
        }

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
            showNotice("CouchSync: デバイス名を設定してから同期を開始してください。");
            return;
        }
        await this.vaultSync.loadLastSyncedVclocks();
        this.replicator.stop();
        this.replicator.start();
        this.changeTracker.start();
        this.fireReconcile("startSync");
    }

    stopSync(): void {
        this.replicator.stop();
        this.changeTracker.stop();
    }

    private fireReconcile(reason: ReconcileReason): void {
        this.reconciler.reconcile(reason).catch((e) =>
            console.error(`CouchSync: ${reason} reconcile failed:`, e),
        );
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
