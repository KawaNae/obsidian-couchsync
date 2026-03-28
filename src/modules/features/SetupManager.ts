import {
    type ObsidianLiveSyncSettings,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    REMOTE_COUCHDB,
} from "../../lib/src/common/types.ts";
import UseSetupURI from "./SetupWizard/dialogs/UseSetupURI.svelte";
import SetupRemoteCouchDB from "./SetupWizard/dialogs/SetupRemoteCouchDB.svelte";
import SetupRemoteE2EE from "./SetupWizard/dialogs/SetupRemoteE2EE.svelte";
import { decodeSettingsFromQRCodeData } from "../../lib/src/API/processSetting.ts";
import { AbstractModule } from "../AbstractModule.ts";

/**
 * User modes for setup
 */
export const enum UserMode {
    NewUser = "new-user",
    ExistingUser = "existing-user",
    Unknown = "unknown",
    // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
    Update = "unknown",
}

/**
 * Setup Manager - handles CouchDB configuration dialogs and Setup URI
 */
export class SetupManager extends AbstractModule {
    get dialogManager() {
        return this.services.UI.dialogManager;
    }

    /**
     * Opens the Setup URI dialog for importing settings
     */
    async onUseSetupURI(userMode: UserMode, setupURI: string = ""): Promise<boolean> {
        const newSetting = await this.dialogManager.openWithExplicitCancel(UseSetupURI, setupURI);
        if (newSetting === "cancelled") {
            this._log("Setup URI dialog cancelled.", LOG_LEVEL_NOTICE);
            return false;
        }
        this._log("Setup URI dialog closed.", LOG_LEVEL_VERBOSE);
        await this.applySetting(newSetting as ObsidianLiveSyncSettings, userMode);
        this._log("Settings from Setup URI applied.", LOG_LEVEL_NOTICE);
        return true;
    }

    /**
     * Opens the CouchDB manual configuration dialog
     */
    async onCouchDBManualSetup(
        userMode: UserMode,
        currentSetting: ObsidianLiveSyncSettings,
        activate = true
    ): Promise<boolean> {
        const baseSetting = JSON.parse(JSON.stringify(currentSetting)) as ObsidianLiveSyncSettings;
        const couchConf = await this.dialogManager.openWithExplicitCancel(SetupRemoteCouchDB, baseSetting);
        if (couchConf === "cancelled") {
            this._log("Manual configuration cancelled.", LOG_LEVEL_NOTICE);
            return false;
        }
        const newSetting = { ...baseSetting, ...(couchConf as object) } as ObsidianLiveSyncSettings;
        if (activate) {
            newSetting.remoteType = REMOTE_COUCHDB;
        }
        await this.applySetting(newSetting, userMode);
        this._log("CouchDB settings applied.", LOG_LEVEL_NOTICE);
        return true;
    }

    /**
     * Opens the E2EE configuration dialog
     */
    async onlyE2EEConfiguration(userMode: UserMode, currentSetting: ObsidianLiveSyncSettings): Promise<boolean> {
        const e2eeConf = await this.dialogManager.openWithExplicitCancel(SetupRemoteE2EE, currentSetting);
        if (e2eeConf === "cancelled") {
            this._log("E2EE configuration cancelled.", LOG_LEVEL_NOTICE);
            return false;
        }
        const newSetting = {
            ...currentSetting,
            ...(e2eeConf as object),
        } as ObsidianLiveSyncSettings;
        await this.applySetting(newSetting, userMode);
        this._log("E2EE settings applied.", LOG_LEVEL_NOTICE);
        return true;
    }

    /**
     * Decodes settings from a QR code string and applies them
     */
    async decodeQR(qr: string) {
        const newSettings = decodeSettingsFromQRCodeData(qr);
        await this.applySetting(newSettings, UserMode.Unknown);
        this._log("Settings from QR code applied.", LOG_LEVEL_NOTICE);
        return true;
    }

    /**
     * Applies new settings to core and saves
     */
    async applySetting(newConf: ObsidianLiveSyncSettings, _userMode: UserMode) {
        const newSetting = {
            ...this.core.settings,
            ...newConf,
        };
        this.core.settings = newSetting;
        this.services.setting.clearUsedPassphrase();
        await this.services.setting.saveSettingData();
        return true;
    }
}
