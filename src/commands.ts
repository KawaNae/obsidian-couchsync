import { Notice } from "obsidian";
import type CouchSyncPlugin from "./main.ts";
import { ProgressNotice } from "./ui/notices.ts";
import { ConsistencyReportModal } from "./ui/consistency-report-modal.ts";
import { totalDiscrepancies } from "./sync/reconciler.ts";
import { logWarn, notify } from "./ui/log.ts";
import { gcOrphanChunks } from "./db/chunk-gc.ts";

/**
 * Register all Command-Palette commands on the plugin.
 * Extracted from main.ts to keep onload() focused on wiring.
 */
export function registerCommands(plugin: CouchSyncPlugin): void {
    plugin.addCommand({
        id: "couchsync-show-history",
        name: "Show file history",
        callback: () => {
            const file = plugin.app.workspace.getActiveFile();
            if (file) plugin.showHistory(file.path);
        },
    });

    plugin.addCommand({
        id: "couchsync-show-log",
        name: "Show sync log",
        callback: () => plugin.activateLogView(),
    });

    plugin.addCommand({
        id: "couchsync-force-sync",
        name: "Force sync all files now",
        callback: async () => {
            const report = await plugin.reconciler.reconcile("manual");
            if (plugin.settings.connectionState === "syncing") {
                await plugin.replicator.requestReconnect("manual");
            }
            const total =
                report.pushed.length +
                report.localWins.length +
                report.remoteWins.length +
                report.deleted.length +
                report.restored.length;
            notify(`Force sync: ${total} change(s) applied.`);
        },
    });

    plugin.addCommand({
        id: "couchsync-verify-consistency",
        name: "Verify consistency (vault ↔ local DB ↔ remote)",
        callback: async () => {
            const progress = new ProgressNotice("Verify");
            try {
                if (plugin.settings.connectionState === "syncing") {
                    progress.update("Pulling latest from remote...");
                    try {
                        await plugin.remoteOps.pullAll();
                    } catch (e: any) {
                        logWarn(`CouchSync: verify pull failed, continuing with local view: ${e?.message ?? e}`);
                    }
                }
                progress.update("Reconciling...");
                const report = await plugin.reconciler.reconcile("manual", { mode: "report" });
                const total = totalDiscrepancies(report);
                progress.done(`Verify: ${total} discrepancy(ies)`);
                new ConsistencyReportModal(plugin.app, report, async () => {
                    await plugin.reconciler.reconcile("manual-repair");
                }).open();
            } catch (e: any) {
                progress.done(`Verify failed: ${e.message ?? e}`);
            }
        },
    });

    plugin.addCommand({
        id: "couchsync-config-init",
        name: "Init config sync (clean rebuild)",
        callback: async () => {
            await plugin.configSync.init();
        },
    });

    plugin.addCommand({
        id: "couchsync-config-push",
        name: "Push config files to remote",
        callback: async () => {
            await plugin.configSync.push();
        },
    });

    plugin.addCommand({
        id: "couchsync-config-pull",
        name: "Pull config files from remote",
        callback: async () => {
            await plugin.configSync.pull();
        },
    });

    plugin.addCommand({
        id: "couchsync-gc-chunks",
        name: "Clean up orphan chunks",
        callback: async () => {
            const result = await gcOrphanChunks(plugin.localDb);
            new Notice(
                result.deletedChunks > 0
                    ? `Deleted ${result.deletedChunks} orphan chunk(s) out of ${result.scannedChunks} total.`
                    : `No orphan chunks found (${result.scannedChunks} chunks, all referenced).`,
            );
        },
    });

    plugin.addCommand({
        id: "couchsync-reconnect",
        name: "Reconnect sync",
        callback: async () => {
            if (plugin.auth.isBlocked()) {
                notify(
                    "CouchSync: auth is blocked. Update credentials in " +
                        "Vault Sync (Step 1) before reconnecting.",
                    8000,
                );
                return;
            }
            if (plugin.settings.connectionState !== "syncing") {
                notify(
                    "CouchSync: enable Live Sync in Vault Sync (Step 3) first.",
                    5000,
                );
                return;
            }
            await plugin.replicator.requestReconnect("manual");
            notify("CouchSync: reconnect requested.", 3000);
        },
    });
}
