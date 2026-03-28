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
import type { PageFunctions } from "../SettingPane.ts";
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

export function tabSetup(
    this: ObsidianLiveSyncSettingTab,
    paneEl: HTMLElement,
    { addPanel }: PageFunctions
): void {
    // === CouchDB Connection ===

    void addPanel(paneEl, "CouchDB Connection").then((paneEl) => {
        new Setting(paneEl).autoWireText("couchDB_URI", { holdValue: true });
        new Setting(paneEl).autoWireText("couchDB_USER", { holdValue: true });
        new Setting(paneEl).autoWireText("couchDB_PASSWORD", { isPassword: true, holdValue: true });
        new Setting(paneEl).autoWireText("couchDB_DBNAME", { holdValue: true });

        new Setting(paneEl)
            .addApplyButton(["couchDB_URI", "couchDB_USER", "couchDB_PASSWORD", "couchDB_DBNAME"]);

        new Setting(paneEl)
            .setName("Test Connection")
            .setDesc("Test the connection to the CouchDB server with the current settings.")
            .addButton((button) => {
                button.setButtonText("Test").onClick(async () => {
                    await this.testConnection();
                });
            });

        new Setting(paneEl).autoWireTextArea("couchDB_CustomHeaders", { holdValue: true })
            .addApplyButton(["couchDB_CustomHeaders"]);

        new Setting(paneEl).autoWireToggle("useJWT", {});
        new Setting(paneEl).autoWireText("jwtAlgorithm", {
            onUpdate: visibleOnly(() => this.isConfiguredAs("useJWT", true)),
        });
        new Setting(paneEl).autoWireText("jwtKey", {
            onUpdate: visibleOnly(() => this.isConfiguredAs("useJWT", true)),
        });
        new Setting(paneEl).autoWireText("jwtKid", {
            onUpdate: visibleOnly(() => this.isConfiguredAs("useJWT", true)),
        });
        new Setting(paneEl).autoWireText("jwtSub", {
            onUpdate: visibleOnly(() => this.isConfiguredAs("useJWT", true)),
        });
        new Setting(paneEl).autoWireNumeric("jwtExpDuration", {
            onUpdate: visibleOnly(() => this.isConfiguredAs("useJWT", true)),
        });
    });

    // === Encryption ===

    void addPanel(paneEl, "Encryption").then((paneEl) => {
        new Setting(paneEl).autoWireToggle("encrypt", {});

        new Setting(paneEl).autoWireText("passphrase", {
            isPassword: true,
            onUpdate: visibleOnly(() => this.isConfiguredAs("encrypt", true)),
        });

        new Setting(paneEl).autoWireToggle("usePathObfuscation", {
            onUpdate: visibleOnly(() => this.isConfiguredAs("encrypt", true)),
        });

        new Setting(paneEl).autoWireDropDown("E2EEAlgorithm", {
            options: E2EEAlgorithmNames,
        });

        new Setting(paneEl)
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
    });

    // === Setup URI ===

    void addPanel(
        paneEl,
        $msg("obsidianLiveSyncSettingTab.titleSetupOtherDevices"),
        undefined,
        visibleOnly(() => this.isConfiguredAs("isConfigured", true))
    ).then((paneEl) => {
        new Setting(paneEl)
            .setName($msg("obsidianLiveSyncSettingTab.nameCopySetupURI"))
            .setDesc($msg("obsidianLiveSyncSettingTab.descCopySetupURI"))
            .addButton((text) => {
                text.setButtonText($msg("obsidianLiveSyncSettingTab.btnCopy")).onClick(() => {
                    eventHub.emitEvent(EVENT_REQUEST_COPY_SETUP_URI);
                });
            });

        new Setting(paneEl)
            .setName($msg("Setup.ShowQRCode"))
            .setDesc($msg("Setup.ShowQRCode.Desc"))
            .addButton((text) => {
                text.setButtonText($msg("Setup.ShowQRCode")).onClick(() => {
                    eventHub.emitEvent(EVENT_REQUEST_SHOW_SETUP_QR);
                });
            });

        new Setting(paneEl)
            .setName($msg("obsidianLiveSyncSettingTab.nameConnectSetupURI"))
            .setDesc($msg("obsidianLiveSyncSettingTab.descConnectSetupURI"))
            .addButton((text) => {
                text.setButtonText($msg("obsidianLiveSyncSettingTab.btnUse")).onClick(() => {
                    this.closeSetting();
                    eventHub.emitEvent(EVENT_REQUEST_OPEN_SETUP_URI);
                });
            });
    });

    // === Reset ===

    void addPanel(
        paneEl,
        $msg("obsidianLiveSyncSettingTab.titleReset"),
        undefined,
        visibleOnly(() => this.isConfiguredAs("isConfigured", true))
    ).then((paneEl) => {
        new Setting(paneEl)
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
    });
}
