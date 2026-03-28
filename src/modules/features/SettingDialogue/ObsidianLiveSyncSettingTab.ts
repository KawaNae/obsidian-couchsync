import { App, PluginSettingTab } from "../../../deps.ts";
import {
    type ObsidianLiveSyncSettings,
    type RemoteDBSettings,
    LOG_LEVEL_NOTICE,
    FLAGMD_REDFLAG2_HR,
    FLAGMD_REDFLAG3_HR,
    REMOTE_COUCHDB,
} from "../../../lib/src/common/types.ts";
import { delay, isObjectDifferent, sizeToHumanReadable } from "../../../lib/src/common/utils.ts";
import { versionNumberString2Number } from "../../../lib/src/string_and_binary/convert.ts";
import { Logger } from "../../../lib/src/common/logger.ts";
import { checkSyncInfo } from "@lib/pouchdb/negotiation.ts";
import { testCrypt } from "octagonal-wheels/encryption/encryption";
import ObsidianLiveSyncPlugin from "../../../main.ts";
import { scheduleTask } from "../../../common/utils.ts";
import { LiveSyncCouchDBReplicator } from "../../../lib/src/replication/couchdb/LiveSyncReplicator.ts";
import {
    type AllSettingItemKey,
    type AllStringItemKey,
    type AllNumericItemKey,
    type AllBooleanItemKey,
    type AllSettings,
    OnDialogSettingsDefault,
    type OnDialogSettings,
    getConfName,
} from "./settingConstants.ts";
import { $msg } from "../../../lib/src/common/i18n.ts";
import { LiveSyncSetting as Setting } from "./LiveSyncSetting.ts";
import { fireAndForget, yieldNextAnimationFrame } from "octagonal-wheels/promises";
import { confirmWithMessage } from "../../coreObsidian/UILib/dialogs.ts";
import { EVENT_REQUEST_RELOAD_SETTING_TAB, eventHub } from "../../../common/events.ts";
import {
    enableOnly,
    visibleOnly,
    type OnSavedHandler,
    type OnUpdateFunc,
    type OnUpdateResult,
    type PageFunctions,
    type UpdateFunction,
} from "./SettingPane.ts";
import { tabSetup } from "./tabs/SetupTab.ts";
import { tabSync } from "./tabs/SyncTab.ts";
import { tabFiles } from "./tabs/FilesTab.ts";
import { tabAdvanced } from "./tabs/AdvancedTab.ts";
import { tabMaintenance } from "./tabs/MaintenanceTab.ts";

export class ObsidianLiveSyncSettingTab extends PluginSettingTab {
    plugin: ObsidianLiveSyncPlugin;
    get core() {
        return this.plugin.core;
    }
    get services() {
        return this.core.services;
    }
    selectedScreen = "";

    _editingSettings?: AllSettings;
    // Buffered Settings for editing
    get editingSettings(): AllSettings {
        if (!this._editingSettings) {
            this.reloadAllSettings();
        }
        return this._editingSettings!;
    }
    set editingSettings(v) {
        if (!this._editingSettings) {
            this.reloadAllSettings();
        }
        this._editingSettings = v;
    }

    // Buffered Settings for comparing.
    initialSettings?: typeof this.editingSettings;

    /**
     * Apply editing setting to the plug-in.
     * @param keys setting keys for applying
     */
    applySetting(keys: AllSettingItemKey[]) {
        for (const k of keys) {
            if (!this.isDirty(k)) continue;
            if (k in OnDialogSettingsDefault) {
                // //@ts-ignore
                // this.initialSettings[k] = this.editingSettings[k];
                continue;
            }
            //@ts-ignore
            this.core.settings[k] = this.editingSettings[k];
            //@ts-ignore
            this.initialSettings[k] = this.core.settings[k];
        }
        keys.forEach((e) => this.refreshSetting(e));
    }
    applyAllSettings() {
        const changedKeys = (Object.keys(this.editingSettings ?? {}) as AllSettingItemKey[]).filter((e) =>
            this.isDirty(e)
        );
        this.applySetting(changedKeys);
        this.reloadAllSettings();
    }

    async saveLocalSetting(key: keyof typeof OnDialogSettingsDefault) {
        if (key == "configPassphrase") {
            localStorage.setItem("ls-setting-passphrase", this.editingSettings?.[key] ?? "");
            return await Promise.resolve();
        }
        if (key == "deviceAndVaultName") {
            this.services.setting.setDeviceAndVaultName(this.editingSettings?.[key] ?? "");
            this.services.setting.saveDeviceAndVaultName();
            return await Promise.resolve();
        }
    }
    /**
     * Apply and save setting to the plug-in.
     * @param keys setting keys for applying
     */
    async saveSettings(keys: AllSettingItemKey[]) {
        let hasChanged = false;
        const appliedKeys = [] as AllSettingItemKey[];
        for (const k of keys) {
            if (!this.isDirty(k)) continue;
            appliedKeys.push(k);
            if (k in OnDialogSettingsDefault) {
                await this.saveLocalSetting(k as keyof OnDialogSettings);
                //@ts-ignore
                this.initialSettings[k] = this.editingSettings[k];
                continue;
            }
            //@ts-ignore
            this.core.settings[k] = this.editingSettings[k];
            //@ts-ignore
            this.initialSettings[k] = this.core.settings[k];
            hasChanged = true;
        }

        if (hasChanged) {
            await this.services.setting.saveSettingData();
        }

        // if (runOnSaved) {
        const handlers = this.onSavedHandlers
            .filter((e) => appliedKeys.indexOf(e.key) !== -1)
            .map((e) => e.handler(this.editingSettings[e.key as AllSettingItemKey]));
        await Promise.all(handlers);
        // }
        keys.forEach((e) => this.refreshSetting(e));
    }

    /**
     * Apply all editing setting to the plug-in.
     * @param keys setting keys for applying
     */
    async saveAllDirtySettings() {
        const changedKeys = (Object.keys(this.editingSettings ?? {}) as AllSettingItemKey[]).filter((e) =>
            this.isDirty(e)
        );
        await this.saveSettings(changedKeys);
        this.reloadAllSettings();
    }

    /**
     * Invalidate buffered value and fetch the latest.
     */
    requestUpdate() {
        scheduleTask("update-setting", 10, () => {
            for (const setting of this.settingComponents) {
                setting._onUpdate();
            }
            for (const func of this.controlledElementFunc) {
                func();
            }
        });
    }

    reloadAllLocalSettings() {
        const ret = { ...OnDialogSettingsDefault };
        ret.configPassphrase = localStorage.getItem("ls-setting-passphrase") || "";
        ret.preset = "";
        ret.deviceAndVaultName = this.services.setting.getDeviceAndVaultName();
        return ret;
    }
    computeAllLocalSettings(): Partial<OnDialogSettings> {
        const syncMode = this.editingSettings?.liveSync
            ? "LIVESYNC"
            : this.editingSettings?.periodicReplication
              ? "PERIODIC"
              : "ONEVENTS";
        return {
            syncMode,
        };
    }
    /**
     * Reread all settings and request invalidate
     */
    reloadAllSettings(skipUpdate: boolean = false) {
        const localSetting = this.reloadAllLocalSettings();
        this._editingSettings = { ...this.core.settings, ...localSetting };
        this._editingSettings = { ...this.editingSettings, ...this.computeAllLocalSettings() };
        this.initialSettings = { ...this.editingSettings };
        if (!skipUpdate) this.requestUpdate();
    }

    /**
     * Reread each setting and request invalidate
     */
    refreshSetting(key: AllSettingItemKey) {
        const localSetting = this.reloadAllLocalSettings();
        if (key in this.core.settings) {
            if (key in localSetting) {
                //@ts-ignore
                this.initialSettings[key] = localSetting[key];
                //@ts-ignore
                this.editingSettings[key] = localSetting[key];
            } else {
                //@ts-ignore
                this.initialSettings[key] = this.core.settings[key];
                //@ts-ignore
                this.editingSettings[key] = this.initialSettings[key];
            }
        }
        this.editingSettings = { ...this.editingSettings, ...this.computeAllLocalSettings() };
        // this.initialSettings = { ...this.initialSettings };
        this.requestUpdate();
    }

    isDirty(key: AllSettingItemKey) {
        return isObjectDifferent(this.editingSettings[key], this.initialSettings?.[key]);
    }
    isSomeDirty(keys: AllSettingItemKey[]) {
        // if (debug) {
        //     console.dir(keys);
        //     console.dir(keys.map(e => this.isDirty(e)));
        // }
        return keys.some((e) => this.isDirty(e));
    }

    isConfiguredAs(key: AllStringItemKey, value: string): boolean;
    isConfiguredAs(key: AllNumericItemKey, value: number): boolean;
    isConfiguredAs(key: AllBooleanItemKey, value: boolean): boolean;
    isConfiguredAs(key: AllSettingItemKey, value: AllSettings[typeof key]) {
        if (!this.editingSettings) {
            return false;
        }
        return this.editingSettings[key] == value;
    }
    // UI Element Wrapper -->
    settingComponents = [] as Setting[];
    controlledElementFunc = [] as UpdateFunction[];
    onSavedHandlers = [] as OnSavedHandler<any>[];

    constructor(app: App, plugin: ObsidianLiveSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
        Setting.env = this;
        eventHub.onEvent(EVENT_REQUEST_RELOAD_SETTING_TAB, () => {
            this.requestReload();
        });
    }

    async testConnection(settingOverride: Partial<ObsidianLiveSyncSettings> = {}): Promise<void> {
        const trialSetting = { ...this.editingSettings, ...settingOverride };
        const replicator = await this.services.replicator.getNewReplicator(trialSetting);
        if (!replicator) {
            Logger("No replicator available for the current settings.", LOG_LEVEL_NOTICE);
            return;
        }
        await replicator.tryConnectRemote(trialSetting);
        const status = await replicator.getRemoteStatus(trialSetting);
        if (status) {
            if (status.estimatedSize) {
                Logger(
                    $msg("obsidianLiveSyncSettingTab.logEstimatedSize", {
                        size: sizeToHumanReadable(status.estimatedSize),
                    }),
                    LOG_LEVEL_NOTICE
                );
            }
        }
    }

    closeSetting() {
        //@ts-ignore :
        this.plugin.app.setting.close();
    }

    handleElement(element: HTMLElement, func: OnUpdateFunc) {
        const updateFunc = ((element, func) => {
            const prev = {} as OnUpdateResult;
            return () => {
                const newValue = func();
                const keys = Object.keys(newValue) as [keyof OnUpdateResult];
                for (const k of keys) {
                    if (prev[k] !== newValue[k]) {
                        if (k == "visibility") {
                            element.toggleClass("sls-setting-hidden", !(newValue[k] || false));
                        }
                        //@ts-ignore
                        prev[k] = newValue[k];
                    }
                }
            };
        })(element, func);
        this.controlledElementFunc.push(updateFunc);
        updateFunc();
    }

    createEl<T extends keyof HTMLElementTagNameMap>(
        el: HTMLElement,
        tag: T,
        o?: string | DomElementInfo | undefined,
        callback?: (el: HTMLElementTagNameMap[T]) => void,
        func?: OnUpdateFunc
    ) {
        const element = el.createEl(tag, o, callback);
        if (func) this.handleElement(element, func);
        return element;
    }

    addEl<T extends keyof HTMLElementTagNameMap>(
        el: HTMLElement,
        tag: T,
        o?: string | DomElementInfo | undefined,
        callback?: (el: HTMLElementTagNameMap[T]) => void,
        func?: OnUpdateFunc
    ) {
        const elm = this.createEl(el, tag, o, callback, func);
        return Promise.resolve(elm);
    }

    addOnSaved<T extends AllSettingItemKey>(key: T, func: (value: AllSettings[T]) => Promise<void> | void) {
        this.onSavedHandlers.push({ key, handler: func });
    }
    resetEditingSettings() {
        this._editingSettings = undefined;
        this.initialSettings = undefined;
    }

    override hide() {
        this.isShown = false;
    }
    isShown: boolean = false;

    requestReload() {
        if (this.isShown) {
            const newConf = this.core.settings;
            const keys = Object.keys(newConf) as (keyof ObsidianLiveSyncSettings)[];
            let hasLoaded = false;
            for (const k of keys) {
                if (isObjectDifferent(newConf[k], this.initialSettings?.[k])) {
                    // Something has changed
                    if (this.isDirty(k as AllSettingItemKey)) {
                        // And modified.
                        this.core.confirm.askInPopup(
                            `config-reloaded-${k}`,
                            $msg("obsidianLiveSyncSettingTab.msgSettingModified", {
                                setting: getConfName(k as AllSettingItemKey),
                            }),
                            (anchor) => {
                                anchor.text = $msg("obsidianLiveSyncSettingTab.optionHere");
                                anchor.addEventListener("click", () => {
                                    this.refreshSetting(k as AllSettingItemKey);
                                    this.display();
                                });
                            }
                        );
                    } else {
                        // not modified
                        this.refreshSetting(k as AllSettingItemKey);
                        if (k in OnDialogSettingsDefault) {
                            continue;
                        }
                        hasLoaded = true;
                    }
                }
            }
            if (hasLoaded) {
                this.display();
            } else {
                this.requestUpdate();
            }
        } else {
            this.reloadAllSettings(true);
        }
    }

    //@ts-ignore
    manifestVersion: string = MANIFEST_VERSION || "-";

    lastVersion = ~~(versionNumberString2Number(this.manifestVersion) / 1000);


    isNeedRebuildLocal() {
        return this.isSomeDirty([
            "useIndexedDBAdapter",
            "doNotUseFixedRevisionForChunks",
            "handleFilenameCaseSensitive",
            "passphrase",
            "useDynamicIterationCount",
            "usePathObfuscation",
            "encrypt",
            // "remoteType",
        ]);
    }
    isNeedRebuildRemote() {
        return this.isSomeDirty([
            "doNotUseFixedRevisionForChunks",
            "handleFilenameCaseSensitive",
            "passphrase",
            "useDynamicIterationCount",
            "usePathObfuscation",
            "encrypt",
        ]);
    }
    isAnySyncEnabled() {
        if (this.isConfiguredAs("isConfigured", false)) return false;
        if (this.isConfiguredAs("liveSync", true)) return true;
        if (this.isConfiguredAs("periodicReplication", true)) return true;
        if (this.isConfiguredAs("syncOnFileOpen", true)) return true;
        if (this.isConfiguredAs("syncOnSave", true)) return true;
        if (this.isConfiguredAs("syncOnEditorSave", true)) return true;
        if (this.isConfiguredAs("syncOnStart", true)) return true;
        if (this.isConfiguredAs("syncAfterMerge", true)) return true;
        if (this.isConfiguredAs("syncOnFileOpen", true)) return true;
        if (this.core?.replicator?.syncStatus == "CONNECTED") return true;
        if (this.core?.replicator?.syncStatus == "PAUSED") return true;
        return false;
    }

    enableOnlySyncDisabled = enableOnly(() => !this.isAnySyncEnabled());

    onlyOnCouchDB = () =>
        ({
            visibility: this.isConfiguredAs("remoteType", REMOTE_COUCHDB),
        }) as OnUpdateResult;
    // E2EE Function
    checkWorkingPassphrase = async (): Promise<boolean> => {
        const settingForCheck: RemoteDBSettings = {
            ...this.editingSettings,
        };
        const replicator = this.services.replicator.getNewReplicator(settingForCheck);
        if (!(replicator instanceof LiveSyncCouchDBReplicator)) return true;

        const db = await replicator.connectRemoteCouchDBWithSetting(
            settingForCheck,
            this.services.API.isMobile(),
            true
        );
        if (typeof db === "string") {
            Logger($msg("obsidianLiveSyncSettingTab.logCheckPassphraseFailed", { db }), LOG_LEVEL_NOTICE);
            return false;
        } else {
            if (await checkSyncInfo(db.db)) {
                // Logger($msg("obsidianLiveSyncSettingTab.logDatabaseConnected"), LOG_LEVEL_NOTICE);
                return true;
            } else {
                Logger($msg("obsidianLiveSyncSettingTab.logPassphraseNotCompatible"), LOG_LEVEL_NOTICE);
                return false;
            }
        }
    };
    isPassphraseValid = async () => {
        if (this.editingSettings.encrypt && this.editingSettings.passphrase == "") {
            Logger($msg("obsidianLiveSyncSettingTab.logEncryptionNoPassphrase"), LOG_LEVEL_NOTICE);
            return false;
        }
        if (this.editingSettings.encrypt && !(await testCrypt())) {
            Logger($msg("obsidianLiveSyncSettingTab.logEncryptionNoSupport"), LOG_LEVEL_NOTICE);
            return false;
        }
        return true;
    };

    rebuildDB = async (method: "localOnly" | "remoteOnly" | "rebuildBothByThisDevice" | "localOnlyWithChunks") => {
        if (this.editingSettings.encrypt && this.editingSettings.passphrase == "") {
            Logger($msg("obsidianLiveSyncSettingTab.logEncryptionNoPassphrase"), LOG_LEVEL_NOTICE);
            return;
        }
        if (this.editingSettings.encrypt && !(await testCrypt())) {
            Logger($msg("obsidianLiveSyncSettingTab.logEncryptionNoSupport"), LOG_LEVEL_NOTICE);
            return;
        }
        if (!this.editingSettings.encrypt) {
            this.editingSettings.passphrase = "";
        }
        this.applyAllSettings();
        await this.services.setting.suspendAllSync();
        await this.services.setting.suspendExtraSync();
        this.reloadAllSettings();
        this.editingSettings.isConfigured = true;
        Logger($msg("obsidianLiveSyncSettingTab.logRebuildNote"), LOG_LEVEL_NOTICE);
        await this.saveAllDirtySettings();
        this.closeSetting();
        await delay(2000);
        await this.core.rebuilder.$performRebuildDB(method);
    };
    async confirmRebuild() {
        if (!(await this.isPassphraseValid())) {
            Logger(`Passphrase is not valid, please fix it.`, LOG_LEVEL_NOTICE);
            return;
        }
        const OPTION_FETCH = $msg("obsidianLiveSyncSettingTab.optionFetchFromRemote");
        const OPTION_REBUILD_BOTH = $msg("obsidianLiveSyncSettingTab.optionRebuildBoth");
        const OPTION_ONLY_SETTING = $msg("obsidianLiveSyncSettingTab.optionSaveOnlySettings");
        const OPTION_CANCEL = $msg("obsidianLiveSyncSettingTab.optionCancel");
        const title = $msg("obsidianLiveSyncSettingTab.titleRebuildRequired");
        const note = $msg("obsidianLiveSyncSettingTab.msgRebuildRequired", {
            OPTION_REBUILD_BOTH,
            OPTION_FETCH,
            OPTION_ONLY_SETTING,
        });
        const buttons = [
            OPTION_FETCH,
            OPTION_REBUILD_BOTH, // OPTION_REBUILD_REMOTE,
            OPTION_ONLY_SETTING,
            OPTION_CANCEL,
        ];
        const result = await confirmWithMessage(this.plugin, title, note, buttons, OPTION_CANCEL, 0);
        if (result == OPTION_CANCEL) return;
        if (result == OPTION_FETCH) {
            if (!(await this.checkWorkingPassphrase())) {
                if (
                    (await this.core.confirm.askYesNoDialog($msg("obsidianLiveSyncSettingTab.msgAreYouSureProceed"), {
                        defaultOption: "No",
                    })) != "yes"
                )
                    return;
            }
        }
        if (!this.editingSettings.encrypt) {
            this.editingSettings.passphrase = "";
        }
        await this.saveAllDirtySettings();
        await this.applyAllSettings();
        if (result == OPTION_FETCH) {
            await this.core.storageAccess.writeFileAuto(FLAGMD_REDFLAG3_HR, "");
            this.services.appLifecycle.scheduleRestart();
            this.closeSetting();
            // await rebuildDB("localOnly");
        } else if (result == OPTION_REBUILD_BOTH) {
            await this.core.storageAccess.writeFileAuto(FLAGMD_REDFLAG2_HR, "");
            this.services.appLifecycle.scheduleRestart();
            this.closeSetting();
        } else if (result == OPTION_ONLY_SETTING) {
            await this.services.setting.saveSettingData();
        }
    }

    display(): void {
        const { containerEl } = this;
        this.settingComponents.length = 0;
        this.controlledElementFunc.length = 0;
        this.onSavedHandlers.length = 0;
        this.screenElements = {};
        if (this._editingSettings == undefined || this.initialSettings == undefined) {
            this.reloadAllSettings();
        }
        if (this.editingSettings === undefined || this.initialSettings == undefined) {
            return;
        }
        this.isShown = true;

        containerEl.empty();
        containerEl.addClass("cs-settings");

        // Rebuild warning banner
        this.createEl(
            containerEl,
            "div",
            { cls: "sls-setting-menu-buttons" },
            (el) => {
                el.createEl("label", { text: $msg("obsidianLiveSyncSettingTab.msgChangesNeedToBeApplied") });
                void this.addEl(
                    el,
                    "button",
                    { text: $msg("obsidianLiveSyncSettingTab.optionApply"), cls: "mod-warning" },
                    (buttonEl) => {
                        buttonEl.addEventListener("click", () =>
                            fireAndForget(async () => await this.confirmRebuild())
                        );
                    }
                );
            },
            visibleOnly(() => this.isNeedRebuildLocal() || this.isNeedRebuildRemote())
        );

        // Tab UI (task-viewer style)
        const wrapper = containerEl.createDiv("cs-settings__wrapper");
        const nav = wrapper.createDiv("cs-settings__nav");
        const content = wrapper.createDiv("cs-settings__content");

        const addPanel = (
            parentEl: HTMLElement,
            title: string,
            callback?: (el: HTMLDivElement) => void,
            func?: OnUpdateFunc,
        ) => {
            const el = this.createEl(parentEl, "div", { text: "" }, callback, func);
            this.createEl(el, "h4", { text: title, cls: "sls-setting-panel-title" });
            return Promise.resolve(el);
        };

        const tabs = [
            { id: "setup",       label: "Setup",       render: (el: HTMLElement) => tabSetup.call(this, el, { addPane: undefined as any, addPanel }) },
            { id: "sync",        label: "Sync",        render: (el: HTMLElement) => tabSync.call(this, el, { addPane: undefined as any, addPanel }) },
            { id: "files",       label: "Files",       render: (el: HTMLElement) => tabFiles.call(this, el, { addPane: undefined as any, addPanel }) },
            { id: "advanced",    label: "Advanced",    render: (el: HTMLElement) => tabAdvanced.call(this, el, { addPane: undefined as any, addPanel }) },
            { id: "maintenance", label: "Maintenance", render: (el: HTMLElement) => tabMaintenance.call(this, el, { addPanel } as any) },
        ];

        tabs.forEach((tab) => {
            const btn = nav.createEl("div", {
                cls: "cs-settings__nav-btn",
                text: tab.label,
                attr: { role: "tab", tabindex: "0" },
            });
            btn.dataset.tabId = tab.id;

            const panel = content.createDiv("cs-settings__panel");
            panel.dataset.tabId = tab.id;
            tab.render(panel);
        });

        const selectedTab = this.selectedScreen || (this.isAnySyncEnabled() ? "general" : "setup");
        this.activateTab(wrapper, selectedTab);

        nav.addEventListener("click", (e) => {
            const btn = (e.target as HTMLElement).closest(".cs-settings__nav-btn") as HTMLElement | null;
            if (btn?.dataset.tabId) {
                this.selectedScreen = btn.dataset.tabId;
                this.activateTab(wrapper, btn.dataset.tabId);
            }
        });

        void yieldNextAnimationFrame().then(() => {
            this.requestUpdate();
        });
    }

    private activateTab(wrapper: HTMLElement, tabId: string): void {
        wrapper.querySelectorAll(".cs-settings__nav-btn").forEach((btn) =>
            btn.toggleClass("cs-settings__nav-btn--active", (btn as HTMLElement).dataset.tabId === tabId)
        );
        wrapper.querySelectorAll(".cs-settings__panel").forEach((panel) =>
            ((panel as HTMLElement).style.display = (panel as HTMLElement).dataset.tabId === tabId ? "" : "none")
        );
    }

}
