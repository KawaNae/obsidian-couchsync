import {
    DEFAULT_SETTINGS,
    E2EEAlgorithmNames,
} from "../../../../lib/src/common/types.ts";
import { $msg } from "../../../../lib/src/common/i18n.ts";
import { LiveSyncSetting as Setting } from "../LiveSyncSetting.ts";
import {
    EVENT_REQUEST_COPY_SETUP_URI,
    EVENT_REQUEST_OPEN_SETUP_URI,
    EVENT_REQUEST_SHOW_SETUP_QR,
    eventHub,
} from "../../../../common/events.ts";
import type { ObsidianLiveSyncSettingTab } from "../ObsidianLiveSyncSettingTab.ts";
import { visibleOnly } from "../SettingPane.ts";
import { SetupManager, UserMode } from "../../SetupManager.ts";
import { OnDialogSettingsDefault, type AllSettings } from "../settingConstants.ts";
import type { ObsidianLiveSyncSettings } from "../../../../lib/src/common/types.ts";

function getSettingsFromEditingSettings(editingSettings: AllSettings): ObsidianLiveSyncSettings {
    const workObj = { ...editingSettings } as ObsidianLiveSyncSettings;
    const keys = Object.keys(OnDialogSettingsDefault);
    for (const k of keys) {
        delete (workObj as any)[k];
    }
    return workObj;
}

export function tabSetup(this: ObsidianLiveSyncSettingTab, el: HTMLElement): void {
    // === CouchDB Connection ===

    el.createEl("h3", { text: "CouchDB Connection", cls: "setting-section-header" });

    new Setting(el).autoWireText("couchDB_URI", { holdValue: true });
    new Setting(el).autoWireText("couchDB_USER", { holdValue: true });
    new Setting(el).autoWireText("couchDB_PASSWORD", { isPassword: true, holdValue: true });
    new Setting(el).autoWireText("couchDB_DBNAME", { holdValue: true });

    new Setting(el)
        .addApplyButton(["couchDB_URI", "couchDB_USER", "couchDB_PASSWORD", "couchDB_DBNAME"]);

    new Setting(el)
        .setName("Test Connection")
        .setDesc("Test the connection to the CouchDB server with the current settings.")
        .addButton((button) => {
            button.setButtonText("Test").onClick(async () => {
                await this.testConnection();
            });
        });

    new Setting(el).autoWireTextArea("couchDB_CustomHeaders", { holdValue: true })
        .addApplyButton(["couchDB_CustomHeaders"]);

    new Setting(el).autoWireToggle("useJWT", {});
    new Setting(el).autoWireText("jwtAlgorithm", {
        onUpdate: visibleOnly(() => this.isConfiguredAs("useJWT", true)),
    });
    new Setting(el).autoWireText("jwtKey", {
        onUpdate: visibleOnly(() => this.isConfiguredAs("useJWT", true)),
    });
    new Setting(el).autoWireText("jwtKid", {
        onUpdate: visibleOnly(() => this.isConfiguredAs("useJWT", true)),
    });
    new Setting(el).autoWireText("jwtSub", {
        onUpdate: visibleOnly(() => this.isConfiguredAs("useJWT", true)),
    });
    new Setting(el).autoWireNumeric("jwtExpDuration", {
        onUpdate: visibleOnly(() => this.isConfiguredAs("useJWT", true)),
    });

    // === Encryption ===

    el.createEl("h3", { text: "Encryption", cls: "setting-section-header" });

    new Setting(el).autoWireToggle("encrypt", {});

    new Setting(el).autoWireText("passphrase", {
        isPassword: true,
        onUpdate: visibleOnly(() => this.isConfiguredAs("encrypt", true)),
    });

    new Setting(el).autoWireToggle("usePathObfuscation", {
        onUpdate: visibleOnly(() => this.isConfiguredAs("encrypt", true)),
    });

    new Setting(el).autoWireDropDown("E2EEAlgorithm", {
        options: E2EEAlgorithmNames,
    });

    new Setting(el)
        .setName("Configure via Dialog")
        .setDesc("Open the E2EE configuration dialog for guided setup.")
        .addButton((button) =>
            button
                .setButtonText("Configure")
                .setWarning()
                .onClick(async () => {
                    const setupManager = this.core.getModule(SetupManager);
                    const originalSettings = getSettingsFromEditingSettings(this.editingSettings);
                    await setupManager.onlyE2EEConfiguration(UserMode.Update, originalSettings);
                })
        );

    // === Setup URI ===

    const setupUriSection = el.createDiv();
    this.handleElement(setupUriSection, visibleOnly(() => this.isConfiguredAs("isConfigured", true)));

    setupUriSection.createEl("h3", { text: $msg("obsidianLiveSyncSettingTab.titleSetupOtherDevices"), cls: "setting-section-header" });

    new Setting(setupUriSection)
        .setName($msg("obsidianLiveSyncSettingTab.nameCopySetupURI"))
        .setDesc($msg("obsidianLiveSyncSettingTab.descCopySetupURI"))
        .addButton((text) => {
            text.setButtonText($msg("obsidianLiveSyncSettingTab.btnCopy")).onClick(() => {
                eventHub.emitEvent(EVENT_REQUEST_COPY_SETUP_URI);
            });
        });

    new Setting(setupUriSection)
        .setName($msg("Setup.ShowQRCode"))
        .setDesc($msg("Setup.ShowQRCode.Desc"))
        .addButton((text) => {
            text.setButtonText($msg("Setup.ShowQRCode")).onClick(() => {
                eventHub.emitEvent(EVENT_REQUEST_SHOW_SETUP_QR);
            });
        });

    new Setting(setupUriSection)
        .setName($msg("obsidianLiveSyncSettingTab.nameConnectSetupURI"))
        .setDesc($msg("obsidianLiveSyncSettingTab.descConnectSetupURI"))
        .addButton((text) => {
            text.setButtonText($msg("obsidianLiveSyncSettingTab.btnUse")).onClick(() => {
                this.closeSetting();
                eventHub.emitEvent(EVENT_REQUEST_OPEN_SETUP_URI);
            });
        });

    // === Reset ===

    const resetSection = el.createDiv();
    this.handleElement(resetSection, visibleOnly(() => this.isConfiguredAs("isConfigured", true)));

    resetSection.createEl("h3", { text: $msg("obsidianLiveSyncSettingTab.titleReset"), cls: "setting-section-header" });

    new Setting(resetSection)
        .setName($msg("obsidianLiveSyncSettingTab.nameDiscardSettings"))
        .addButton((text) => {
            text.setButtonText($msg("obsidianLiveSyncSettingTab.btnDiscard"))
                .onClick(async () => {
                    if (
                        (await this.core.confirm.askYesNoDialog(
                            $msg("obsidianLiveSyncSettingTab.msgDiscardConfirmation"),
                            { defaultOption: "No" }
                        )) == "yes"
                    ) {
                        this.editingSettings = { ...this.editingSettings, ...DEFAULT_SETTINGS };
                        await this.saveAllDirtySettings();
                        this.core.settings = { ...DEFAULT_SETTINGS };
                        await this.services.setting.saveSettingData();
                        await this.services.database.resetDatabase();
                        this.services.appLifecycle.askRestart();
                    }
                })
                .setWarning();
        });
}
