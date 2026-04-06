import { PluginSettingTab, type App } from "obsidian";
import type CouchSyncPlugin from "../main.ts";
import { ConnectionTab } from "./connection-tab.ts";
import { renderFilesTab } from "./files-tab.ts";
import { renderHistoryTab } from "./history-tab.ts";
import { renderMaintenanceTab } from "./maintenance-tab.ts";
import { renderStatusTab } from "./status-tab.ts";

export class CouchSyncSettingTab extends PluginSettingTab {
    plugin: CouchSyncPlugin;
    private activeTabId = "connection";
    private connectionTab: ConnectionTab | null = null;

    constructor(app: App, plugin: CouchSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass("cs-settings");

        const wrapper = containerEl.createDiv({ cls: "cs-settings__wrapper" });

        // Version & build info
        const versionEl = wrapper.createDiv({ cls: "cs-settings__version" });
        versionEl.createSpan({
            text: `CouchSync v${this.plugin.manifest.version}`,
            cls: "setting-item-description",
        });
        versionEl.createSpan({
            text: ` — Built: ${typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "unknown"}`,
            cls: "setting-item-description",
        });

        // Tab navigation — event delegation on nav parent
        const nav = wrapper.createDiv({ cls: "cs-settings__nav" });
        nav.addEventListener("click", (e) => {
            const btn = (e.target as HTMLElement).closest(".cs-settings__nav-btn") as HTMLElement | null;
            if (btn?.dataset.tabId) {
                this.activateTab(wrapper, btn.dataset.tabId);
            }
        });

        const tabs = [
            { id: "connection", label: "Connection" },
            { id: "files", label: "Files" },
            { id: "history", label: "History" },
            { id: "maintenance", label: "Maintenance" },
            { id: "status", label: "CouchDB" },
        ];

        // Content area
        const content = wrapper.createDiv({ cls: "cs-settings__content" });
        const panels = new Map<string, HTMLElement>();

        for (const tab of tabs) {
            nav.createDiv({
                text: tab.label,
                cls: "cs-settings__nav-btn",
                attr: { "data-tab-id": tab.id, role: "tab", tabindex: "0" },
            });

            const panel = content.createDiv({ cls: "cs-settings__panel" });
            panel.dataset.tabId = tab.id;
            panel.style.display = "none";
            panels.set(tab.id, panel);
        }

        // Shared deps
        const settingsDeps = {
            getSettings: () => this.plugin.settings,
            updateSettings: async (patch: Partial<typeof this.plugin.settings>) => {
                Object.assign(this.plugin.settings, patch);
                await this.plugin.saveSettings();
            },
        };

        // ConnectionTab — instance persists across display() for draft state
        const connectionDeps = {
            ...settingsDeps,
            replicator: this.plugin.replicator,
            initVault: () => this.plugin.initVault(),
            cloneFromRemote: () => this.plugin.cloneFromRemote(),
            startSync: () => this.plugin.startSync(),
            stopSync: () => this.plugin.stopSync(),
            refresh: () => this.display(),
        };
        if (!this.connectionTab) {
            this.connectionTab = new ConnectionTab(connectionDeps);
        }
        const connectionPanel = panels.get("connection");
        if (connectionPanel) {
            this.connectionTab.render(connectionPanel);
        }

        const filesPanel = panels.get("files");
        if (filesPanel) {
            renderFilesTab(filesPanel, {
                ...settingsDeps,
                configSync: this.plugin.configSync,
                app: this.app,
                refresh: () => this.display(),
            });
        }

        const historyPanel = panels.get("history");
        if (historyPanel) {
            renderHistoryTab(historyPanel, {
                ...settingsDeps,
                historyManager: this.plugin.historyManager,
            });
        }

        const maintenancePanel = panels.get("maintenance");
        if (maintenancePanel) {
            renderMaintenanceTab(maintenancePanel, {
                ...settingsDeps,
                localDb: this.plugin.localDb,
                replicator: this.plugin.replicator,
                conflictResolver: this.plugin.conflictResolver,
                statusBar: this.plugin.statusBar,
                onRestart: () => {
                    const app = this.plugin.app as any;
                    app.plugins?.disablePlugin("obsidian-couchsync");
                    app.plugins?.enablePlugin("obsidian-couchsync");
                },
            });
        }

        const statusPanel = panels.get("status");
        if (statusPanel) {
            renderStatusTab(statusPanel, {
                ...settingsDeps,
                app: this.app,
                refresh: () => this.display(),
            });
        }

        // Restore active tab (survives refresh)
        this.activateTab(wrapper, this.activeTabId);
    }

    hide(): void {
        this.connectionTab?.resetDraft();
    }

    private activateTab(wrapper: HTMLElement, tabId: string): void {
        this.activeTabId = tabId;

        wrapper.querySelectorAll(".cs-settings__nav-btn").forEach((btn) => {
            const el = btn as HTMLElement;
            el.toggleClass("cs-settings__nav-btn--active", el.dataset.tabId === tabId);
        });
        wrapper.querySelectorAll(".cs-settings__panel").forEach((panel) => {
            const el = panel as HTMLElement;
            el.style.display = el.dataset.tabId === tabId ? "" : "none";
        });
    }
}
