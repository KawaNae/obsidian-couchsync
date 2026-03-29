import { Notice, Platform, Setting } from "obsidian";
import type { CouchSyncSettings } from "../settings.ts";
import type { LocalDB } from "../db/local-db.ts";
import type { Replicator } from "../db/replicator.ts";
import type { ConflictResolver } from "../conflict/conflict-resolver.ts";
import type { StatusBar } from "../ui/status-bar.ts";

interface MaintenanceTabDeps {
    getSettings: () => CouchSyncSettings;
    updateSettings: (patch: Partial<CouchSyncSettings>) => Promise<void>;
    localDb: LocalDB;
    replicator: Replicator;
    conflictResolver: ConflictResolver;
    statusBar: StatusBar;
    onRestart: () => void;
}

export function renderMaintenanceTab(el: HTMLElement, deps: MaintenanceTabDeps): void {
    const settings = deps.getSettings();

    // Mobile status position (only show on mobile)
    if (Platform.isMobile) {
        el.createEl("h3", { text: "Status Indicator" });

        new Setting(el)
            .setName("Align")
            .setDesc("Which side of the screen to show the sync status.")
            .addDropdown((dropdown) => {
                dropdown.addOption("left", "Left");
                dropdown.addOption("right", "Right");
                dropdown.setValue(settings.mobileStatusAlign);
                dropdown.onChange(async (value) => {
                    await deps.updateSettings({ mobileStatusAlign: value as "left" | "right" });
                    deps.statusBar.applyPosition();
                });
            });

        new Setting(el)
            .setName("Bottom (px)")
            .setDesc("Distance from the bottom of the screen.")
            .addText((text) =>
                text.setValue(String(settings.mobileStatusBottom)).onChange(async (value) => {
                    const num = parseInt(value, 10);
                    if (!isNaN(num) && num >= 0) {
                        await deps.updateSettings({ mobileStatusBottom: num });
                        deps.statusBar.applyPosition();
                    }
                })
            );

        new Setting(el)
            .setName("Horizontal offset (px)")
            .setDesc("Distance from the left or right edge.")
            .addText((text) =>
                text.setValue(String(settings.mobileStatusOffset)).onChange(async (value) => {
                    const num = parseInt(value, 10);
                    if (!isNaN(num) && num >= 0) {
                        await deps.updateSettings({ mobileStatusOffset: num });
                        deps.statusBar.applyPosition();
                    }
                })
            );
    }

    // Logging
    el.createEl("h3", { text: "Logging" });

    new Setting(el)
        .setName("Verbose logging")
        .setDesc("Show detailed sync logs in the console.")
        .addToggle((toggle) =>
            toggle.setValue(settings.showVerboseLog).onChange(async (value) => {
                await deps.updateSettings({ showVerboseLog: value });
            })
        );

    // Troubleshooting
    el.createEl("h3", { text: "Troubleshooting" });

    new Setting(el)
        .setName("Resolve all conflicts")
        .setDesc("Auto-resolve all conflicted documents (newer version wins).")
        .addButton((btn) =>
            btn.setButtonText("Resolve").onClick(async () => {
                btn.setButtonText("Resolving...");
                btn.setDisabled(true);
                const count = await deps.conflictResolver.resolveAllConflicts();
                new Notice(`CouchSync: Resolved ${count} conflict(s).`);
                btn.setButtonText("Resolve");
                btn.setDisabled(false);
            })
        );

    // Recovery
    el.createEl("h3", { text: "Recovery" });

    new Setting(el)
        .setName("Restart sync")
        .setDesc("Stop and restart the replication connection.")
        .addButton((btn) =>
            btn.setButtonText("Restart").onClick(() => {
                deps.replicator.stop();
                deps.replicator.start();
                new Notice("CouchSync: Sync restarted.");
            })
        );

    // Reset
    el.createEl("h3", { text: "Reset" });

    new Setting(el)
        .setName("Delete local database")
        .setDesc("Destroy the local PouchDB and restart. Remote data is preserved.")
        .addButton((btn) =>
            btn
                .setButtonText("Delete & Restart")
                .setWarning()
                .onClick(async () => {
                    deps.replicator.stop();
                    await deps.localDb.destroy();
                    new Notice("CouchSync: Local database deleted. Restarting...");
                    deps.onRestart();
                })
        );
}
