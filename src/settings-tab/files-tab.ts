import { Setting } from "obsidian";
import type { CouchSyncSettings } from "../settings.ts";

interface FilesTabDeps {
    getSettings: () => CouchSyncSettings;
    updateSettings: (patch: Partial<CouchSyncSettings>) => Promise<void>;
}

export function renderFilesTab(el: HTMLElement, deps: FilesTabDeps): void {
    const settings = deps.getSettings();

    // File Filtering
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

    // Hidden File Sync
    el.createEl("h3", { text: "Hidden File Sync" });

    new Setting(el)
        .setName("Enable hidden file sync")
        .setDesc("Sync .obsidian/ configuration files between devices.")
        .addToggle((toggle) =>
            toggle.setValue(settings.enableHiddenSync).onChange(async (value) => {
                await deps.updateSettings({ enableHiddenSync: value });
            })
        );

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

    // Plugin Sync
    el.createEl("h3", { text: "Plugin Sync" });

    new Setting(el)
        .setName("Enable plugin sync")
        .setDesc("Sync plugin settings (data.json) between devices.")
        .addToggle((toggle) =>
            toggle.setValue(settings.enablePluginSync).onChange(async (value) => {
                await deps.updateSettings({ enablePluginSync: value });
            })
        );

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
}
