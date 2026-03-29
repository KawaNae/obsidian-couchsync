import { PluginSettingTab, type App } from "obsidian";
import type CouchSyncPlugin from "../main.ts";
import { renderConnectionTab } from "./connection-tab.ts";
import { renderFilesTab } from "./files-tab.ts";
import { renderMaintenanceTab } from "./maintenance-tab.ts";

export class CouchSyncSettingTab extends PluginSettingTab {
    plugin: CouchSyncPlugin;

    constructor(app: App, plugin: CouchSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        const wrapper = containerEl.createDiv({ cls: "cs-settings__wrapper" });

        const nav = wrapper.createDiv({ cls: "cs-settings__nav" });
        const tabs = [
            { id: "connection", label: "Connection" },
            { id: "files", label: "Files" },
            { id: "maintenance", label: "Maintenance" },
        ];

        const panels = new Map<string, HTMLElement>();

        for (const tab of tabs) {
            const btn = nav.createEl("button", {
                text: tab.label,
                cls: "cs-settings__nav-btn",
            });
            btn.dataset.tabId = tab.id;
            btn.addEventListener("click", () => this.activateTab(wrapper, tab.id));

            const panel = wrapper.createDiv({ cls: "cs-settings__panel" });
            panel.dataset.tabId = tab.id;
            panels.set(tab.id, panel);
        }

        const settingsDeps = {
            getSettings: () => this.plugin.settings,
            updateSettings: async (patch: Partial<typeof this.plugin.settings>) => {
                Object.assign(this.plugin.settings, patch);
                await this.plugin.saveSettings();
            },
        };

        const connectionPanel = panels.get("connection");
        if (connectionPanel) {
            renderConnectionTab(connectionPanel, {
                ...settingsDeps,
                replicator: this.plugin.replicator,
                initVault: () => this.plugin.initVault(),
                cloneFromRemote: () => this.plugin.cloneFromRemote(),
                startSync: () => this.plugin.startSync(),
                stopSync: () => this.plugin.stopSync(),
                refresh: () => this.display(),
            });
        }

        const filesPanel = panels.get("files");
        if (filesPanel) {
            renderFilesTab(filesPanel, {
                ...settingsDeps,
                pluginSync: this.plugin.pluginSync,
                refresh: () => this.display(),
            });
        }

        const maintenancePanel = panels.get("maintenance");
        if (maintenancePanel) {
            renderMaintenanceTab(maintenancePanel, {
                ...settingsDeps,
                localDb: this.plugin.localDb,
                replicator: this.plugin.replicator,
                conflictResolver: this.plugin.conflictResolver,
                onRestart: () => {
                    const app = this.plugin.app as any;
                    app.plugins?.disablePlugin("obsidian-couchsync");
                    app.plugins?.enablePlugin("obsidian-couchsync");
                },
            });
        }

        this.activateTab(wrapper, "connection");
    }

    private activateTab(wrapper: HTMLElement, tabId: string): void {
        wrapper.querySelectorAll(".cs-settings__nav-btn").forEach((btn) => {
            btn.removeClass("is-active");
            if ((btn as HTMLElement).dataset.tabId === tabId) {
                btn.addClass("is-active");
            }
        });
        wrapper.querySelectorAll(".cs-settings__panel").forEach((panel) => {
            panel.removeClass("is-active");
            if ((panel as HTMLElement).dataset.tabId === tabId) {
                panel.addClass("is-active");
            }
        });
    }
}
