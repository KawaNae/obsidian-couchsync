import {
    type CustomRegExpSource,
} from "../../../../lib/src/common/types.ts";
import { constructCustomRegExpList, splitCustomRegExpList } from "../../../../lib/src/common/utils.ts";
import { LiveSyncSetting as Setting } from "../LiveSyncSetting.ts";
import { EVENT_REQUEST_OPEN_PLUGIN_SYNC_DIALOG, eventHub } from "../../../../common/events.ts";
import type { ObsidianLiveSyncSettingTab } from "../ObsidianLiveSyncSettingTab.ts";
import type { PageFunctions } from "../SettingPane.ts";
import { enableOnly, visibleOnly } from "../SettingPane.ts";
import MultipleRegExpControl from "../MultipleRegExpControl.svelte";
import { mount } from "svelte";

export function tabFiles(this: ObsidianLiveSyncSettingTab, paneEl: HTMLElement, { addPanel }: PageFunctions): void {
    // --- PaneSelector: Normal Files ---
    void addPanel(paneEl, "Normal Files").then((paneEl) => {
        paneEl;

        const syncFilesSetting = new Setting(paneEl)
            .setName("Synchronising files")
            .setDesc(
                "(RegExp) Empty to sync all files. Set filter as a regular expression to limit synchronising files."
            )
            ;
        mount(MultipleRegExpControl, {
            target: syncFilesSetting.controlEl,
            props: {
                patterns: splitCustomRegExpList(this.editingSettings.syncOnlyRegEx, "|[]|"),
                originals: splitCustomRegExpList(this.editingSettings.syncOnlyRegEx, "|[]|"),
                apply: async (newPatterns: CustomRegExpSource[]) => {
                    this.editingSettings.syncOnlyRegEx = constructCustomRegExpList(newPatterns, "|[]|");
                    await this.saveAllDirtySettings();
                    this.display();
                },
            },
        });

        const nonSyncFilesSetting = new Setting(paneEl)
            .setName("Non-Synchronising files")
            .setDesc("(RegExp) If this is set, any changes to local and remote files that match this will be skipped.")
            ;

        mount(MultipleRegExpControl, {
            target: nonSyncFilesSetting.controlEl,
            props: {
                patterns: splitCustomRegExpList(this.editingSettings.syncIgnoreRegEx, "|[]|"),
                originals: splitCustomRegExpList(this.editingSettings.syncIgnoreRegEx, "|[]|"),
                apply: async (newPatterns: CustomRegExpSource[]) => {
                    this.editingSettings.syncIgnoreRegEx = constructCustomRegExpList(newPatterns, "|[]|");
                    await this.saveAllDirtySettings();
                    this.display();
                },
            },
        });
        new Setting(paneEl).autoWireNumeric("syncMaxSizeInMB", { clampMin: 0 });

        new Setting(paneEl).autoWireToggle("useIgnoreFiles");
        new Setting(paneEl).autoWireTextArea("ignoreFiles", {
            onUpdate: visibleOnly(() => this.isConfiguredAs("useIgnoreFiles", true)),
        });
    });

    // --- PaneSelector: Hidden Files ---
    void addPanel(paneEl, "Hidden Files").then((paneEl) => {
        const targetPatternSetting = new Setting(paneEl)
            .setName("Target patterns")

            .setDesc("Patterns to match files for syncing");
        const patTarget = splitCustomRegExpList(this.editingSettings.syncInternalFilesTargetPatterns, ",");
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

        const defaultSkipPattern = "\\/node_modules\\/, \\/\\.git\\/, ^\\.git\\/, \\/obsidian-livesync\\/";
        const defaultSkipPatternXPlat =
            defaultSkipPattern + ",\\/workspace$ ,\\/workspace.json$,\\/workspace-mobile.json$";

        const pat = splitCustomRegExpList(this.editingSettings.syncInternalFilesIgnorePatterns, ",");
        const patSetting = new Setting(paneEl).setName("Ignore patterns").setDesc("");

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
            const oldList = splitCustomRegExpList(this.editingSettings.syncInternalFilesIgnorePatterns, ",");
            const newList = splitCustomRegExpList(
                patterns as unknown as typeof this.editingSettings.syncInternalFilesIgnorePatterns,
                ","
            );
            const allSet = new Set<CustomRegExpSource>([...oldList, ...newList]);
            this.editingSettings.syncInternalFilesIgnorePatterns = constructCustomRegExpList([...allSet], ",");
            await this.saveAllDirtySettings();
            this.display();
        };

        new Setting(paneEl)
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

        const overwritePatterns = new Setting(paneEl)
            .setName("Overwrite patterns")

            .setDesc("Patterns to match files for overwriting instead of merging");
        const patTarget2 = splitCustomRegExpList(this.editingSettings.syncInternalFileOverwritePatterns, ",");
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
    });

    // --- PaneCustomisationSync: Customization Sync ---
    // With great respect, thank you TfTHacker!
    // Refer: https://github.com/TfTHacker/obsidian42-brat/blob/main/src/features/BetaPlugins.ts
    void addPanel(paneEl, "Customization Sync").then((paneEl) => {
        const enableOnlyOnPluginSyncIsNotEnabled = enableOnly(() => this.isConfiguredAs("usePluginSync", false));
        const visibleOnlyOnPluginSyncEnabled = visibleOnly(() => this.isConfiguredAs("usePluginSync", true));

        this.createEl(
            paneEl,
            "div",
            {
                text: "Please set device name to identify this device. This name should be unique among your devices. While not configured, we cannot enable this feature.",
                cls: "op-warn",
            },
            (c) => {},
            visibleOnly(() => this.isConfiguredAs("deviceAndVaultName", ""))
        );
        this.createEl(
            paneEl,
            "div",
            {
                text: "We cannot change the device name while this feature is enabled. Please disable this feature to change the device name.",
                cls: "op-warn-info",
            },
            (c) => {},
            visibleOnly(() => this.isConfiguredAs("usePluginSync", true))
        );

        new Setting(paneEl).autoWireText("deviceAndVaultName", {
            placeHolder: "desktop",
            onUpdate: enableOnlyOnPluginSyncIsNotEnabled,
        });

        new Setting(paneEl).autoWireToggle("usePluginSyncV2");

        new Setting(paneEl).autoWireToggle("usePluginSync", {
            onUpdate: enableOnly(() => !this.isConfiguredAs("deviceAndVaultName", "")),
        });

        new Setting(paneEl).autoWireToggle("autoSweepPlugins", {
            onUpdate: visibleOnlyOnPluginSyncEnabled,
        });

        new Setting(paneEl).autoWireToggle("autoSweepPluginsPeriodic", {
            onUpdate: visibleOnly(
                () => this.isConfiguredAs("usePluginSync", true) && this.isConfiguredAs("autoSweepPlugins", true)
            ),
        });
        new Setting(paneEl).autoWireToggle("notifyPluginOrSettingUpdated", {
            onUpdate: visibleOnlyOnPluginSyncEnabled,
        });

        new Setting(paneEl)
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
    });
}
