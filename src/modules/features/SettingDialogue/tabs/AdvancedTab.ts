import {
    ChunkAlgorithmNames,
    E2EEAlgorithmNames,
    E2EEAlgorithms,
    ExtraSuffixIndexedDB,
    type HashAlgorithm,
    LOG_LEVEL_NOTICE,
    SuffixDatabaseName,
    type ConfigPassphraseStore,
} from "../../../../lib/src/common/types.ts";
import { Logger } from "../../../../lib/src/common/logger.ts";
import { PouchDB } from "../../../../lib/src/pouchdb/pouchdb-browser";
import { LiveSyncSetting as Setting } from "../LiveSyncSetting.ts";
import { EVENT_ON_UNRESOLVED_ERROR, eventHub } from "../../../../common/events.ts";
import type { ObsidianLiveSyncSettingTab } from "../ObsidianLiveSyncSettingTab.ts";
import type { PageFunctions } from "../SettingPane.ts";
import { visibleOnly } from "../SettingPane.ts";
import { migrateDatabases } from "../settingUtils.ts";
import { $msg, $t } from "../../../../lib/src/common/i18n.ts";
import { SUPPORTED_I18N_LANGS, type I18N_LANGS } from "../../../../lib/src/common/rosetta.ts";
import { NetworkWarningStyles } from "../../../../lib/src/common/models/setting.const.ts";

export function tabAdvanced(this: ObsidianLiveSyncSettingTab, paneEl: HTMLElement, { addPanel, addPane }: PageFunctions): void {
    // --- PaneAdvanced: Memory cache ---
    void addPanel(paneEl, "Memory cache").then((paneEl) => {
        new Setting(paneEl).autoWireNumeric("hashCacheMaxCount", { clampMin: 10 });
    });

    // --- PaneAdvanced: Local Database Tweak ---
    void addPanel(paneEl, "Local Database Tweak").then((paneEl) => {
        paneEl;

        const items = ChunkAlgorithmNames;
        new Setting(paneEl).autoWireDropDown("chunkSplitterVersion", {
            options: items,
        });
        new Setting(paneEl).autoWireNumeric("customChunkSize", { clampMin: 0, acceptZero: true });
    });

    // --- PaneAdvanced: Transfer Tweak ---
    void addPanel(paneEl, "Transfer Tweak").then((paneEl) => {
        new Setting(paneEl)
            
            .autoWireToggle("readChunksOnline", { onUpdate: this.onlyOnCouchDB });
        new Setting(paneEl)
            
            .autoWireToggle("useOnlyLocalChunk", { onUpdate: this.onlyOnCouchDB });

        new Setting(paneEl).autoWireNumeric("concurrencyOfReadChunksOnline", {
            clampMin: 10,
            onUpdate: this.onlyOnCouchDB,
        });

        new Setting(paneEl).autoWireNumeric("minimumIntervalOfReadChunksOnline", {
            clampMin: 10,
            onUpdate: this.onlyOnCouchDB,
        });
    });

    // --- PanePowerUsers: CouchDB Connection Tweak ---
    void addPanel(paneEl, "CouchDB Connection Tweak", undefined, this.onlyOnCouchDB).then((paneEl) => {
        paneEl;

        this.createEl(
            paneEl,
            "div",
            {
                text: `If you reached the payload size limit when using IBM Cloudant, please decrease batch size and batch limit to a lower value.`,
            },
            undefined,
            this.onlyOnCouchDB
        );

        new Setting(paneEl)
            
            .autoWireNumeric("batch_size", { clampMin: 2, onUpdate: this.onlyOnCouchDB });
        new Setting(paneEl).autoWireNumeric("batches_limit", {
            clampMin: 2,
            onUpdate: this.onlyOnCouchDB,
        });
        new Setting(paneEl).autoWireToggle("useTimeouts", { onUpdate: this.onlyOnCouchDB });
    });

    // --- PanePowerUsers: Configuration Encryption ---
    void addPanel(paneEl, "Configuration Encryption").then((paneEl) => {
        const passphrase_options: Record<ConfigPassphraseStore, string> = {
            "": "Default",
            LOCALSTORAGE: "Use a custom passphrase",
            ASK_AT_LAUNCH: "Ask an passphrase at every launch",
        };

        new Setting(paneEl)
            .setName("Encrypting sensitive configuration items")
            .autoWireDropDown("configPassphraseStore", {
                options: passphrase_options,
                holdValue: true,
            })
            ;

        new Setting(paneEl)
            .autoWireText("configPassphrase", { isPassword: true, holdValue: true })
            
            .addOnUpdate(() => ({
                disabled: !this.isConfiguredAs("configPassphraseStore", "LOCALSTORAGE"),
            }));
        new Setting(paneEl).addApplyButton(["configPassphrase", "configPassphraseStore"]);
    });

    // --- PanePowerUsers: Developer ---
    void addPanel(paneEl, "Developer").then((paneEl) => {
        new Setting(paneEl).autoWireToggle("enableDebugTools");
    });

    // --- PanePatches: Compatibility (Metadata) ---
    void addPanel(paneEl, "Compatibility (Metadata)").then((paneEl) => {
        new Setting(paneEl).autoWireToggle("deleteMetadataOfDeletedFiles");

        new Setting(paneEl).autoWireNumeric("automaticallyDeleteMetadataOfDeletedFiles", {
            onUpdate: visibleOnly(() => this.isConfiguredAs("deleteMetadataOfDeletedFiles", true)),
        });
    });

    // --- PanePatches: Compatibility (Conflict Behaviour) ---
    void addPanel(paneEl, "Compatibility (Conflict Behaviour)").then((paneEl) => {
        paneEl;
        new Setting(paneEl).autoWireToggle("disableMarkdownAutoMerge");
        new Setting(paneEl).autoWireToggle("writeDocumentsIfConflicted");
    });

    // --- PanePatches: Compatibility (Database structure) ---
    void addPanel(paneEl, "Compatibility (Database structure)").then((paneEl) => {
        const migrateAllToIndexedDB = async () => {
            const dbToName = this.core.localDatabase.dbname + SuffixDatabaseName + ExtraSuffixIndexedDB;
            const options = {
                adapter: "indexeddb",
                //@ts-ignore :missing def
                purged_infos_limit: 1,
                auto_compaction: false,
                deterministic_revs: true,
            };
            const openTo = () => {
                return new PouchDB(dbToName, options);
            };
            if (await migrateDatabases("to IndexedDB", this.core.localDatabase.localDatabase, openTo)) {
                Logger(
                    "Migration to IndexedDB completed. Obsidian will be restarted with new configuration immediately.",
                    LOG_LEVEL_NOTICE
                );
                await this.core.services.setting.applyPartial({ useIndexedDBAdapter: true }, true);
                this.services.appLifecycle.performRestart();
            }
        };
        const migrateAllToIDB = async () => {
            const dbToName = this.core.localDatabase.dbname + SuffixDatabaseName;
            const options = {
                adapter: "idb",
                auto_compaction: false,
                deterministic_revs: true,
            };
            const openTo = () => {
                return new PouchDB(dbToName, options);
            };
            if (await migrateDatabases("to IDB", this.core.localDatabase.localDatabase, openTo)) {
                Logger(
                    "Migration to IDB completed. Obsidian will be restarted with new configuration immediately.",
                    LOG_LEVEL_NOTICE
                );
                await this.core.services.setting.applyPartial({ useIndexedDBAdapter: false }, true);
                this.services.appLifecycle.performRestart();
            }
        };
        {
            const infoClass = this.editingSettings.useIndexedDBAdapter ? "op-warn" : "op-warn-info";
            paneEl.createDiv({
                text: "The IndexedDB adapter often offers superior performance in certain scenarios, but it has been found to cause memory leaks when used with LiveSync mode. When using LiveSync mode, please use IDB adapter instead.",
                cls: infoClass,
            });
            paneEl.createDiv({
                text: "Changing this setting requires migrating existing data (a bit time may be taken) and restarting Obsidian. Please make sure to back up your data before proceeding.",
                cls: "op-warn-info",
            });
            const setting = new Setting(paneEl)
                .setName("Database Adapter")
                .setDesc("Select the database adapter to use. ");
            const el = setting.controlEl.createDiv({});
            el.setText(`Current adapter: ${this.editingSettings.useIndexedDBAdapter ? "IndexedDB" : "IDB"}`);
            if (!this.editingSettings.useIndexedDBAdapter) {
                setting.addButton((button) => {
                    button.setButtonText("Switch to IndexedDB").onClick(async () => {
                        Logger("Migrating all data to IndexedDB...", LOG_LEVEL_NOTICE);
                        await migrateAllToIndexedDB();
                        Logger(
                            "Migration to IndexedDB completed. Please switch the adapter and restart Obsidian.",
                            LOG_LEVEL_NOTICE
                        );
                    });
                });
            } else {
                setting.addButton((button) => {
                    button.setButtonText("Switch to IDB").onClick(async () => {
                        Logger("Migrating all data to IDB...", LOG_LEVEL_NOTICE);
                        await migrateAllToIDB();
                        Logger(
                            "Migration to IDB completed. Please switch the adapter and restart Obsidian.",
                            LOG_LEVEL_NOTICE
                        );
                    });
                });
            }
        }
        new Setting(paneEl).autoWireToggle("handleFilenameCaseSensitive", { holdValue: true });
    });

    // --- PanePatches: Compatibility (Internal API Usage) ---
    void addPanel(paneEl, "Compatibility (Internal API Usage)").then((paneEl) => {
        new Setting(paneEl).autoWireToggle("watchInternalFileChanges", { invert: true });
    });

    // --- PanePatches: Compatibility (Remote Database) ---
    void addPanel(paneEl, "Compatibility (Remote Database)").then((paneEl) => {
        new Setting(paneEl).autoWireDropDown("E2EEAlgorithm", {
            options: E2EEAlgorithmNames,
        });
    });
    new Setting(paneEl).autoWireToggle("useDynamicIterationCount", {
        holdValue: true,
        onUpdate: visibleOnly(
            () =>
                this.isConfiguredAs("E2EEAlgorithm", E2EEAlgorithms.ForceV1) ||
                this.isConfiguredAs("E2EEAlgorithm", E2EEAlgorithms.V1)
        ),
    });

    // --- PanePatches: Edge case addressing (Database) ---
    void addPanel(paneEl, "Edge case addressing (Database)").then((paneEl) => {
        new Setting(paneEl)
            .autoWireText("additionalSuffixOfDatabaseName", { holdValue: true })
            .addApplyButton(["additionalSuffixOfDatabaseName"]);

        this.addOnSaved("additionalSuffixOfDatabaseName", async (key) => {
            Logger("Suffix has been changed. Reopening database...", LOG_LEVEL_NOTICE);
            await this.services.databaseEvents.initialiseDatabase();
        });

        new Setting(paneEl).autoWireDropDown("hashAlg", {
            options: {
                "": "Old Algorithm",
                xxhash32: "xxhash32 (Fast but less collision resistance)",
                xxhash64: "xxhash64 (Fastest)",
                "mixed-purejs": "PureJS fallback  (Fast, W/O WebAssembly)",
                sha1: "Older fallback (Slow, W/O WebAssembly)",
            } as Record<HashAlgorithm, string>,
        });
        this.addOnSaved("hashAlg", async () => {
            await this.core.localDatabase._prepareHashFunctions();
        });
    });

    // --- PanePatches: Edge case addressing (Behaviour) ---
    void addPanel(paneEl, "Edge case addressing (Behaviour)").then((paneEl) => {
        new Setting(paneEl).autoWireToggle("doNotSuspendOnFetching");
        new Setting(paneEl).autoWireToggle("doNotDeleteFolder");
        new Setting(paneEl).autoWireToggle("processSizeMismatchedFiles");
    });

    // --- PanePatches: Edge case addressing (Processing) ---
    void addPanel(paneEl, "Edge case addressing (Processing)").then((paneEl) => {
        new Setting(paneEl).autoWireToggle("disableWorkerForGeneratingChunks");

        new Setting(paneEl).autoWireToggle("processSmallFilesInUIThread", {
            onUpdate: visibleOnly(() => this.isConfiguredAs("disableWorkerForGeneratingChunks", false)),
        });
    });

    // --- PanePatches: Compatibility (Trouble addressed) ---
    void addPanel(paneEl, "Compatibility (Trouble addressed)").then((paneEl) => {
        new Setting(paneEl).autoWireToggle("disableCheckingConfigMismatch");
    });

    // --- PanePatches: Remediation ---
    void addPanel(paneEl, "Remediation").then((paneEl) => {
        let dateEl: HTMLSpanElement;
        new Setting(paneEl)
            .addText((text) => {
                const updateDateText = () => {
                    if (this.editingSettings.maxMTimeForReflectEvents == 0) {
                        dateEl.textContent = `No limit configured`;
                    } else {
                        const date = new Date(this.editingSettings.maxMTimeForReflectEvents);
                        dateEl.textContent = `Limit: ${date.toLocaleString()} (${this.editingSettings.maxMTimeForReflectEvents})`;
                    }
                    this.requestUpdate();
                };
                text.inputEl.before((dateEl = document.createElement("span")));
                text.inputEl.type = "datetime-local";
                if (this.editingSettings.maxMTimeForReflectEvents > 0) {
                    const date = new Date(this.editingSettings.maxMTimeForReflectEvents);
                    const isoString = date.toISOString().slice(0, 16);
                    text.setValue(isoString);
                } else {
                    text.setValue("");
                }
                text.onChange((value) => {
                    if (value == "") {
                        this.editingSettings.maxMTimeForReflectEvents = 0;
                        updateDateText();
                        return;
                    }
                    const date = new Date(value);
                    if (!isNaN(date.getTime())) {
                        this.editingSettings.maxMTimeForReflectEvents = date.getTime();
                    }
                    updateDateText();
                });
                updateDateText();
                return text;
            })
            .setAuto("maxMTimeForReflectEvents")
            .addApplyButton(["maxMTimeForReflectEvents"]);

        this.addOnSaved("maxMTimeForReflectEvents", async (key) => {
            const buttons = ["Restart Now", "Later"] as const;
            const reboot = await this.core.confirm.askSelectStringDialogue(
                "Restarting Obsidian is strongly recommended. Until restart, some changes may not take effect, and display may be inconsistent. Are you sure to restart now?",
                buttons,
                {
                    title: "Remediation Setting Changed",
                    defaultAction: "Restart Now",
                }
            );
            if (reboot !== "Later") {
                Logger("Remediation setting changed. Restarting Obsidian...", LOG_LEVEL_NOTICE);
                this.services.appLifecycle.performRestart();
            }
        });
    });

    // --- PanePatches: Remote Database Tweak (In sunset) ---
    void addPanel(paneEl, "Remote Database Tweak (In sunset)").then((paneEl) => {
        new Setting(paneEl).autoWireToggle("enableCompression");
    });

    // --- Display & Logging ---
    void addPanel(paneEl, $msg("obsidianLiveSyncSettingTab.titleAppearance")).then((paneEl) => {
        const languages = Object.fromEntries([
            ...SUPPORTED_I18N_LANGS.map((e) => [e, $t(`lang-${e}`)]),
        ]) as Record<I18N_LANGS, string>;
        new Setting(paneEl).autoWireDropDown("displayLanguage", {
            options: languages,
        });
        this.addOnSaved("displayLanguage", () => this.display());
        new Setting(paneEl).autoWireToggle("showStatusOnEditor");
        new Setting(paneEl).autoWireToggle("showOnlyIconsOnEditor", {
            onUpdate: visibleOnly(() => this.isConfiguredAs("showStatusOnEditor", true)),
        });
        new Setting(paneEl).autoWireToggle("showStatusOnStatusbar");
        new Setting(paneEl).autoWireToggle("hideFileWarningNotice");
        new Setting(paneEl).autoWireDropDown("networkWarningStyle", {
            options: {
                [NetworkWarningStyles.BANNER]: "Show full banner",
                [NetworkWarningStyles.ICON]: "Show icon only",
                [NetworkWarningStyles.HIDDEN]: "Hide completely",
            },
        });
        this.addOnSaved("networkWarningStyle", () => {
            eventHub.emitEvent(EVENT_ON_UNRESOLVED_ERROR);
        });
    });
    void addPanel(paneEl, $msg("obsidianLiveSyncSettingTab.titleLogging")).then((paneEl) => {
        new Setting(paneEl).autoWireToggle("lessInformationInLog");
        new Setting(paneEl).autoWireToggle("showVerboseLog", {
            onUpdate: visibleOnly(() => this.isConfiguredAs("lessInformationInLog", false)),
        });
    });
}
