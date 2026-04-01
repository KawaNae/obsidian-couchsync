import { Notice, Setting } from "obsidian";
import type { CouchSyncSettings } from "../settings.ts";
import type { HistoryManager } from "../history/history-manager.ts";

interface HistoryTabDeps {
    getSettings: () => CouchSyncSettings;
    updateSettings: (patch: Partial<CouchSyncSettings>) => Promise<void>;
    historyManager: HistoryManager;
}

export function renderHistoryTab(el: HTMLElement, deps: HistoryTabDeps): void {
    const settings = deps.getSettings();

    el.createEl("h3", { text: "Diff History" });

    new Setting(el)
        .setName("Retention period (days)")
        .setDesc("How many days to keep diff history.")
        .addText((text) => text
            .setValue(String(settings.historyRetentionDays))
            .onChange(async (value) => {
                const num = parseInt(value, 10);
                if (!isNaN(num) && num >= 1) {
                    await deps.updateSettings({ historyRetentionDays: num });
                }
            })
        );

    new Setting(el)
        .setName("Debounce interval (seconds)")
        .setDesc("Wait after last edit before saving a diff.")
        .addText((text) => text
            .setValue(String(settings.historyDebounceMs / 1000))
            .onChange(async (value) => {
                const num = parseFloat(value);
                if (!isNaN(num) && num >= 1) {
                    await deps.updateSettings({ historyDebounceMs: num * 1000 });
                }
            })
        );

    new Setting(el)
        .setName("Minimum interval (seconds)")
        .setDesc("Minimum time between consecutive saves for the same file.")
        .addText((text) => text
            .setValue(String(settings.historyMinIntervalMs / 1000))
            .onChange(async (value) => {
                const num = parseFloat(value);
                if (!isNaN(num) && num >= 1) {
                    await deps.updateSettings({ historyMinIntervalMs: num * 1000 });
                }
            })
        );

    new Setting(el)
        .setName("Exclude patterns")
        .setDesc("Glob patterns to exclude from history (one per line).")
        .addTextArea((text) => text
            .setPlaceholder("templates/**\ndaily/**")
            .setValue(settings.historyExcludePatterns.join("\n"))
            .onChange(async (value) => {
                await deps.updateSettings({
                    historyExcludePatterns: value.split("\n").map((s) => s.trim()).filter(Boolean),
                });
            })
        );

    new Setting(el)
        .setName("Clear all history")
        .setDesc("Permanently delete all saved diffs and snapshots.")
        .addButton((btn) => btn
            .setButtonText("Clear")
            .setWarning()
            .onClick(async () => {
                await deps.historyManager.clearAllHistory();
                new Notice("All diff history cleared.");
            })
        );
}
