import { Notice, Setting } from "obsidian";
import type { CouchSyncSettings } from "../settings.ts";
import type { Replicator } from "../db/replicator.ts";

interface ConnectionTabDeps {
    getSettings: () => CouchSyncSettings;
    updateSettings: (patch: Partial<CouchSyncSettings>) => Promise<void>;
    replicator: Replicator;
    initVault: () => Promise<void>;
    cloneFromRemote: () => Promise<void>;
    startSync: () => Promise<void>;
    stopSync: () => void;
    refresh: () => void;
}

export function renderConnectionTab(el: HTMLElement, deps: ConnectionTabDeps): void {
    const settings = deps.getSettings();
    const connectionLocked = settings.setupComplete;

    // ── Step 1: Connection ──────────────────────────────────
    el.createEl("h3", { text: "Step 1: Connection" });

    if (connectionLocked) {
        el.createEl("p", {
            text: "Connection is locked. Use Apply to change connection settings.",
            cls: "setting-item-description",
        });
    }

    new Setting(el)
        .setName("Server URI")
        .setDesc("e.g. https://your-couchdb-server:5984")
        .addText((text) => {
            text.setPlaceholder("https://localhost:5984")
                .setValue(settings.couchdbUri)
                .onChange(async (value) => {
                    await deps.updateSettings({ couchdbUri: value });
                });
            text.setDisabled(connectionLocked);
        });

    new Setting(el)
        .setName("Username")
        .addText((text) => {
            text.setPlaceholder("admin")
                .setValue(settings.couchdbUser)
                .onChange(async (value) => {
                    await deps.updateSettings({ couchdbUser: value });
                });
            text.setDisabled(connectionLocked);
        });

    new Setting(el)
        .setName("Password")
        .addText((text) => {
            text.setPlaceholder("password")
                .setValue(settings.couchdbPassword)
                .onChange(async (value) => {
                    await deps.updateSettings({ couchdbPassword: value });
                });
            text.inputEl.type = "password";
            text.setDisabled(connectionLocked);
        });

    new Setting(el)
        .setName("Database Name")
        .addText((text) => {
            text.setPlaceholder("obsidian")
                .setValue(settings.couchdbDbName)
                .onChange(async (value) => {
                    await deps.updateSettings({ couchdbDbName: value });
                });
            text.setDisabled(connectionLocked);
        });

    // Apply button: reset connection state to allow re-configuration
    if (connectionLocked) {
        new Setting(el)
            .setName("Change connection")
            .setDesc("Reset connection to change settings. Stops sync if active.")
            .addButton((btn) =>
                btn
                    .setButtonText("Apply")
                    .setWarning()
                    .onClick(async () => {
                        deps.stopSync();
                        await deps.updateSettings({
                            connectionTested: false,
                            setupComplete: false,
                            syncEnabled: false,
                        });
                        new Notice("Connection reset. Configure and test again.", 3000);
                        deps.refresh();
                    })
            );
    }

    new Setting(el)
        .setName("Test Connection")
        .setDesc("Verify connection to CouchDB server")
        .addButton((btn) =>
            btn
                .setButtonText("Test")
                .setDisabled(connectionLocked)
                .onClick(async () => {
                    btn.setButtonText("Testing...");
                    btn.setDisabled(true);
                    const error = await deps.replicator.testConnection();
                    if (error) {
                        btn.setButtonText("Failed");
                        await deps.updateSettings({ connectionTested: false });
                        new Notice(`Connection failed: ${error}`, 8000);
                    } else {
                        btn.setButtonText("Success!");
                        await deps.updateSettings({ connectionTested: true });
                        new Notice("Connection successful!", 3000);
                        deps.refresh();
                    }
                    setTimeout(() => {
                        btn.setButtonText("Test");
                        btn.setDisabled(false);
                    }, 3000);
                })
        );

    // ── Step 2: Setup ───────────────────────────────────────
    el.createEl("h3", { text: "Step 2: Setup" });

    const setupDisabled = !settings.connectionTested || settings.syncEnabled;
    const setupDesc = !settings.connectionTested
        ? "Test connection first."
        : settings.syncEnabled
            ? "Disable sync before re-running setup."
            : settings.setupComplete
                ? "Setup complete. You can re-run if needed."
                : "Choose how to initialize this vault.";

    new Setting(el)
        .setName("Init")
        .setDesc("Push local vault to empty remote database (1st device)")
        .addButton((btn) =>
            btn
                .setButtonText("Init")
                .setDisabled(setupDisabled)
                .onClick(async () => {
                    btn.setButtonText("Pushing...");
                    btn.setDisabled(true);
                    try {
                        await deps.initVault();
                        new Notice("Init complete! Local vault pushed to remote.", 5000);
                        deps.refresh();
                    } catch (e: any) {
                        new Notice(`Init failed: ${e.message}`, 8000);
                    }
                    btn.setButtonText("Init");
                    btn.setDisabled(false);
                })
        );

    new Setting(el)
        .setName("Clone")
        .setDesc("Pull remote database to local vault (2nd+ device)")
        .addButton((btn) =>
            btn
                .setButtonText("Clone")
                .setDisabled(setupDisabled)
                .onClick(async () => {
                    btn.setButtonText("Pulling...");
                    btn.setDisabled(true);
                    try {
                        await deps.cloneFromRemote();
                        new Notice("Clone complete! Remote data pulled to local vault.", 5000);
                        deps.refresh();
                    } catch (e: any) {
                        new Notice(`Clone failed: ${e.message}`, 8000);
                    }
                    btn.setButtonText("Clone");
                    btn.setDisabled(false);
                })
        );

    if (setupDesc) {
        el.createEl("p", { text: setupDesc, cls: "setting-item-description" });
    }

    // ── Step 3: Sync ────────────────────────────────────────
    el.createEl("h3", { text: "Step 3: Sync" });

    const syncToggleDisabled = !settings.setupComplete;

    new Setting(el)
        .setName("Live Sync")
        .setDesc(
            !settings.setupComplete
                ? "Complete Init or Clone first."
                : settings.syncEnabled
                    ? "Bidirectional live sync is active."
                    : "Enable to start live bidirectional sync."
        )
        .addToggle((toggle) =>
            toggle
                .setValue(settings.syncEnabled)
                .setDisabled(syncToggleDisabled)
                .onChange(async (value) => {
                    await deps.updateSettings({ syncEnabled: value });
                    if (value) {
                        await deps.startSync();
                        new Notice("Live sync started.", 3000);
                    } else {
                        deps.stopSync();
                        new Notice("Live sync stopped.", 3000);
                    }
                    deps.refresh();
                })
        );
}
