import { Plugin } from "obsidian";
import { type CouchSyncSettings, DEFAULT_SETTINGS } from "./settings.ts";
import { LocalDB } from "./db/local-db.ts";
import { Replicator } from "./db/replicator.ts";
import { VaultSync } from "./sync/vault-sync.ts";
import { ConfigSync } from "./sync/config-sync.ts";
import { SetupService } from "./sync/setup.ts";
import { ChangeTracker } from "./sync/change-tracker.ts";
import { Reconciler } from "./sync/reconciler.ts";
import { ConflictResolver } from "./conflict/conflict-resolver.ts";
import { StatusBar } from "./ui/status-bar.ts";
import { CouchSyncSettingTab } from "./settings-tab/index.ts";
import { isFileDoc, type CouchSyncDoc } from "./types.ts";
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
    replicator!: Replicator;
    conflictResolver!: ConflictResolver;
    configSync!: ConfigSync;
    private vaultSync!: VaultSync;
    private setupService!: SetupService;
    private changeTracker!: ChangeTracker;
    private reconciler!: Reconciler;
    private historyStorage!: HistoryStorage;
    private historyCapture!: HistoryCapture;
    private reconnecting = false;
    historyManager!: HistoryManager;
    statusBar!: StatusBar;

    async onload(): Promise<void> {
        await this.loadSettings();

        if (!this.settings.deviceId) {
            this.settings.deviceId = crypto.randomUUID();
            await this.saveSettings();
        }

        const dbName = `couchsync-${this.app.vault.getName()}`;
        this.localDb = new LocalDB(dbName);
        this.localDb.open();

        this.replicator = new Replicator(this.localDb, () => this.settings);
        this.vaultSync = new VaultSync(this.app, this.localDb, () => this.settings);
        this.configSync = new ConfigSync(this.app, this.localDb, this.replicator, () => this.settings);
        this.statusBar = new StatusBar(this, () => this.settings);
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
        this.historyStorage = new HistoryStorage(this.app.vault.getName());
        this.historyCapture = new HistoryCapture(this.app, this.historyStorage, () => this.settings);
        this.vaultSync.setHistoryCapture(this.historyCapture);
        this.historyManager = new HistoryManager(
            this.app.vault, this.historyStorage, this.historyCapture, () => this.settings,
        );
        this.conflictResolver = new ConflictResolver(
            this.localDb,
            async (filePath, winnerDoc, loserDoc) => {
                try {
                    const loserChunks = await this.localDb.getChunks(loserDoc.chunks);
                    const loserBuf = joinChunks(loserChunks);
                    if (!isDiffableText(loserBuf)) return;
                    const winnerChunks = await this.localDb.getChunks(winnerDoc.chunks);
                    const winnerBuf = joinChunks(winnerChunks);
                    if (!isDiffableText(winnerBuf)) return;
                    const dec = new TextDecoder("utf-8");
                    await this.historyCapture.saveConflict(filePath, dec.decode(loserBuf), dec.decode(winnerBuf));
                    showNotice(`Conflict resolved: ${filePath.split("/").pop()}. Losing version saved to history.`);
                } catch (e) {
                    console.error("CouchSync: Failed to save conflict to history:", e);
                }
            },
        );

        // Live remote → vault hint path. Reconciler.reconcile("paused") below
        // is the safety net that catches anything dbToFile missed.
        this.replicator.onChange((doc: CouchSyncDoc) => {
            if (isFileDoc(doc)) {
                this.vaultSync.dbToFile(doc)
                    .then(() => this.conflictResolver.resolveIfConflicted(doc))
                    .catch((e) => console.error(`CouchSync: Failed to apply remote change for ${doc._id}:`, e));
            }
        });

        // Reconciler runs after every replication batch. The cursor + manifest
        // short-circuit makes the steady-state cost negligible.
        this.replicator.onPaused(() => {
            this.reconciler.reconcile("paused")
                .catch((e) => console.error("CouchSync: Reconcile failed:", e));
        });

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

            // Force re-chunk all files via the all-binary path on first run.
            if (this.settings.syncSchemaVersion < 2) {
                await this.localDb.putScanCursor({ lastScanStartedAt: 0, lastScanCompletedAt: 0 });
                this.settings.syncSchemaVersion = 2;
                await this.saveSettings();
                console.log("CouchSync: upgraded sync schema to v2 (all-binary)");
            }

            if (this.settings.connectionState === "syncing") {
                this.reconnectWithPullFirst();
            } else {
                this.reconciler.reconcile("onload").catch((e) =>
                    console.error("CouchSync: onload reconcile failed:", e),
                );
            }
        });

        // Pull-first restart on foreground return (mobile) and network reconnection.
        this.registerDomEvent(document, "visibilitychange", () => {
            if (
                document.visibilityState === "visible" &&
                this.settings.connectionState === "syncing"
            ) {
                this.reconnectWithPullFirst();
            }
        });

        this.replicator.onReconnect(() => {
            if (this.settings.connectionState === "syncing") {
                this.reconnectWithPullFirst();
            }
        });

        this.addCommand({
            id: "couchsync-force-sync",
            name: "Force sync all files now",
            callback: async () => {
                const report = await this.reconciler.reconcile("manual");
                if (this.settings.connectionState === "syncing") {
                    this.replicator.restart();
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

        this.addCommand({
            id: "couchsync-config-init",
            name: "Init config sync (clean rebuild)",
            callback: async () => {
                const count = await this.configSync.init();
                showNotice(`Config init: ${count} file(s) pushed.`);
            },
        });

        this.addCommand({
            id: "couchsync-config-push",
            name: "Push config files to remote",
            callback: async () => {
                const count = await this.configSync.push();
                showNotice(`Pushed ${count} config file(s).`);
            },
        });

        this.addCommand({
            id: "couchsync-config-pull",
            name: "Pull config files from remote",
            callback: async () => {
                const count = await this.configSync.pull();
                showNotice(`Pulled ${count} config file(s).`);
            },
        });
    }

    async onunload(): Promise<void> {
        this.changeTracker?.stop();
        this.historyCapture?.stop();
        this.historyManager?.stopCleanup();
        this.replicator?.stop();
        this.statusBar?.destroy();
        this.historyStorage?.close();
        await this.localDb?.close();
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

    async initVault(): Promise<void> {
        const progress = new ProgressNotice("Init");
        const result = await this.setupService.init((msg) => progress.update(msg));
        this.settings.connectionState = "setupDone";
        await this.saveSettings();
        progress.done(`Init complete! ${result.vaultFiles} files, ${result.totalDocs} docs pushed.`);
    }

    async cloneFromRemote(): Promise<void> {
        const progress = new ProgressNotice("Clone");
        const result = await this.setupService.clone((msg) => progress.update(msg));
        this.settings.connectionState = "setupDone";
        await this.saveSettings();
        progress.done(`Clone complete! ${result.vaultFiles} files written.`);
    }

    async startSync(): Promise<void> {
        if (this.settings.connectionState !== "syncing") return;
        this.replicator.stop();
        this.replicator.start();
        this.changeTracker.start();
        this.reconciler.reconcile("startSync").catch((e) =>
            console.error("CouchSync: startSync reconcile failed:", e),
        );
    }

    stopSync(): void {
        this.replicator.stop();
        this.changeTracker.stop();
    }

    private async reconnectWithPullFirst(): Promise<void> {
        if (this.reconnecting) return;
        this.reconnecting = true;

        this.statusBar.update("syncing", "Reconnecting...");
        this.changeTracker.stop();
        this.vaultSync.setPullInProgress(true);
        this.replicator.stop();

        try {
            this.statusBar.update("syncing", "Pulling...");
            const { docs } = await this.replicator.pullFromRemote(
                (_docId, count) => this.statusBar.update("syncing", `Pulling... (${count})`),
            );

            const fileDocs = docs.filter(isFileDoc);
            if (fileDocs.length > 0) {
                this.statusBar.update("syncing", "Applying...");
                for (const doc of fileDocs) {
                    await this.vaultSync.dbToFile(doc);
                    await this.conflictResolver.resolveIfConflicted(doc);
                }
                const names = fileDocs.map((d) => d._id.split("/").pop()).join(", ");
                showNotice(
                    fileDocs.length <= 10
                        ? `Reconnected: pulled ${fileDocs.length} file(s): ${names}`
                        : `Reconnected: pulled ${fileDocs.length} file(s)`,
                );
            }
        } catch (e) {
            console.error("CouchSync: Pull-first failed:", e);
        }

        this.vaultSync.setPullInProgress(false);

        // Single reconcile pass handles both directions: chunk arrival race
        // recovery (case C/D restore), missed local edits (case C push),
        // and deletes made during the disconnect (case D delete).
        await this.reconciler.reconcile("reconnect");

        this.replicator.start();
        this.changeTracker.start();
        this.reconnecting = false;
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
