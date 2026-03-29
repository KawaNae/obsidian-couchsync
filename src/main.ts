import { Plugin } from "obsidian";
import { type CouchSyncSettings, DEFAULT_SETTINGS } from "./settings.ts";
import { LocalDB } from "./db/local-db.ts";
import { Replicator } from "./db/replicator.ts";
import { VaultSync } from "./sync/vault-sync.ts";
import { ConfigSync } from "./sync/config-sync.ts";
import { ChangeTracker } from "./sync/change-tracker.ts";
import { ConflictResolver } from "./conflict/conflict-resolver.ts";
import { StatusBar } from "./ui/status-bar.ts";
import { CouchSyncSettingTab } from "./settings-tab/index.ts";
import { isFileDoc, type CouchSyncDoc } from "./types.ts";
import { showNotice } from "./ui/notices.ts";

export default class CouchSyncPlugin extends Plugin {
    settings!: CouchSyncSettings;
    localDb!: LocalDB;
    replicator!: Replicator;
    conflictResolver!: ConflictResolver;
    configSync!: ConfigSync;
    private vaultSync!: VaultSync;
    private changeTracker!: ChangeTracker;
    statusBar!: StatusBar;

    async onload(): Promise<void> {
        await this.loadSettings();

        const dbName = `couchsync-${this.app.vault.getName()}`;
        this.localDb = new LocalDB(dbName);
        this.localDb.open();

        this.replicator = new Replicator(this.localDb, () => this.settings);
        this.vaultSync = new VaultSync(this.app, this.localDb, () => this.settings);
        this.configSync = new ConfigSync(this.app, this.localDb, this.replicator, () => this.settings);
        this.changeTracker = new ChangeTracker(this.app, this.vaultSync, () => this.settings);
        this.conflictResolver = new ConflictResolver(this.localDb);

        this.statusBar = new StatusBar(this, () => this.settings);
        this.replicator.onStateChange((state) => this.statusBar.update(state));
        this.replicator.onError((msg) => showNotice(msg, 8000));

        // Handle incoming remote changes — vault files only (config is manual pull)
        this.replicator.onChange((doc: CouchSyncDoc) => {
            if (isFileDoc(doc)) {
                this.changeTracker.pause();
                this.vaultSync.dbToFile(doc).finally(() => {
                    setTimeout(() => this.changeTracker.resume(), 500);
                });
                this.conflictResolver.resolveIfConflicted(doc);
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
        this.replicator?.stop();
        this.statusBar?.destroy();
        await this.localDb?.close();
    }

    async loadSettings(): Promise<void> {
        const data = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    async initVault(): Promise<void> {
        await this.scanVaultToDb();
        const count = await this.replicator.pushToRemote();
        console.log(`CouchSync: Init pushed ${count} docs to remote`);
        this.settings.setupComplete = true;
        await this.saveSettings();
    }

    async cloneFromRemote(): Promise<void> {
        const count = await this.replicator.pullFromRemote();
        console.log(`CouchSync: Clone pulled ${count} docs from remote`);

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

    async startSync(): Promise<void> {
        if (!this.settings.setupComplete) return;
        this.replicator.stop();
        this.replicator.start();
        this.changeTracker.start();
    }

    stopSync(): void {
        this.replicator.stop();
        this.changeTracker.stop();
    }

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
    }
}
