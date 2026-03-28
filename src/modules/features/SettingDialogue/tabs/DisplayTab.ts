import {
    type ConfigPassphraseStore,
} from "../../../../lib/src/common/types.ts";
import { LiveSyncSetting as Setting } from "../LiveSyncSetting.ts";
import { EVENT_ON_UNRESOLVED_ERROR, eventHub } from "../../../../common/events.ts";
import type { ObsidianLiveSyncSettingTab } from "../ObsidianLiveSyncSettingTab.ts";
import { visibleOnly } from "../SettingPane.ts";
import { $msg, $t } from "../../../../lib/src/common/i18n.ts";
import { SUPPORTED_I18N_LANGS, type I18N_LANGS } from "../../../../lib/src/common/rosetta.ts";
import { NetworkWarningStyles } from "../../../../lib/src/common/models/setting.const.ts";

export function tabDisplay(this: ObsidianLiveSyncSettingTab, el: HTMLElement): void {
    // --- Appearance ---
    el.createEl("h3", { text: $msg("obsidianLiveSyncSettingTab.titleAppearance"), cls: "setting-section-header" });

    const languages = Object.fromEntries([
        ...SUPPORTED_I18N_LANGS.map((e) => [e, $t(`lang-${e}`)]),
    ]) as Record<I18N_LANGS, string>;
    new Setting(el).autoWireDropDown("displayLanguage", {
        options: languages,
    });
    this.addOnSaved("displayLanguage", () => this.display());

    new Setting(el).autoWireToggle("showStatusOnEditor");
    new Setting(el).autoWireToggle("showOnlyIconsOnEditor", {
        onUpdate: visibleOnly(() => this.isConfiguredAs("showStatusOnEditor", true)),
    });
    new Setting(el).autoWireToggle("showStatusOnStatusbar");
    new Setting(el).autoWireToggle("hideFileWarningNotice");
    new Setting(el).autoWireDropDown("networkWarningStyle", {
        options: {
            [NetworkWarningStyles.BANNER]: "Show full banner",
            [NetworkWarningStyles.ICON]: "Show icon only",
            [NetworkWarningStyles.HIDDEN]: "Hide completely",
        },
    });
    this.addOnSaved("networkWarningStyle", () => {
        eventHub.emitEvent(EVENT_ON_UNRESOLVED_ERROR);
    });

    // --- Logging ---
    el.createEl("h3", { text: $msg("obsidianLiveSyncSettingTab.titleLogging"), cls: "setting-section-header" });

    new Setting(el).autoWireToggle("lessInformationInLog");
    new Setting(el).autoWireToggle("showVerboseLog", {
        onUpdate: visibleOnly(() => this.isConfiguredAs("lessInformationInLog", false)),
    });
    new Setting(el).autoWireToggle("writeLogToTheFile");
    new Setting(el).autoWireToggle("enableDebugTools");

    // --- Diagnostics ---
    el.createEl("h3", { text: "Diagnostics", cls: "setting-section-header" });

    new Setting(el).autoWireToggle("suspendFileWatching");
    this.addOnSaved("suspendFileWatching", () => this.services.appLifecycle.askRestart());

    new Setting(el).autoWireToggle("suspendParseReplicationResult");
    this.addOnSaved("suspendParseReplicationResult", () => this.services.appLifecycle.askRestart());

    // --- Configuration Security ---
    el.createEl("h3", { text: "Configuration Security", cls: "setting-section-header" });

    const passphrase_options: Record<ConfigPassphraseStore, string> = {
        "": "Default",
        LOCALSTORAGE: "Use a custom passphrase",
        ASK_AT_LAUNCH: "Ask an passphrase at every launch",
    };

    new Setting(el)
        .setName("Encrypting sensitive configuration items")
        .autoWireDropDown("configPassphraseStore", {
            options: passphrase_options,
            holdValue: true,
        });

    new Setting(el)
        .autoWireText("configPassphrase", { isPassword: true, holdValue: true })
        .addOnUpdate(() => ({
            disabled: !this.isConfiguredAs("configPassphraseStore", "LOCALSTORAGE"),
        }));
    new Setting(el).addApplyButton(["configPassphrase", "configPassphraseStore"]);
}
