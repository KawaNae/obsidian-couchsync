import { Notice, Platform, Setting } from "obsidian";
import type { CouchSyncSettings } from "../settings.ts";
import type { LocalDB } from "../db/local-db.ts";
import type { ConfigLocalDB } from "../db/config-local-db.ts";
import type { SyncEngine } from "../db/sync-engine.ts";
import type { StatusBar } from "../ui/status-bar.ts";
import { DOC_ID } from "../types/doc-id.ts";
import { logError } from "../ui/log.ts";
import { gcOrphanChunks } from "../db/chunk-gc.ts";

interface MaintenanceTabDeps {
    getSettings: () => CouchSyncSettings;
    updateSettings: (patch: Partial<CouchSyncSettings>) => Promise<void>;
    localDb: LocalDB;
    /** Null when config sync is not configured (`couchdbConfigDbName === ""`) */
    configLocalDb: ConfigLocalDB | null;
    replicator: SyncEngine;
    statusBar: StatusBar;
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

    // Troubleshooting
    el.createEl("h3", { text: "Troubleshooting" });


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
                if (
                    !confirm(
                        "Delete all `config:*` documents from the vault database? " +
                            "This is a one-time migration step after the v0.11.0 config-DB split. " +
                            "Make sure you've already run Config Init in the Config Sync tab so " +
                            "the new config DB has been seeded.",
                    )
                ) {
                    return;
                }
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
            if (offending && offending.startsWith("config:")) {
                migrationSetting.setDesc(
                    `Found legacy config docs in the vault DB (e.g. ${offending}). ` +
                        "Click to remove them after running Config Init in Config Sync.",
                );
                migrationBtnComponent?.setDisabled(false);
            } else {
                migrationSetting.setDesc(
                    "No legacy configs detected in the vault DB.",
                );
            }
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
            "Compare local and remote chunk inventories. Read-only; no changes are made.",
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

    new Setting(el)
        .setName("Clean up orphan chunks")
        .setDesc(
            "Remove chunks no longer referenced by any note. Safe cleanup.",
        )
        .addButton((btn) =>
            btn.setButtonText("Clean up").onClick(async () => {
                btn.setDisabled(true);
                btn.setButtonText("Cleaning...");
                try {
                    const result = await gcOrphanChunks(deps.localDb);
                    new Notice(
                        result.deletedChunks > 0
                            ? `Deleted ${result.deletedChunks} orphan chunk(s) out of ${result.scannedChunks} total.`
                            : `No orphan chunks found (${result.scannedChunks} chunks, all referenced).`,
                    );
                } catch (e: any) {
                    new Notice(`Cleanup failed: ${e?.message ?? e}`, 10000);
                } finally {
                    btn.setButtonText("Clean up");
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
                    "Remote config data is preserved. Use this when switching device pools " +
                    "(e.g. mobile ↔ desktop) leaves an unused local store behind.",
            )
            .addButton((btn) =>
                btn
                    .setButtonText("Delete & Restart")
                    .setWarning()
                    .onClick(async () => {
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
