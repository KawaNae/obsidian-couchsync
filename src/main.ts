import { Plugin } from "obsidian";
import { type CouchSyncSettings, DEFAULT_SETTINGS } from "./settings.ts";
import { LocalDB } from "./db/local-db.ts";
import { Replicator } from "./db/replicator.ts";
import { VaultSync } from "./sync/vault-sync.ts";
import { HiddenSync } from "./sync/hidden-sync.ts";
import { PluginSync } from "./sync/plugin-sync.ts";
import { ChangeTracker } from "./sync/change-tracker.ts";
import { ConflictResolver } from "./conflict/conflict-resolver.ts";
import { StatusBar } from "./ui/status-bar.ts";
import { CouchSyncSettingTab } from "./settings-tab/index.ts";
import { isFileDoc, isHiddenFileDoc, isPluginConfigDoc, type CouchSyncDoc } from "./types.ts";
import { showNotice } from "./ui/notices.ts";

export default class CouchSyncPlugin extends Plugin {
    settings!: CouchSyncSettings;
    localDb!: LocalDB;
    replicator!: Replicator;
    conflictResolver!: ConflictResolver;
    private vaultSync!: VaultSync;
    hiddenSync!: HiddenSync;
    pluginSync!: PluginSync;
    private changeTracker!: ChangeTracker;
    private statusBar!: StatusBar;

    async onload(): Promise<void> {
        await this.loadSettings();

        const dbName = `couchsync-${this.app.vault.getName()}`;
        this.localDb = new LocalDB(dbName);
        this.localDb.open();

        this.replicator = new Replicator(this.localDb, () => this.settings);
        this.vaultSync = new VaultSync(this.app, this.localDb, () => this.settings);
        this.hiddenSync = new HiddenSync(this.app, this.localDb, () => this.settings);
        this.pluginSync = new PluginSync(this.app, this.localDb, () => this.settings);
        this.changeTracker = new ChangeTracker(this.app, this.vaultSync, () => this.settings);
        this.conflictResolver = new ConflictResolver(this.localDb);

        this.statusBar = new StatusBar(this);
        this.replicator.onStateChange((state) => this.statusBar.update(state));
        this.replicator.onError((msg) => showNotice(msg, 8000));

        this.replicator.onChange((doc: CouchSyncDoc) => {
            if (isFileDoc(doc)) {
                this.changeTracker.pause();
                this.vaultSync.dbToFile(doc).finally(() => {
                    setTimeout(() => this.changeTracker.resume(), 500);
                });
                this.conflictResolver.resolveIfConflicted(doc);
            } else if (isHiddenFileDoc(doc)) {
                this.hiddenSync.dbToFile(doc);
            } else if (isPluginConfigDoc(doc)) {
                this.pluginSync.applyRemoteConfig(doc);
            }
        });

        this.addSettingTab(new CouchSyncSettingTab(this.app, this));

        this.app.workspace.onLayoutReady(() => {
            if (this.settings.syncEnabled && this.settings.setupComplete) {
                this.changeTracker.start();
                this.startSync();
            }
        });

        // Reconnect when returning from background (mobile)
        this.registerDomEvent(document, "visibilitychange", () => {
            if (
                document.visibilityState === "visible" &&
                this.settings.syncEnabled &&
                this.settings.setupComplete
            ) {
                const state = this.replicator.getState();
                if (state === "disconnected" || state === "error") {
                    this.replicator.resetRetries();
                    this.startSync();
                }
            }
        });

        this.addCommand({
            id: "couchsync-force-sync",
            name: "Force sync all files now",
            callback: () => this.scanVaultToDb(),
        });
    }

    async onunload(): Promise<void> {
        this.changeTracker?.stop();
        this.replicator?.stop();
        await this.localDb?.close();
    }

    async loadSettings(): Promise<void> {
        const data = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    /** Init: scan local vault → local DB → push to remote */
    async initVault(): Promise<void> {
        await this.scanVaultToDb();
        const count = await this.replicator.pushToRemote();
        console.log(`CouchSync: Init pushed ${count} docs to remote`);
        this.settings.setupComplete = true;
        await this.saveSettings();
    }

    /** Clone: pull remote → local DB → write to vault */
    async cloneFromRemote(): Promise<void> {
        const count = await this.replicator.pullFromRemote();
        console.log(`CouchSync: Clone pulled ${count} docs from remote`);

        // Write all file docs to vault
        const allFiles = await this.localDb.allFileDocs();
        for (const fileDoc of allFiles) {
            try {
                await this.vaultSync.dbToFile(fileDoc);
            } catch (e) {
                console.error(`CouchSync: Failed to write ${fileDoc._id}:`, e);
            }
        }
        console.log(`CouchSync: Clone wrote ${allFiles.length} files to vault`);
        this.settings.setupComplete = true;
        await this.saveSettings();
    }

    /** Start live bidirectional sync */
    async startSync(): Promise<void> {
        if (!this.settings.setupComplete) return;
        this.replicator.stop();
        this.replicator.start();
        this.changeTracker.start();
    }

    /** Stop live sync */
    stopSync(): void {
        this.replicator.stop();
        this.changeTracker.stop();
    }

    /** Scan vault files into local PouchDB */
    private async scanVaultToDb(): Promise<void> {
        const files = this.app.vault.getFiles();
        let synced = 0;
        for (const file of files) {
            try {
                const existing = await this.localDb.getFileDoc(file.path);
                if (!existing || existing.mtime < file.stat.mtime) {
                    await this.vaultSync.fileToDb(file);
                    synced++;
                }
            } catch (e) {
                console.error(`CouchSync: Failed to scan ${file.path}:`, e);
            }
        }
        if (synced > 0) {
            console.log(`CouchSync: Scanned ${synced} files to local DB`);
        }

        if (this.settings.hiddenSyncMode === "push" || this.settings.hiddenSyncMode === "sync") {
            const hiddenCount = await this.hiddenSync.scanAndSync();
            if (hiddenCount > 0) {
                console.log(`CouchSync: Synced ${hiddenCount} hidden files`);
            }
        }
        if (this.settings.pluginSyncMode === "push" || this.settings.pluginSyncMode === "sync") {
            const pluginCount = await this.pluginSync.scanAndSync();
            if (pluginCount > 0) {
                console.log(`CouchSync: Synced ${pluginCount} plugin configs`);
            }
        }
    }
}
