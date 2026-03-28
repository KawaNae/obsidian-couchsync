import {
    type CustomRegExpSource,
} from "../../../../lib/src/common/types.ts";
import { constructCustomRegExpList, splitCustomRegExpList } from "../../../../lib/src/common/utils.ts";
import { $msg } from "../../../../lib/src/common/i18n.ts";
import { LiveSyncSetting as Setting } from "../LiveSyncSetting.ts";
import { EVENT_REQUEST_OPEN_PLUGIN_SYNC_DIALOG, eventHub } from "../../../../common/events.ts";
import type { ObsidianLiveSyncSettingTab } from "../ObsidianLiveSyncSettingTab.ts";
import { enableOnly, visibleOnly } from "../SettingPane.ts";
import MultipleRegExpControl from "../MultipleRegExpControl.svelte";
import { mount } from "svelte";

export function tabFiles(this: ObsidianLiveSyncSettingTab, el: HTMLElement): void {
    // ── h3: File Filtering ──────────────────────────────────────────────
    el.createEl("h3", { text: "File Filtering" });

    const syncFilesSetting = new Setting(el)
        .setName("Synchronising files")
        .setDesc(
            "(RegExp) Empty to sync all files. Set filter as a regular expression to limit synchronising files."
        );
    mount(MultipleRegExpControl, {
        target: syncFilesSetting.controlEl,
        props: {
            patterns: splitCustomRegExpList(this.editingSettings.syncOnlyRegEx || "" as any, "|[]|"),
            originals: splitCustomRegExpList(this.editingSettings.syncOnlyRegEx || "" as any, "|[]|"),
            apply: async (newPatterns: CustomRegExpSource[]) => {
                this.editingSettings.syncOnlyRegEx = constructCustomRegExpList(newPatterns, "|[]|");
                await this.saveAllDirtySettings();
                this.display();
            },
        },
    });

    const nonSyncFilesSetting = new Setting(el)
        .setName("Non-Synchronising files")
        .setDesc("(RegExp) If this is set, any changes to local and remote files that match this will be skipped.");

    mount(MultipleRegExpControl, {
        target: nonSyncFilesSetting.controlEl,
        props: {
            patterns: splitCustomRegExpList(this.editingSettings.syncIgnoreRegEx || "" as any, "|[]|"),
            originals: splitCustomRegExpList(this.editingSettings.syncIgnoreRegEx || "" as any, "|[]|"),
            apply: async (newPatterns: CustomRegExpSource[]) => {
                this.editingSettings.syncIgnoreRegEx = constructCustomRegExpList(newPatterns, "|[]|");
                await this.saveAllDirtySettings();
                this.display();
            },
        },
    });

    new Setting(el).autoWireNumeric("syncMaxSizeInMB", { clampMin: 0 });

    new Setting(el).autoWireToggle("useIgnoreFiles");
    new Setting(el).autoWireTextArea("ignoreFiles", {
        onUpdate: visibleOnly(() => this.isConfiguredAs("useIgnoreFiles", true)),
    });

    // ── h3: Hidden File Sync ────────────────────────────────────────────
    el.createEl("h3", { text: "Hidden File Sync" });

    const LABEL_ENABLED = $msg("obsidianLiveSyncSettingTab.labelEnabled");
    const LABEL_DISABLED = $msg("obsidianLiveSyncSettingTab.labelDisabled");

    const hiddenFileSyncSetting = new Setting(el)
        .setName($msg("obsidianLiveSyncSettingTab.nameHiddenFileSynchronization"));
    const hiddenFileSyncSettingEl = hiddenFileSyncSetting.settingEl;
    const hiddenFileSyncSettingDiv = hiddenFileSyncSettingEl.createDiv("");
    hiddenFileSyncSettingDiv.innerText = this.editingSettings.syncInternalFiles ? LABEL_ENABLED : LABEL_DISABLED;

    if (this.editingSettings.syncInternalFiles) {
        new Setting(el)
            .setName($msg("obsidianLiveSyncSettingTab.nameDisableHiddenFileSync"))
            .addButton((button) => {
                button.setButtonText($msg("obsidianLiveSyncSettingTab.btnDisable")).onClick(async () => {
                    this.editingSettings.syncInternalFiles = false;
                    await this.saveAllDirtySettings();
                    this.display();
                });
            });
    } else {
        new Setting(el)
            .setName($msg("obsidianLiveSyncSettingTab.nameEnableHiddenFileSync"))
            .addButton((button) => {
                button.setButtonText("Merge").onClick(async () => {
                    this.closeSetting();
                    await this.services.setting.enableOptionalFeature("MERGE");
                });
            })
            .addButton((button) => {
                button.setButtonText("Fetch").onClick(async () => {
                    this.closeSetting();
                    await this.services.setting.enableOptionalFeature("FETCH");
                });
            })
            .addButton((button) => {
                button.setButtonText("Overwrite").onClick(async () => {
                    this.closeSetting();
                    await this.services.setting.enableOptionalFeature("OVERWRITE");
                });
            });
    }

    new Setting(el).autoWireToggle("suppressNotifyHiddenFilesChange", {});
    new Setting(el).autoWireToggle("syncInternalFilesBeforeReplication", {
        onUpdate: visibleOnly(() => this.isConfiguredAs("watchInternalFileChanges", true)),
    });

    new Setting(el).autoWireNumeric("syncInternalFilesInterval", {
        clampMin: 10,
        acceptZero: true,
    });

    const targetPatternSetting = new Setting(el)
        .setName("Target patterns")
        .setDesc("Patterns to match files for syncing");
    const patTarget = splitCustomRegExpList(this.editingSettings.syncInternalFilesTargetPatterns || "" as any, ",");
    mount(MultipleRegExpControl, {
        target: targetPatternSetting.controlEl,
        props: {
            patterns: patTarget,
            originals: [...patTarget],
            apply: async (newPatterns: CustomRegExpSource[]) => {
                this.editingSettings.syncInternalFilesTargetPatterns = constructCustomRegExpList(newPatterns, ",");
                await this.saveAllDirtySettings();
                this.display();
            },
        },
    });

    const defaultSkipPattern = "\\/node_modules\\/, \\/\\.git\\/, ^\\.git\\/, \\/obsidian-couchsync\\/";
    const defaultSkipPatternXPlat =
        defaultSkipPattern + ",\\/workspace$ ,\\/workspace.json$,\\/workspace-mobile.json$";

    const pat = splitCustomRegExpList(this.editingSettings.syncInternalFilesIgnorePatterns || "" as any, ",");
    const patSetting = new Setting(el).setName("Ignore patterns").setDesc("");

    mount(MultipleRegExpControl, {
        target: patSetting.controlEl,
        props: {
            patterns: pat,
            originals: [...pat],
            apply: async (newPatterns: CustomRegExpSource[]) => {
                this.editingSettings.syncInternalFilesIgnorePatterns = constructCustomRegExpList(newPatterns, ",");
                await this.saveAllDirtySettings();
                this.display();
            },
        },
    });

    const addDefaultPatterns = async (patterns: string) => {
        const oldList = splitCustomRegExpList(this.editingSettings.syncInternalFilesIgnorePatterns || "" as any, ",");
        const newList = splitCustomRegExpList(
            patterns as unknown as typeof this.editingSettings.syncInternalFilesIgnorePatterns,
            ","
        );
        const allSet = new Set<CustomRegExpSource>([...oldList, ...newList]);
        this.editingSettings.syncInternalFilesIgnorePatterns = constructCustomRegExpList([...allSet], ",");
        await this.saveAllDirtySettings();
        this.display();
    };

    new Setting(el)
        .setName("Add default patterns")
        .addButton((button) => {
            button.setButtonText("Default").onClick(async () => {
                await addDefaultPatterns(defaultSkipPattern);
            });
        })
        .addButton((button) => {
            button.setButtonText("Cross-platform").onClick(async () => {
                await addDefaultPatterns(defaultSkipPatternXPlat);
            });
        });

    const overwritePatterns = new Setting(el)
        .setName("Overwrite patterns")
        .setDesc("Patterns to match files for overwriting instead of merging");
    const patTarget2 = splitCustomRegExpList(this.editingSettings.syncInternalFileOverwritePatterns || "" as any, ",");
    mount(MultipleRegExpControl, {
        target: overwritePatterns.controlEl,
        props: {
            patterns: patTarget2,
            originals: [...patTarget2],
            apply: async (newPatterns: CustomRegExpSource[]) => {
                this.editingSettings.syncInternalFileOverwritePatterns = constructCustomRegExpList(
                    newPatterns,
                    ","
                );
                await this.saveAllDirtySettings();
                this.display();
            },
        },
    });

    // ── h3: Plugin Sync ─────────────────────────────────────────────────
    el.createEl("h3", { text: "Plugin Sync" });

    const enableOnlyOnPluginSyncIsNotEnabled = enableOnly(() => this.isConfiguredAs("usePluginSync", false));
    const visibleOnlyOnPluginSyncEnabled = visibleOnly(() => this.isConfiguredAs("usePluginSync", true));

    this.createEl(
        el,
        "div",
        {
            text: "Please set device name to identify this device. This name should be unique among your devices. While not configured, we cannot enable this feature.",
            cls: "op-warn",
        },
        (c) => {},
        visibleOnly(() => this.isConfiguredAs("deviceAndVaultName", ""))
    );
    this.createEl(
        el,
        "div",
        {
            text: "We cannot change the device name while this feature is enabled. Please disable this feature to change the device name.",
            cls: "op-warn-info",
        },
        (c) => {},
        visibleOnly(() => this.isConfiguredAs("usePluginSync", true))
    );

    new Setting(el).autoWireText("deviceAndVaultName", {
        placeHolder: "desktop",
        onUpdate: enableOnlyOnPluginSyncIsNotEnabled,
    });

    new Setting(el).autoWireToggle("usePluginSyncV2");

    new Setting(el).autoWireToggle("usePluginSync", {
        onUpdate: enableOnly(() => !this.isConfiguredAs("deviceAndVaultName", "")),
    });

    new Setting(el).autoWireToggle("autoSweepPlugins", {
        onUpdate: visibleOnlyOnPluginSyncEnabled,
    });

    new Setting(el).autoWireToggle("autoSweepPluginsPeriodic", {
        onUpdate: visibleOnly(
            () => this.isConfiguredAs("usePluginSync", true) && this.isConfiguredAs("autoSweepPlugins", true)
        ),
    });
    new Setting(el).autoWireToggle("notifyPluginOrSettingUpdated", {
        onUpdate: visibleOnlyOnPluginSyncEnabled,
    });

    new Setting(el)
        .setName("Open")
        .setDesc("Open the dialog")
        .addButton((button) => {
            button
                .setButtonText("Open")
                .setDisabled(false)
                .onClick(() => {
                    eventHub.emitEvent(EVENT_REQUEST_OPEN_PLUGIN_SYNC_DIALOG);
                });
        })
        .addOnUpdate(visibleOnlyOnPluginSyncEnabled);
}
