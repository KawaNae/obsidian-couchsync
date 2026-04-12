import { Notice, Platform, Setting } from "obsidian";
import type { CouchSyncSettings } from "../settings.ts";
import type { LocalDB } from "../db/local-db.ts";
import type { ConfigLocalDB } from "../db/config-local-db.ts";
import type { Replicator } from "../db/replicator.ts";
import type { ConflictResolver } from "../conflict/conflict-resolver.ts";
import type { StatusBar } from "../ui/status-bar.ts";
import { DOC_ID } from "../types/doc-id.ts";

interface MaintenanceTabDeps {
    getSettings: () => CouchSyncSettings;
    updateSettings: (patch: Partial<CouchSyncSettings>) => Promise<void>;
    localDb: LocalDB;
    /** Null when config sync is not configured (`couchdbConfigDbName === ""`) */
    configLocalDb: ConfigLocalDB | null;
    replicator: Replicator;
    /** ConflictResolver bound to the vault DB */
    conflictResolver: ConflictResolver;
    /** ConflictResolver bound to the config DB (null when config sync disabled) */
    configConflictResolver: ConflictResolver | null;
    statusBar: StatusBar;
    onRestart: () => void;
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
                dropdown.setValue(settings.mobileStatusAlign);
                dropdown.onChange(async (value) => {
                    await deps.updateSettings({ mobileStatusAlign: value as "left" | "right" });
                    deps.statusBar.applyPosition();
                });
            });

        new Setting(el)
            .setName("Bottom (px)")
            .setDesc("Distance from the bottom of the screen.")
            .addText((text) =>
                text.setValue(String(settings.mobileStatusBottom)).onChange(async (value) => {
                    const num = parseInt(value, 10);
                    if (!isNaN(num) && num >= 0) {
                        await deps.updateSettings({ mobileStatusBottom: num });
                        deps.statusBar.applyPosition();
                    }
                })
            );

        new Setting(el)
            .setName("Horizontal offset (px)")
            .setDesc("Distance from the left or right edge.")
            .addText((text) =>
                text.setValue(String(settings.mobileStatusOffset)).onChange(async (value) => {
                    const num = parseInt(value, 10);
                    if (!isNaN(num) && num >= 0) {
                        await deps.updateSettings({ mobileStatusOffset: num });
                        deps.statusBar.applyPosition();
                    }
                })
            );
    }

    // Logging
    el.createEl("h3", { text: "Logging" });

    new Setting(el)
        .setName("Verbose logging")
        .setDesc("Show detailed sync logs in the console and reconnect notifications.")
        .addToggle((toggle) =>
            toggle.setValue(settings.showVerboseLog).onChange(async (value) => {
                await deps.updateSettings({ showVerboseLog: value });
            })
        );

    // Troubleshooting
    el.createEl("h3", { text: "Troubleshooting" });

    new Setting(el)
        .setName("Resolve all conflicts")
        .setDesc(
            "Scan both vault and config databases for conflicted documents and " +
                "auto-resolve those whose Vector Clocks determine a causal winner. " +
                "Concurrent edits (no dominator) are left for manual resolution.",
        )
        .addButton((btn) =>
            btn.setButtonText("Resolve").onClick(async () => {
                btn.setButtonText("Resolving...");
                btn.setDisabled(true);
                const vaultCount = await deps.conflictResolver.scanConflicts();
                const configCount = deps.configConflictResolver
                    ? await deps.configConflictResolver.scanConflicts()
                    : 0;
                const total = vaultCount + configCount;
                new Notice(
                    `CouchSync: Auto-resolved ${total} conflict(s) ` +
                        `(vault: ${vaultCount}, config: ${configCount}).`,
                );
                btn.setButtonText("Resolve");
                btn.setDisabled(false);
            })
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
            console.error("CouchSync: legacy probe failed:", e);
        }
    })();

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
        .setDesc("Destroy the local vault PouchDB and restart. Remote data is preserved.")
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
                `Destroy the local config PouchDB (${configDbName}) and restart. ` +
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
