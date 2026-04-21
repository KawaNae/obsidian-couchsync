import type CouchSyncPlugin from "./main.ts";
import { ProgressNotice } from "./ui/notices.ts";
import { ConsistencyReportModal } from "./ui/consistency-report-modal.ts";
import { ChunkConsistencyReportModal } from "./ui/chunk-consistency-report-modal.ts";
import { totalDiscrepancies } from "./sync/reconciler.ts";
import { logWarn, notify } from "./ui/log.ts";
import { analyzeChunkConsistency } from "./sync/chunk-consistency.ts";

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
        id: "couchsync-verify-consistency",
        name: "Verify consistency and repair",
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
        id: "couchsync-chunk-consistency-report",
        name: "Chunk consistency report (local ↔ remote)",
        callback: () => runChunkConsistencyReport(plugin),
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

/**
 * Run the chunk consistency report: streams the local and remote chunk
 * inventories, surfaces the 5 discrepancy buckets, opens a Modal.
 * Exported so both the command palette and the Maintenance tab share
 * the exact same entry point.
 */
export async function runChunkConsistencyReport(
    plugin: CouchSyncPlugin,
): Promise<void> {
    const progress = new ProgressNotice("Chunk consistency");
    try {
        const remote = plugin.remoteOps.makeClient();
        const report = await analyzeChunkConsistency({
            localDb: plugin.localDb,
            remote,
            onProgress: (phase, current, total) =>
                progress.update(
                    total !== undefined
                        ? `${phase}: ${current}/${total}`
                        : `${phase}: ${current}`,
                ),
        });
        progress.done(
            `Chunk report — ${report.counts.localOnly} local-only, ` +
                `${report.counts.remoteOnly} remote-only, ` +
                `${report.counts.missingReferenced} broken, ` +
                `${report.counts.orphanLocal + report.counts.orphanRemote} orphan(s)`,
        );
        new ChunkConsistencyReportModal(plugin.app, report).open();
    } catch (e: any) {
        progress.fail(`Chunk report failed: ${e?.message ?? e}`);
    }
}
