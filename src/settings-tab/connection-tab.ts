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

type ConnectionState = "editing" | "tested" | "setupDone" | "syncing";

function getState(settings: CouchSyncSettings): ConnectionState {
    if (settings.syncEnabled) return "syncing";
    if (settings.setupComplete) return "setupDone";
    if (settings.connectionTested) return "tested";
    return "editing";
}

export function renderConnectionTab(el: HTMLElement, deps: ConnectionTabDeps): void {
    const settings = deps.getSettings();
    const state = getState(settings);

    const fieldsEditable = state === "editing" || state === "tested";
    const testEnabled = state === "editing" || state === "tested";
    const applyEnabled = state !== "syncing";
    const initCloneEnabled = state === "tested";
    const syncToggleEnabled = state === "setupDone" || state === "syncing";

    // ── Step 1: Connection ──────────────────────────────────
    el.createEl("h3", { text: "Step 1: Connection" });

    if (state === "syncing") {
        el.createEl("p", { text: "Disable sync to change connection.", cls: "setting-item-description" });
    } else if (state === "setupDone") {
        el.createEl("p", { text: "Use Reset Connection to change settings.", cls: "setting-item-description" });
    }

    new Setting(el)
        .setName("Server URI")
        .setDesc("e.g. https://your-couchdb-server:5984")
        .addText((text) => {
            text.setPlaceholder("https://localhost:5984")
                .setValue(settings.couchdbUri)
                .onChange(async (value) => {
                    await deps.updateSettings({ couchdbUri: value, connectionTested: false });
                    deps.refresh();
                });
            text.setDisabled(!fieldsEditable);
        });

    new Setting(el)
        .setName("Username")
        .addText((text) => {
            text.setPlaceholder("admin")
                .setValue(settings.couchdbUser)
                .onChange(async (value) => {
                    await deps.updateSettings({ couchdbUser: value, connectionTested: false });
                    deps.refresh();
                });
            text.setDisabled(!fieldsEditable);
        });

    new Setting(el)
        .setName("Password")
        .addText((text) => {
            text.setPlaceholder("password")
                .setValue(settings.couchdbPassword)
                .onChange(async (value) => {
                    await deps.updateSettings({ couchdbPassword: value, connectionTested: false });
                    deps.refresh();
                });
            text.inputEl.type = "password";
            text.setDisabled(!fieldsEditable);
        });

    new Setting(el)
        .setName("Database Name")
        .addText((text) => {
            text.setPlaceholder("obsidian")
                .setValue(settings.couchdbDbName)
                .onChange(async (value) => {
                    await deps.updateSettings({ couchdbDbName: value, connectionTested: false });
                    deps.refresh();
                });
            text.setDisabled(!fieldsEditable);
        });

    new Setting(el)
        .setName(state === "setupDone" ? "Reset Connection" : "Apply")
        .setDesc(
            state === "syncing"
                ? "Disable sync first."
                : state === "setupDone"
                    ? "Unlock fields to change connection settings."
                    : "Confirm connection settings."
        )
        .addButton((btn) =>
            btn
                .setButtonText(state === "setupDone" ? "Reset" : "Apply")
                .setDisabled(!applyEnabled)
                .setWarning(state === "setupDone")
                .onClick(async () => {
                    deps.stopSync();
                    await deps.updateSettings({
                        connectionTested: false,
                        setupComplete: false,
                        syncEnabled: false,
                    });
                    new Notice("Connection reset. Edit and test again.", 3000);
                    deps.refresh();
                })
        );

    new Setting(el)
        .setName("Test Connection")
        .setDesc("Verify connection to CouchDB server")
        .addButton((btn) =>
            btn
                .setButtonText("Test")
                .setDisabled(!testEnabled)
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
                    }
                    deps.refresh();
                    setTimeout(() => {
                        btn.setButtonText("Test");
                        btn.setDisabled(false);
                    }, 3000);
                })
        );

    // ── Step 2: Setup ───────────────────────────────────────
    el.createEl("h3", { text: "Step 2: Setup" });

    const setupDesc = state === "editing"
        ? "Test connection first."
        : state === "tested"
            ? "Choose how to initialize this vault."
            : state === "setupDone"
                ? "Setup complete."
                : "Disable sync to re-run setup.";

    new Setting(el)
        .setName("Init")
        .setDesc("Push local vault to empty remote database (1st device)")
        .addButton((btn) =>
            btn
                .setButtonText("Init")
                .setDisabled(!initCloneEnabled)
                .onClick(async () => {
                    btn.setButtonText("Pushing...");
                    btn.setDisabled(true);
                    try {
                        await deps.initVault();
                        new Notice("Init complete!", 5000);
                        deps.refresh();
                    } catch (e: any) {
                        new Notice(`Init failed: ${e.message}`, 8000);
                        btn.setButtonText("Init");
                        btn.setDisabled(false);
                    }
                })
        );

    new Setting(el)
        .setName("Clone")
        .setDesc("Pull remote database to local vault (2nd+ device)")
        .addButton((btn) =>
            btn
                .setButtonText("Clone")
                .setDisabled(!initCloneEnabled)
                .onClick(async () => {
                    btn.setButtonText("Pulling...");
                    btn.setDisabled(true);
                    try {
                        await deps.cloneFromRemote();
                        new Notice("Clone complete!", 5000);
                        deps.refresh();
                    } catch (e: any) {
                        new Notice(`Clone failed: ${e.message}`, 8000);
                        btn.setButtonText("Clone");
                        btn.setDisabled(false);
                    }
                })
        );

    el.createEl("p", { text: setupDesc, cls: "setting-item-description" });

    // ── Step 3: Sync ────────────────────────────────────────
    el.createEl("h3", { text: "Step 3: Sync" });

    new Setting(el)
        .setName("Live Sync")
        .setDesc(
            state === "syncing"
                ? "Bidirectional live sync is active."
                : state === "setupDone"
                    ? "Enable to start live bidirectional sync."
                    : "Complete Init or Clone first."
        )
        .addToggle((toggle) =>
            toggle
                .setValue(settings.syncEnabled)
                .setDisabled(!syncToggleEnabled)
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
