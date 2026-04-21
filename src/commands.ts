import type CouchSyncPlugin from "./main.ts";
import { ProgressNotice } from "./ui/notices.ts";
import { ConsistencyReportModal } from "./ui/consistency-report-modal.ts";
import { ChunkConsistencyReportModal } from "./ui/chunk-consistency-report-modal.ts";
import { totalDiscrepancies } from "./sync/reconciler.ts";
import { logWarn, notify } from "./ui/log.ts";
import { analyzeChunkConsistency } from "./sync/chunk-consistency.ts";
import { planFromReport, repairChunkDrift } from "./sync/chunk-repair.ts";

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
        const analyze = () =>
            analyzeChunkConsistency({
                localDb: plugin.localDb,
                remote,
                onProgress: (phase, current, total) =>
                    progress.update(
                        total !== undefined
                            ? `${phase}: ${current}/${total}`
                            : `${phase}: ${current}`,
                    ),
            });
        const result = await analyze();
        if (result.state === "needs-convergence") {
            const d = result.divergence;
            progress.done(
                `Chunk report — not converged: ${d.localOnly.length} pending push, ` +
                    `${d.remoteOnly.length} pending pull, ${d.differing.length} differing`,
            );
        } else {
            const r = result.report;
            progress.done(
                `Chunk report — ${r.counts.localOnly} local-only, ` +
                    `${r.counts.remoteOnly} remote-only, ` +
                    `${r.counts.missingReferenced} broken, ` +
                    `${r.counts.orphanLocal + r.counts.orphanRemote} orphan(s)`,
            );
        }
        new ChunkConsistencyReportModal(
            plugin.app,
            result,
            async (currentReport) => {
                const plan = planFromReport(currentReport);
                const repairProgress = new ProgressNotice("Chunk repair");
                const repairResult = await repairChunkDrift(plan, {
                    localDb: plugin.localDb,
                    remote,
                    onProgress: (phase, current, total) =>
                        repairProgress.update(`${phase}: ${current}/${total}`),
                });
                const summary =
                    `pushed ${repairResult.pushed}, pulled ${repairResult.pulled}, ` +
                    `deleted-local ${repairResult.deletedLocal}, ` +
                    `deleted-remote ${repairResult.deletedRemote}`;
                if (repairResult.failed.length === 0) {
                    repairProgress.done(`Repair — ${summary}`);
                } else {
                    repairProgress.fail(
                        `Repair — ${summary}, ${repairResult.failed.length} failed`,
                    );
                    logWarn(
                        `CouchSync: chunk repair failures: ${
                            repairResult.failed
                                .map((f) => `${f.direction} ${f.id}: ${f.reason}`)
                                .join("; ")
                        }`,
                    );
                }
                return await analyze();
            },
            async () => {
                const pullProgress = new ProgressNotice("Pull & re-analyse");
                try {
                    await plugin.remoteOps.pullAll((_docId, n) =>
                        pullProgress.update(`pulled ${n}`),
                    );
                } catch (e: any) {
                    logWarn(
                        `CouchSync: chunk-consistency retry pull failed, continuing with whatever landed: ${e?.message ?? e}`,
                    );
                }
                pullProgress.update("re-analysing...");
                const next = await analyze();
                if (next.state === "converged") {
                    pullProgress.done("Re-analyse — converged");
                } else {
                    pullProgress.done(
                        `Re-analyse — still not converged (${
                            next.divergence.localOnly.length +
                            next.divergence.remoteOnly.length +
                            next.divergence.differing.length
                        } diffs remaining)`,
                    );
                }
                return next;
            },
        ).open();
    } catch (e: any) {
        progress.fail(`Chunk report failed: ${e?.message ?? e}`);
    }
}
