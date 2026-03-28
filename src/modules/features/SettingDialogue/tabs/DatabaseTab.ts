import {
    ChunkAlgorithmNames,
    E2EEAlgorithmNames,
    E2EEAlgorithms,
    ExtraSuffixIndexedDB,
    type HashAlgorithm,
    LOG_LEVEL_NOTICE,
    SuffixDatabaseName,
} from "../../../../lib/src/common/types.ts";
import { Logger } from "../../../../lib/src/common/logger.ts";
import { PouchDB } from "../../../../lib/src/pouchdb/pouchdb-browser";
import { LiveSyncSetting as Setting } from "../LiveSyncSetting.ts";
import type { ObsidianLiveSyncSettingTab } from "../ObsidianLiveSyncSettingTab.ts";
import { visibleOnly } from "../SettingPane.ts";
import { migrateDatabases } from "../settingUtils.ts";

export function tabDatabase(this: ObsidianLiveSyncSettingTab, el: HTMLElement): void {
    // === Chunk & Hash ===
    el.createEl('h3', { text: 'Chunk & Hash', cls: 'setting-section-header' });

    new Setting(el).autoWireNumeric("hashCacheMaxCount", { clampMin: 10 });

    const items = ChunkAlgorithmNames;
    new Setting(el).autoWireDropDown("chunkSplitterVersion", {
        options: items,
    });
    new Setting(el).autoWireNumeric("customChunkSize", { clampMin: 0, acceptZero: true });

    new Setting(el).autoWireDropDown("hashAlg", {
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

    // === Database Adapter ===
    el.createEl('h3', { text: 'Database Adapter', cls: 'setting-section-header' });

    {
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
            el.createDiv({
                text: "The IndexedDB adapter often offers superior performance in certain scenarios, but it has been found to cause memory leaks when used with LiveSync mode. When using LiveSync mode, please use IDB adapter instead.",
                cls: infoClass,
            });
            el.createDiv({
                text: "Changing this setting requires migrating existing data (a bit time may be taken) and restarting Obsidian. Please make sure to back up your data before proceeding.",
                cls: "op-warn-info",
            });
            const setting = new Setting(el)
                .setName("Database Adapter")
                .setDesc("Select the database adapter to use. ");
            const ctrlEl = setting.controlEl.createDiv({});
            ctrlEl.setText(`Current adapter: ${this.editingSettings.useIndexedDBAdapter ? "IndexedDB" : "IDB"}`);
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
    }
    new Setting(el).autoWireToggle("handleFilenameCaseSensitive", { holdValue: true });

    new Setting(el)
        .autoWireText("additionalSuffixOfDatabaseName", { holdValue: true })
        .addApplyButton(["additionalSuffixOfDatabaseName"]);

    this.addOnSaved("additionalSuffixOfDatabaseName", async (key) => {
        Logger("Suffix has been changed. Reopening database...", LOG_LEVEL_NOTICE);
        await this.services.databaseEvents.initialiseDatabase();
    });

    // === Transfer ===
    el.createEl('h3', { text: 'Transfer', cls: 'setting-section-header' });

    new Setting(el)

        .autoWireToggle("readChunksOnline", { onUpdate: this.onlyOnCouchDB });
    new Setting(el)

        .autoWireToggle("useOnlyLocalChunk", { onUpdate: this.onlyOnCouchDB });

    new Setting(el).autoWireNumeric("concurrencyOfReadChunksOnline", {
        clampMin: 10,
        onUpdate: this.onlyOnCouchDB,
    });

    new Setting(el).autoWireNumeric("minimumIntervalOfReadChunksOnline", {
        clampMin: 10,
        onUpdate: this.onlyOnCouchDB,
    });

    this.createEl(
        el,
        "div",
        {
            text: `If you reached the payload size limit when using IBM Cloudant, please decrease batch size and batch limit to a lower value.`,
        },
        undefined,
        this.onlyOnCouchDB
    );

    new Setting(el)

        .autoWireNumeric("batch_size", { clampMin: 2, onUpdate: this.onlyOnCouchDB });
    new Setting(el).autoWireNumeric("batches_limit", {
        clampMin: 2,
        onUpdate: this.onlyOnCouchDB,
    });
    new Setting(el).autoWireToggle("useTimeouts", { onUpdate: this.onlyOnCouchDB });

    new Setting(el).autoWireToggle("enableCompression");

    // === Processing ===
    el.createEl('h3', { text: 'Processing', cls: 'setting-section-header' });

    new Setting(el).autoWireToggle("disableWorkerForGeneratingChunks");

    new Setting(el).autoWireToggle("processSmallFilesInUIThread", {
        onUpdate: visibleOnly(() => this.isConfiguredAs("disableWorkerForGeneratingChunks", false)),
    });

    new Setting(el).autoWireToggle("doNotSuspendOnFetching");
    new Setting(el).autoWireToggle("processSizeMismatchedFiles");

    // === Compatibility ===
    el.createEl('h3', { text: 'Compatibility', cls: 'setting-section-header' });

    new Setting(el).autoWireToggle("deleteMetadataOfDeletedFiles");

    new Setting(el).autoWireNumeric("automaticallyDeleteMetadataOfDeletedFiles", {
        onUpdate: visibleOnly(() => this.isConfiguredAs("deleteMetadataOfDeletedFiles", true)),
    });

    new Setting(el).autoWireDropDown("E2EEAlgorithm", {
        options: E2EEAlgorithmNames,
    });
    new Setting(el).autoWireToggle("useDynamicIterationCount", {
        holdValue: true,
        onUpdate: visibleOnly(
            () =>
                this.isConfiguredAs("E2EEAlgorithm", E2EEAlgorithms.ForceV1) ||
                this.isConfiguredAs("E2EEAlgorithm", E2EEAlgorithms.V1)
        ),
    });

    new Setting(el).autoWireToggle("watchInternalFileChanges", { invert: true });

    new Setting(el).autoWireToggle("disableCheckingConfigMismatch");

    {
        let dateEl: HTMLSpanElement;
        new Setting(el)
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
    }
}
