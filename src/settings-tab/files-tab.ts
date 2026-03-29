import { Setting } from "obsidian";
import type { CouchSyncSettings } from "../settings.ts";
import type { PluginSync } from "../sync/plugin-sync.ts";
import type { HiddenSync } from "../sync/hidden-sync.ts";

type SyncMode = "off" | "push" | "pull" | "sync";

const SYNC_MODE_OPTIONS: Record<SyncMode, string> = {
    off: "Off",
    push: "Push only",
    pull: "Pull only",
    sync: "Sync (bidirectional)",
};

interface FilesTabDeps {
    getSettings: () => CouchSyncSettings;
    updateSettings: (patch: Partial<CouchSyncSettings>) => Promise<void>;
    pluginSync: PluginSync;
    hiddenSync: HiddenSync;
    refresh: () => void;
}

export function renderFilesTab(el: HTMLElement, deps: FilesTabDeps): void {
    const settings = deps.getSettings();

    // ── File Filtering ──────────────────────────────────────
    el.createEl("h3", { text: "File Filtering" });

    new Setting(el)
        .setName("Sync filter (RegExp)")
        .setDesc("Only sync files matching this pattern. Leave empty to sync all.")
        .addText((text) =>
            text
                .setPlaceholder(".*\\.md$")
                .setValue(settings.syncFilter)
                .onChange(async (value) => {
                    await deps.updateSettings({ syncFilter: value });
                })
        );

    new Setting(el)
        .setName("Ignore filter (RegExp)")
        .setDesc("Skip files matching this pattern.")
        .addText((text) =>
            text
                .setPlaceholder("node_modules|^\\.trash")
                .setValue(settings.syncIgnore)
                .onChange(async (value) => {
                    await deps.updateSettings({ syncIgnore: value });
                })
        );

    new Setting(el)
        .setName("Max file size (MB)")
        .setDesc("Files larger than this will not be synced.")
        .addText((text) =>
            text
                .setValue(String(settings.maxFileSizeMB))
                .onChange(async (value) => {
                    const num = parseInt(value, 10);
                    if (!isNaN(num) && num > 0) {
                        await deps.updateSettings({ maxFileSizeMB: num });
                    }
                })
        );

    // ── Hidden File Sync ────────────────────────────────────
    el.createEl("h3", { text: "Hidden File Sync" });

    new Setting(el)
        .setName("Hidden file sync mode")
        .setDesc("How to sync .obsidian/ configuration files.")
        .addDropdown((dropdown) => {
            for (const [value, label] of Object.entries(SYNC_MODE_OPTIONS)) {
                dropdown.addOption(value, label);
            }
            dropdown.setValue(settings.hiddenSyncMode);
            dropdown.onChange(async (value) => {
                await deps.updateSettings({ hiddenSyncMode: value as SyncMode });
                if (value === "push" || value === "sync") {
                    deps.hiddenSync.scanAndSync();
                }
            });
        });

    new Setting(el)
        .setName("Hidden file ignore (RegExp)")
        .setDesc("Skip hidden files matching this pattern.")
        .addText((text) =>
            text
                .setPlaceholder("\\.git/")
                .setValue(settings.hiddenSyncIgnore)
                .onChange(async (value) => {
                    await deps.updateSettings({ hiddenSyncIgnore: value });
                })
        );

    // ── Plugin Sync ─────────────────────────────────────────
    el.createEl("h3", { text: "Plugin Sync" });

    new Setting(el)
        .setName("Plugin sync mode")
        .setDesc("How to sync plugin settings (data.json) between devices.")
        .addDropdown((dropdown) => {
            for (const [value, label] of Object.entries(SYNC_MODE_OPTIONS)) {
                dropdown.addOption(value, label);
            }
            dropdown.setValue(settings.pluginSyncMode);
            dropdown.onChange(async (value) => {
                await deps.updateSettings({ pluginSyncMode: value as SyncMode });
                if (value === "push" || value === "sync") {
                    deps.pluginSync.scanAndSync();
                }
                deps.refresh();
            });
        });

    new Setting(el)
        .setName("Device name")
        .setDesc("Unique name for this device. Required for plugin sync.")
        .addText((text) =>
            text
                .setPlaceholder("desktop")
                .setValue(settings.deviceName)
                .onChange(async (value) => {
                    await deps.updateSettings({ deviceName: value });
                })
        );

    // Plugin selection list (only when plugin sync is not off)
    if (settings.pluginSyncMode !== "off") {
        const listContainer = el.createDiv();

        new Setting(listContainer)
            .setName("Select plugins to sync")
            .setDesc("Choose which plugins' settings to sync. If none selected, all are synced.")
            .addButton((btn) =>
                btn.setButtonText("Select All").onClick(async () => {
                    const plugins = await deps.pluginSync.listInstalledPlugins();
                    const list: Record<string, boolean> = {};
                    for (const id of plugins) list[id] = true;
                    await deps.updateSettings({ pluginSyncList: list });
                    deps.refresh();
                })
            )
            .addButton((btn) =>
                btn.setButtonText("Deselect All").onClick(async () => {
                    const plugins = await deps.pluginSync.listInstalledPlugins();
                    const list: Record<string, boolean> = {};
                    for (const id of plugins) list[id] = false;
                    await deps.updateSettings({ pluginSyncList: list });
                    deps.refresh();
                })
            );

        deps.pluginSync.listInstalledPlugins().then((plugins) => {
            const currentList = { ...settings.pluginSyncList };
            for (const pluginId of plugins) {
                const isEnabled =
                    Object.keys(currentList).length === 0
                        ? true
                        : currentList[pluginId] === true;

                new Setting(listContainer)
                    .setName(pluginId)
                    .addToggle((toggle) =>
                        toggle.setValue(isEnabled).onChange(async (value) => {
                            const updated = { ...deps.getSettings().pluginSyncList };
                            updated[pluginId] = value;
                            await deps.updateSettings({ pluginSyncList: updated });
                        })
                    );
            }
        });
    }
}
