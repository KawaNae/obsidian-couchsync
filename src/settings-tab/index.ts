import { PluginSettingTab, type App } from "obsidian";
import type CouchSyncPlugin from "../main.ts";
import { renderConnectionTab } from "./connection-tab.ts";

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

        // Tab navigation
        const nav = wrapper.createDiv({ cls: "cs-settings__nav" });
        const tabs = [
            { id: "connection", label: "Connection" },
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

        // Render tab contents
        const connectionPanel = panels.get("connection");
        if (connectionPanel) {
            renderConnectionTab(connectionPanel, {
                getSettings: () => this.plugin.settings,
                updateSettings: async (patch) => {
                    Object.assign(this.plugin.settings, patch);
                    await this.plugin.saveSettings();
                },
                replicator: this.plugin.replicator,
            });
        }

        const maintenancePanel = panels.get("maintenance");
        if (maintenancePanel) {
            maintenancePanel.createEl("h3", { text: "Maintenance" });
            maintenancePanel.createEl("p", {
                text: "Maintenance options will be available in a future update.",
            });
        }

        // Activate first tab
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
