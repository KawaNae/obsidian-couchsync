import { Notice, Platform, Setting } from "obsidian";
import type { CouchSyncSettings } from "../settings.ts";
import type { LocalDB } from "../db/local-db.ts";
import type { ConfigLocalDB } from "../db/config-local-db.ts";
import type { SyncEngine } from "../db/sync-engine.ts";
import type { StatusBar } from "../ui/status-bar.ts";
import type { IModalPresenter } from "../types/modal-presenter.ts";
import type { LogManager } from "../log/log-manager.ts";
import { DOC_ID } from "../types/doc-id.ts";
import { logError } from "../ui/log.ts";

interface MaintenanceTabDeps {
    getSettings: () => CouchSyncSettings;
    updateSettings: (patch: Partial<CouchSyncSettings>) => Promise<void>;
    localDb: LocalDB;
    /** Null when config sync is not configured (`couchdbConfigDbName === ""`) */
    configLocalDb: ConfigLocalDB | null;
    replicator: SyncEngine;
    statusBar: StatusBar;
    modalPresenter: IModalPresenter;
    logManager: LogManager;
    onRestart: () => void;
    runChunkConsistencyReport: () => Promise<void>;
}

export function renderMaintenanceTab(el: HTMLElement, deps: MaintenanceTabDeps): void {
    const settings = deps.getSettings();

    // Mobile status position (only show on mobile)
    if (Platform.isMobile) {
        el.createEl("h3", { text: "Status Indicator" });

        new Setting(el)
            .setName("Align")
            .setDesc("Which side of the screen to show the sync status.")
            .addDropdown((dropdown) => {
                dropdown.addOption("left", "Left");
                dropdown.addOption("right", "Right");
                dropdown.setValue(settings.mobileStatus.align);
                dropdown.onChange(async (value) => {
                    await deps.updateSettings({ mobileStatus: { ...settings.mobileStatus, align: value as "left" | "right" } });
                    deps.statusBar.applyPosition();
                });
            });

        new Setting(el)
            .setName("Bottom (px)")
            .setDesc("Distance from the bottom of the screen.")
            .addText((text) =>
                text.setValue(String(settings.mobileStatus.bottom)).onChange(async (value) => {
                    const num = parseInt(value, 10);
                    if (!isNaN(num) && num >= 0) {
                        await deps.updateSettings({ mobileStatus: { ...settings.mobileStatus, bottom: num } });
                        deps.statusBar.applyPosition();
                    }
                })
            );

        new Setting(el)
            .setName("Horizontal offset (px)")
            .setDesc("Distance from the left or right edge.")
            .addText((text) =>
                text.setValue(String(settings.mobileStatus.offset)).onChange(async (value) => {
                    const num = parseInt(value, 10);
                    if (!isNaN(num) && num >= 0) {
                        await deps.updateSettings({ mobileStatus: { ...settings.mobileStatus, offset: num } });
                        deps.statusBar.applyPosition();
                    }
                })
            );
    }

    // Logging
    el.createEl("h3", { text: "Logging" });

    new Setting(el)
        .setName("Verbose notice")
        .setDesc("When ON, debug/info-level logs are also shown in the console and as Notices. When OFF, everything is still recorded in the Log View.")
        .addToggle((toggle) =>
            toggle.setValue(settings.verboseNotice).onChange(async (value) => {
                await deps.updateSettings({ verboseNotice: value });
            })
        );

    new Setting(el)
        .setName("Log retention (days)")
        .setDesc("How many days of log entries to keep in the persistent buffer. Must be at least 1.")
        .addText((text) =>
            text.setValue(String(settings.logRetentionDays)).onChange(async (value) => {
                const num = parseInt(value, 10);
                if (!isNaN(num) && num >= 1) {
                    await deps.updateSettings({ logRetentionDays: num });
                }
            }),
        );

    new Setting(el)
        .setName("Max log storage (MB)")
        .setDesc("Upper bound on log buffer size in megabytes. Set to 0 for unlimited (only the day-based retention applies).")
        .addText((text) =>
            text.setValue(String(settings.logMaxStorageMB)).onChange(async (value) => {
                const num = parseInt(value, 10);
                if (!isNaN(num) && num >= 0) {
                    await deps.updateSettings({ logMaxStorageMB: num });
                }
            }),
        );

    // Live stats + actions
    const logStatsSetting = new Setting(el)
        .setName("Log buffer")
        .setDesc("Loading...");

    const refreshLogStats = async () => {
        try {
            const stats = await deps.logManager.getStats();
            if (stats.count === 0) {
                logStatsSetting.setDesc("Empty.");
                return;
            }
            const mb = (stats.approxBytes / (1024 * 1024)).toFixed(2);
            const cap = settings.logMaxStorageMB === 0 ? "unlimited" : `${settings.logMaxStorageMB} MB`;
            const oldest = stats.oldestTs ? new Date(stats.oldestTs).toISOString().slice(0, 19) : "-";
            const newest = stats.newestTs ? new Date(stats.newestTs).toISOString().slice(0, 19) : "-";
            logStatsSetting.setDesc(
                `${stats.count} entries · ${mb} MB / ${cap} · ${oldest} → ${newest}`,
            );
        } catch (e: any) {
            logStatsSetting.setDesc(`(failed to read stats: ${e?.message ?? e})`);
        }
    };
    void refreshLogStats();

    new Setting(el)
        .setName("Export logs")
        .setDesc(
            "Write a snapshot of the persistent log buffer to the vault root as " +
                "couchsync_log_<device>_<timestamp>.md. The snapshot is frozen — " +
                "subsequent log entries do not modify the exported file. " +
                "Note: this captures more than the Log View shows (the view is in-memory only).",
        )
        .addButton((btn) =>
            btn.setButtonText("Export").onClick(async () => {
                btn.setDisabled(true);
                btn.setButtonText("Exporting...");
                try {
                    const result = await deps.logManager.exportToVault();
                    new Notice(
                        `CouchSync: exported ${result.count} log entries to ${result.path}`,
                        8000,
                    );
                    await refreshLogStats();
                } catch (e: any) {
                    new Notice(`Log export failed: ${e?.message ?? e}`, 10000);
                } finally {
                    btn.setButtonText("Export");
                    btn.setDisabled(false);
                }
            }),
        );

    new Setting(el)
        .setName("Clear stored logs")
        .setDesc("Delete all entries from the persistent log buffer (does not affect already-exported .md files).")
        .addButton((btn) =>
            btn.setButtonText("Clear")
                .setWarning()
                .onClick(async () => {
                    const ok = await deps.modalPresenter.showConfirmModal(
                        "Clear stored logs",
                        "Delete all entries from the persistent log buffer? This cannot be undone. " +
                            "Already-exported .md files in the vault are not affected.",
                        "Clear",
                        true,
                    );
                    if (!ok) return;
                    btn.setDisabled(true);
                    try {
                        await deps.logManager.clearStoredLogs();
                        new Notice("CouchSync: log buffer cleared.", 4000);
                        await refreshLogStats();
                    } catch (e: any) {
                        new Notice(`Clear failed: ${e?.message ?? e}`, 10000);
                    } finally {
                        btn.setDisabled(false);
                    }
                }),
        );

    new Setting(el)
        .setName("Delete local log database")
        .setDesc("Advanced: drop the entire IndexedDB store backing the log buffer. Use only if the database is corrupted.")
        .addButton((btn) =>
            btn.setButtonText("Delete database")
                .setWarning()
                .onClick(async () => {
                    const ok = await deps.modalPresenter.showConfirmModal(
                        "Delete local log database",
                        "Drop the entire IndexedDB store backing the log buffer? " +
                            "All persistent log data on this device will be lost. " +
                            "Only do this if the database is corrupted.",
                        "Delete",
                        true,
                    );
                    if (!ok) return;
                    btn.setDisabled(true);
                    try {
                        await deps.logManager.deleteLogDatabase();
                        new Notice("CouchSync: log database deleted.", 4000);
                        await refreshLogStats();
                    } catch (e: any) {
                        new Notice(`Delete failed: ${e?.message ?? e}`, 10000);
                    } finally {
                        btn.setDisabled(false);
                    }
                }),
        );

    // ── Migration: legacy configs in vault DB ───────────────
    // Detect orphan `config:*` docs left in the vault DB after the
    // v0.11.0 split. Show the cleanup button only when there's
    // something to clean.
    el.createEl("h3", { text: "Migration" });

    const migrationSetting = new Setting(el)
        .setName("Clean up legacy configs from vault DB")
        .setDesc("Checking...");
    let migrationBtnComponent: any = null;
    migrationSetting.addButton((btn) => {
        migrationBtnComponent = btn;
        btn.setButtonText("Clean up")
            .setWarning()
            .setDisabled(true)
            .onClick(async () => {
                const ok = await deps.modalPresenter.showConfirmModal(
                    "Clean up legacy configs",
                    "Delete all `config:*` documents from the vault database? " +
                        "This is a one-time migration step after the v0.11.0 config-DB split. " +
                        "Make sure you've already run Config Init in the Config Sync tab so " +
                        "the new config DB has been seeded.",
                    "Clean up",
                    true,
                );
                if (!ok) return;
                btn.setButtonText("Cleaning...");
                btn.setDisabled(true);
                try {
                    const deleted = await deps.localDb.deleteAllByPrefix(DOC_ID.CONFIG);
                    new Notice(
                        `CouchSync: removed ${deleted.length} legacy config doc(s) from vault DB. ` +
                            "Replication will propagate the deletions to the remote shortly.",
                        10000,
                    );
                } catch (e: any) {
                    new Notice(`Cleanup failed: ${e?.message ?? e}`, 10000);
                } finally {
                    btn.setButtonText("Clean up");
                    btn.setDisabled(false);
                }
            });
    });

    void (async () => {
        try {
            const offending = await deps.localDb.findLegacyVaultDoc();
            if (!offending) {
                migrationSetting.setDesc(
                    "No legacy configs detected in the vault DB.",
                );
                return;
            }
            if (offending.startsWith("config:")) {
                migrationSetting.setDesc(
                    `Found legacy config docs in the vault DB (e.g. ${offending}). ` +
                        "Click to remove them after running Config Init in Config Sync.",
                );
                migrationBtnComponent?.setDisabled(false);
                return;
            }
            // Non-config offender (non-replicated doc id, or vclock-less
            // FileDoc). This button can't fix it — direct the user to the
            // full local rebuild path. Matches the startup notify message
            // in main.ts.
            migrationSetting.setDesc(
                `Non-config legacy doc detected in the vault DB (${offending}). ` +
                    "This button only handles config:* leftovers; use " +
                    "\"Delete local vault database\" below to rebuild from remote.",
            );
        } catch (e) {
            migrationSetting.setDesc("Could not check for legacy configs (see console).");
            logError(`CouchSync: legacy probe failed: ${e?.message ?? e}`);
        }
    })();

    // Diagnostics
    el.createEl("h3", { text: "Diagnostics" });

    new Setting(el)
        .setName("Chunk consistency report")
        .setDesc(
            "Diagnostic tool — compares local and remote chunk inventories and " +
                "surfaces drift the normal sync path cannot fix (one-sided orphans, " +
                "broken references). In healthy operation this returns zero drift. " +
                "Use after suspected sync issues or large migrations. The result " +
                "modal exposes an optional repair action.",
        )
        .addButton((btn) =>
            btn.setButtonText("Run check").onClick(async () => {
                btn.setDisabled(true);
                try {
                    await deps.runChunkConsistencyReport();
                } finally {
                    btn.setDisabled(false);
                }
            }),
        );

    // Recovery
    el.createEl("h3", { text: "Recovery" });

    new Setting(el)
        .setName("Restart sync")
        .setDesc(
            "Stop and restart the replication connection. Honours the auth " +
                "latch and 5s cool-down (same as the gateway).",
        )
        .addButton((btn) =>
            btn.setButtonText("Restart").onClick(async () => {
                // Funnel through the gateway so this button can never
                // bypass the auth latch or cool-down. The "manual"
                // reason maps to restart-now in any non-latched state.
                await deps.replicator.requestReconnect("manual");
            })
        );

    // Reset
    el.createEl("h3", { text: "Reset" });

    new Setting(el)
        .setName("Delete local vault database")
        .setDesc("Destroy the local vault database and restart. Remote data is preserved.")
        .addButton((btn) =>
            btn
                .setButtonText("Delete & Restart")
                .setWarning()
                .onClick(async () => {
                    const ok = await deps.modalPresenter.showConfirmModal(
                        "Delete local vault database",
                        "Destroy the entire local vault database on this device and " +
                            "restart the plugin? Remote data is preserved — sync will " +
                            "re-download from the remote on next start, which can take " +
                            "minutes for large vaults. Local-only state (unpushed edits, " +
                            "checkpoints) will be lost.",
                        "Delete",
                        true,
                    );
                    if (!ok) return;
                    deps.replicator.stop();
                    await deps.localDb.destroy();
                    new Notice("CouchSync: Local vault database deleted. Restarting...");
                    deps.onRestart();
                })
        );

    if (deps.configLocalDb) {
        const configDbName = settings.couchdbConfigDbName;
        new Setting(el)
            .setName("Delete local config database")
            .setDesc(
                `Destroy the local config database (${configDbName}) and restart. ` +
                    "Remote config data is preserved. Mostly useful for cleaning up unused " +
                    "local stores left behind by past device-pool reconfigurations.",
            )
            .addButton((btn) =>
                btn
                    .setButtonText("Delete & Restart")
                    .setWarning()
                    .onClick(async () => {
                        const ok = await deps.modalPresenter.showConfirmModal(
                            "Delete local config database",
                            `Destroy the local config database (${configDbName}) on this ` +
                                "device and restart the plugin? Remote config data is " +
                                "preserved — config will re-download on next start.",
                            "Delete",
                            true,
                        );
                        if (!ok) return;
                        try {
                            await deps.configLocalDb!.destroy();
                            new Notice(
                                "CouchSync: Local config database deleted. Restarting...",
                            );
                            deps.onRestart();
                        } catch (e: any) {
                            new Notice(`Delete failed: ${e?.message ?? e}`, 10000);
                        }
                    })
            );
    }
}
