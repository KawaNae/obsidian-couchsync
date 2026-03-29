import { Notice, Setting } from "obsidian";
import type { CouchSyncSettings } from "../settings.ts";
import type { ConfigSync } from "../sync/config-sync.ts";

interface FilesTabDeps {
    getSettings: () => CouchSyncSettings;
    updateSettings: (patch: Partial<CouchSyncSettings>) => Promise<void>;
    configSync: ConfigSync;
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

    // ── Config Sync ─────────────────────────────────────────
    el.createEl("h3", { text: "Config Sync" });
    el.createEl("p", {
        text: "Manually push/pull config files and plugin folders. Add paths below, then use Push or Pull.",
        cls: "setting-item-description",
    });

    // Current paths list
    const paths = settings.configSyncPaths;
    for (const path of paths) {
        new Setting(el)
            .setName(path)
            .addButton((btn) =>
                btn
                    .setButtonText("×")
                    .setWarning()
                    .onClick(async () => {
                        const updated = settings.configSyncPaths.filter((p) => p !== path);
                        await deps.updateSettings({ configSyncPaths: updated });
                        deps.refresh();
                    })
            );
    }

    // Add path with suggestions
    const addPathContainer = el.createDiv();
    const addSetting = new Setting(addPathContainer).setName("Add path");

    let inputValue = "";
    const suggestionsEl = addPathContainer.createDiv({ cls: "cs-suggest-list" });
    suggestionsEl.style.display = "none";

    addSetting.addText((text) => {
        text.setPlaceholder(".obsidian/plugins/my-plugin/");
        text.inputEl.addEventListener("focus", () => loadSuggestions(suggestionsEl, deps));
        text.inputEl.addEventListener("input", () => {
            inputValue = text.inputEl.value;
            filterSuggestions(suggestionsEl, inputValue);
        });
        text.onChange((value) => {
            inputValue = value;
        });
    });

    addSetting.addButton((btn) =>
        btn.setButtonText("+ Add").onClick(async () => {
            if (!inputValue.trim()) return;
            const trimmed = inputValue.trim();
            if (settings.configSyncPaths.includes(trimmed)) {
                new Notice("Path already added.");
                return;
            }
            const updated = [...settings.configSyncPaths, trimmed];
            await deps.updateSettings({ configSyncPaths: updated });
            deps.refresh();
        })
    );

    // Push / Pull buttons
    new Setting(el)
        .setName("Sync actions")
        .setDesc(`${paths.length} path(s) configured`)
        .addButton((btn) =>
            btn.setButtonText("Push ↑").onClick(async () => {
                btn.setButtonText("Pushing...");
                btn.setDisabled(true);
                try {
                    const count = await deps.configSync.push();
                    new Notice(`CouchSync: Pushed ${count} config file(s).`);
                } catch (e: any) {
                    new Notice(`Push failed: ${e.message}`);
                }
                btn.setButtonText("Push ↑");
                btn.setDisabled(false);
            })
        )
        .addButton((btn) =>
            btn.setButtonText("Pull ↓").onClick(async () => {
                btn.setButtonText("Pulling...");
                btn.setDisabled(true);
                try {
                    const count = await deps.configSync.pull();
                    new Notice(`CouchSync: Pulled ${count} config file(s).`);
                } catch (e: any) {
                    new Notice(`Pull failed: ${e.message}`);
                }
                btn.setButtonText("Pull ↓");
                btn.setDisabled(false);
            })
        );
}

async function loadSuggestions(suggestionsEl: HTMLElement, deps: FilesTabDeps): Promise<void> {
    suggestionsEl.empty();
    suggestionsEl.style.display = "block";

    const currentPaths = new Set(deps.getSettings().configSyncPaths);

    // Common config files
    const commonFiles = deps.configSync.getCommonConfigPaths();
    suggestionsEl.createEl("div", { text: "── Common configs ──", cls: "cs-suggest-header" });
    for (const path of commonFiles) {
        if (currentPaths.has(path)) continue;
        createSuggestionItem(suggestionsEl, path, deps);
    }

    // Plugin folders
    try {
        const pluginFolders = await deps.configSync.listPluginFolders();
        if (pluginFolders.length > 0) {
            suggestionsEl.createEl("div", { text: "── Plugin folders ──", cls: "cs-suggest-header" });
            for (const folder of pluginFolders) {
                if (currentPaths.has(folder)) continue;
                createSuggestionItem(suggestionsEl, folder, deps);
            }
        }
    } catch (e) {
        // ignore
    }
}

function createSuggestionItem(container: HTMLElement, path: string, deps: FilesTabDeps): void {
    const item = container.createDiv({ cls: "cs-suggest-item", text: path });
    item.addEventListener("click", async () => {
        const current = deps.getSettings().configSyncPaths;
        if (!current.includes(path)) {
            await deps.updateSettings({ configSyncPaths: [...current, path] });
            deps.refresh();
        }
    });
}

function filterSuggestions(suggestionsEl: HTMLElement, filter: string): void {
    const items = suggestionsEl.querySelectorAll(".cs-suggest-item");
    const lower = filter.toLowerCase();
    for (const item of items) {
        const el = item as HTMLElement;
        el.style.display = el.textContent?.toLowerCase().includes(lower) ? "" : "none";
    }
}
