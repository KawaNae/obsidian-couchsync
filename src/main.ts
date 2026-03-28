import { Plugin } from "obsidian";
import { type CouchSyncSettings, DEFAULT_SETTINGS } from "./settings.ts";
import { LocalDB } from "./db/local-db.ts";
import { Replicator } from "./db/replicator.ts";
import { VaultSync } from "./sync/vault-sync.ts";
import { ChangeTracker } from "./sync/change-tracker.ts";
import { StatusBar } from "./ui/status-bar.ts";
import { CouchSyncSettingTab } from "./settings-tab/index.ts";
import { isFileDoc, type CouchSyncDoc } from "./types.ts";

export default class CouchSyncPlugin extends Plugin {
    settings!: CouchSyncSettings;
    private localDb!: LocalDB;
    replicator!: Replicator;
    private vaultSync!: VaultSync;
    private changeTracker!: ChangeTracker;
    private statusBar!: StatusBar;

    async onload(): Promise<void> {
        await this.loadSettings();

        // Initialize services
        const dbName = `couchsync-${this.app.vault.getName()}`;
        this.localDb = new LocalDB(dbName);
        this.localDb.open();

        this.replicator = new Replicator(this.localDb, () => this.settings);
        this.vaultSync = new VaultSync(this.app, this.localDb, () => this.settings);
        this.changeTracker = new ChangeTracker(this.app, this.vaultSync, () => this.settings);

        // UI
        this.statusBar = new StatusBar(this);
        this.replicator.onStateChange((state) => this.statusBar.update(state));

        // Handle incoming remote changes
        this.replicator.onChange((doc: CouchSyncDoc) => {
            if (isFileDoc(doc)) {
                this.changeTracker.pause();
                this.vaultSync.dbToFile(doc).finally(() => {
                    setTimeout(() => this.changeTracker.resume(), 500);
                });
            }
        });

        // Settings tab
        this.addSettingTab(new CouchSyncSettingTab(this.app, this));

        // Start on layout ready
        this.app.workspace.onLayoutReady(() => {
            this.changeTracker.start();

            if (this.settings.isConfigured) {
                this.replicator.start();
                this.initialScan();
            }
        });

        // Commands
        this.addCommand({
            id: "couchsync-force-sync",
            name: "Force sync all files now",
            callback: () => this.initialScan(),
        });
    }

    async onunload(): Promise<void> {
        this.changeTracker.stop();
        this.replicator.stop();
        await this.localDb.close();
    }

    async loadSettings(): Promise<void> {
        const data = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    private async initialScan(): Promise<void> {
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
            console.log(`CouchSync: Initial scan synced ${synced} files`);
        }
    }
}
