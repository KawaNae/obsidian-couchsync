import {
    type ObsidianLiveSyncSettings,
    LOG_LEVEL_NOTICE,
} from "../../../../lib/src/common/types.ts";
import { Logger } from "../../../../lib/src/common/logger.ts";
import { $msg } from "../../../../lib/src/common/i18n.ts";
import { LiveSyncSetting as Setting } from "../LiveSyncSetting.ts";
import type { ObsidianLiveSyncSettingTab } from "../ObsidianLiveSyncSettingTab.ts";
import { visibleOnly } from "../SettingPane.ts";

export function tabSync(this: ObsidianLiveSyncSettingTab, el: HTMLElement): void {
    // ── Sync Preset ──────────────────────────────────────────────────
    el.createEl("h3", { text: $msg("obsidianLiveSyncSettingTab.titleSynchronizationPreset"), cls: "setting-section-header" });

    const options: Record<string, string> = {
        NONE: "",
        LIVESYNC: $msg("obsidianLiveSyncSettingTab.optionLiveSync"),
        PERIODIC: $msg("obsidianLiveSyncSettingTab.optionPeriodicWithBatch"),
        DISABLE: $msg("obsidianLiveSyncSettingTab.optionDisableAllAutomatic"),
    };

    new Setting(el)
        .autoWireDropDown("preset", {
            options: options,
            holdValue: true,
        })
        .addButton((button) => {
            button.setButtonText($msg("obsidianLiveSyncSettingTab.btnApply"));
            button.onClick(async () => {
                await this.saveAllDirtySettings();
            });
        });

    this.addOnSaved("preset", async (currentPreset) => {
        if (currentPreset == "") {
            Logger($msg("obsidianLiveSyncSettingTab.logSelectAnyPreset"), LOG_LEVEL_NOTICE);
            return;
        }
        const presetAllDisabled = {
            batchSave: false,
            liveSync: false,
            periodicReplication: false,
            syncOnSave: false,
            syncOnEditorSave: false,
            syncOnStart: false,
            syncOnFileOpen: false,
            syncAfterMerge: false,
        } as Partial<ObsidianLiveSyncSettings>;
        const presetLiveSync = {
            ...presetAllDisabled,
            liveSync: true,
        } as Partial<ObsidianLiveSyncSettings>;
        const presetPeriodic = {
            ...presetAllDisabled,
            batchSave: true,
            periodicReplication: true,
            syncOnSave: false,
            syncOnEditorSave: false,
            syncOnStart: true,
            syncOnFileOpen: true,
            syncAfterMerge: true,
        } as Partial<ObsidianLiveSyncSettings>;

        if (currentPreset == "LIVESYNC") {
            this.editingSettings = {
                ...this.editingSettings,
                ...presetLiveSync,
            };
            Logger($msg("obsidianLiveSyncSettingTab.logConfiguredLiveSync"), LOG_LEVEL_NOTICE);
        } else if (currentPreset == "PERIODIC") {
            this.editingSettings = {
                ...this.editingSettings,
                ...presetPeriodic,
            };
            Logger($msg("obsidianLiveSyncSettingTab.logConfiguredPeriodic"), LOG_LEVEL_NOTICE);
        } else {
            Logger($msg("obsidianLiveSyncSettingTab.logConfiguredDisabled"), LOG_LEVEL_NOTICE);
            this.editingSettings = {
                ...this.editingSettings,
                ...presetAllDisabled,
            };
        }

        await this.saveAllDirtySettings();
        await this.services.control.applySettings();
    });

    // ── Sync Mode ────────────────────────────────────────────────────
    el.createEl("h3", { text: $msg("obsidianLiveSyncSettingTab.titleSynchronizationMethod"), cls: "setting-section-header" });

    const onlyOnNonLiveSync = visibleOnly(() => !this.isConfiguredAs("syncMode", "LIVESYNC"));
    const onlyOnPeriodic = visibleOnly(() => this.isConfiguredAs("syncMode", "PERIODIC"));

    const optionsSyncMode: Record<string, string> = {
        ONEVENTS: $msg("obsidianLiveSyncSettingTab.optionOnEvents"),
        PERIODIC: $msg("obsidianLiveSyncSettingTab.optionPeriodicAndEvents"),
        LIVESYNC: $msg("obsidianLiveSyncSettingTab.optionLiveSync"),
    };

    new Setting(el)
        .autoWireDropDown("syncMode", {
            //@ts-ignore
            options: optionsSyncMode,
        });
    this.addOnSaved("syncMode", async (value) => {
        this.editingSettings.liveSync = false;
        this.editingSettings.periodicReplication = false;
        if (value == "LIVESYNC") {
            this.editingSettings.liveSync = true;
        } else if (value == "PERIODIC") {
            this.editingSettings.periodicReplication = true;
        }
        await this.saveSettings(["liveSync", "periodicReplication"]);

        await this.services.control.applySettings();
    });

    new Setting(el)
        .autoWireNumeric("periodicReplicationInterval", {
            clampMax: 5000,
            onUpdate: onlyOnPeriodic,
        });

    new Setting(el).autoWireNumeric("syncMinimumInterval", {
        onUpdate: onlyOnNonLiveSync,
    });

    // ── Sync Triggers ────────────────────────────────────────────────
    el.createEl("h3", { text: "Sync Triggers", cls: "setting-section-header" });

    new Setting(el).autoWireToggle("syncOnSave", { onUpdate: onlyOnNonLiveSync });
    new Setting(el).autoWireToggle("syncOnEditorSave", { onUpdate: onlyOnNonLiveSync });
    new Setting(el).autoWireToggle("syncOnFileOpen", { onUpdate: onlyOnNonLiveSync });
    new Setting(el).autoWireToggle("syncOnStart", { onUpdate: onlyOnNonLiveSync });
    new Setting(el).autoWireToggle("syncAfterMerge", { onUpdate: onlyOnNonLiveSync });

    const batchDiv = el.createDiv();
    this.handleElement(batchDiv, visibleOnly(() => !this.isConfiguredAs("syncMode", "LIVESYNC")));

    new Setting(batchDiv).autoWireToggle("batchSave");
    new Setting(batchDiv).autoWireNumeric("batchSaveMinimumDelay", {
        acceptZero: true,
        onUpdate: visibleOnly(() => this.isConfiguredAs("batchSave", true)),
    });
    new Setting(batchDiv).autoWireNumeric("batchSaveMaximumDelay", {
        acceptZero: true,
        onUpdate: visibleOnly(() => this.isConfiguredAs("batchSave", true)),
    });

    // ── Conflict Resolution ──────────────────────────────────────────
    el.createEl("h3", { text: $msg("obsidianLiveSyncSettingTab.titleConflictResolution"), cls: "setting-section-header" });

    new Setting(el).autoWireToggle("resolveConflictsByNewerFile");
    new Setting(el).autoWireToggle("checkConflictOnlyOnOpen");
    new Setting(el).autoWireToggle("showMergeDialogOnlyOnActive");
    new Setting(el).autoWireToggle("disableMarkdownAutoMerge");
    new Setting(el).autoWireToggle("writeDocumentsIfConflicted");

    // ── Deletion ─────────────────────────────────────────────────────
    el.createEl("h3", { text: $msg("obsidianLiveSyncSettingTab.titleDeletionPropagation"), cls: "setting-section-header" });

    new Setting(el).autoWireToggle("trashInsteadDelete");
    new Setting(el).autoWireToggle("doNotDeleteFolder");

    // ── Settings Sync ────────────────────────────────────────────────
    el.createEl("h3", { text: $msg("obsidianLiveSyncSettingTab.titleSyncSettingsViaMarkdown"), cls: "setting-section-header" });

    new Setting(el).autoWireText("settingSyncFile", { holdValue: true }).addApplyButton(["settingSyncFile"]);
    new Setting(el).autoWireToggle("writeCredentialsForSettingSync");
    new Setting(el).autoWireToggle("notifyAllSettingSyncFile");
}
