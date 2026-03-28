import { Notice, Setting } from "obsidian";
import type { CouchSyncSettings } from "../settings.ts";
import type { Replicator } from "../db/replicator.ts";

interface ConnectionTabDeps {
    getSettings: () => CouchSyncSettings;
    updateSettings: (patch: Partial<CouchSyncSettings>) => Promise<void>;
    replicator: Replicator;
    startSync: () => Promise<void>;
}

export function renderConnectionTab(el: HTMLElement, deps: ConnectionTabDeps): void {
    const settings = deps.getSettings();

    el.createEl("h3", { text: "CouchDB Connection" });

    new Setting(el)
        .setName("Server URI")
        .setDesc("e.g. https://your-couchdb-server:5984")
        .addText((text) =>
            text
                .setPlaceholder("https://localhost:5984")
                .setValue(settings.couchdbUri)
                .onChange(async (value) => {
                    await deps.updateSettings({ couchdbUri: value });
                })
        );

    new Setting(el)
        .setName("Username")
        .addText((text) =>
            text
                .setPlaceholder("admin")
                .setValue(settings.couchdbUser)
                .onChange(async (value) => {
                    await deps.updateSettings({ couchdbUser: value });
                })
        );

    new Setting(el)
        .setName("Password")
        .addText((text) => {
            text.setPlaceholder("password")
                .setValue(settings.couchdbPassword)
                .onChange(async (value) => {
                    await deps.updateSettings({ couchdbPassword: value });
                });
            text.inputEl.type = "password";
        });

    new Setting(el)
        .setName("Database Name")
        .addText((text) =>
            text
                .setPlaceholder("obsidian")
                .setValue(settings.couchdbDbName)
                .onChange(async (value) => {
                    await deps.updateSettings({ couchdbDbName: value });
                })
        );

    new Setting(el)
        .setName("Test Connection")
        .setDesc("Verify connection to CouchDB server")
        .addButton((btn) =>
            btn.setButtonText("Test").onClick(async () => {
                btn.setButtonText("Testing...");
                btn.setDisabled(true);
                const error = await deps.replicator.testConnection();
                if (error) {
                    btn.setButtonText("Failed");
                    new Notice(`Connection failed: ${error}`, 8000);
                } else {
                    btn.setButtonText("Success!");
                    await deps.updateSettings({ isConfigured: true });
                    await deps.startSync();
                    new Notice("Connected! Sync started.", 3000);
                }
                setTimeout(() => {
                    btn.setButtonText("Test");
                    btn.setDisabled(false);
                }, 3000);
            })
        );
}
