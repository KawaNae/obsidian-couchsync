import type CouchSyncPlugin from "./main.ts";
import { ProgressNotice, showNotice } from "./ui/notices.ts";
import { UserFacingError } from "./ui/describe-error.ts";
import { ConsistencyReportModal } from "./ui/consistency-report-modal.ts";
import { ChunkConsistencyReportModal } from "./ui/chunk-consistency-report-modal.ts";
import { totalDiscrepancies } from "./sync/reconciler.ts";
import { logWarn, notify } from "./ui/log.ts";
import { analyzeChunkConsistency } from "./sync/chunk-consistency.ts";
import { planFromReport, repairChunkDrift } from "./sync/chunk-repair.ts";
import { gcOrphanConfigChunks } from "./db/chunk-gc.ts";

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
            if (file) {
                plugin.showHistory(file.path);
            } else {
                showNotice("No active file. Open a file to view its history.");
            }
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
                        logWarn(`verify pull failed, continuing with local view: ${e?.message ?? e}`);
                    }
                    // Push-backfill: re-enqueue docs a pre-fix push cursor
                    // skipped (permanently unpushed tombstones). Manual path
                    // ignores the one-time startup flag.
                    progress.update("Checking for cursor-skipped docs...");
                    try {
                        const bf = await plugin.replicator.runPushBackfillNow();
                        if (bf && bf.enqueued > 0) {
                            notify(`re-enqueued ${bf.enqueued} doc(s) the push cursor had skipped.`);
                        }
                    } catch (e: any) {
                        logWarn(`push backfill failed during verify: ${e?.message ?? e}`);
                    }
                }
                progress.update("Reconciling...");
                const report = await plugin.reconciler.reconcile("manual", { mode: "report" });
                const total = totalDiscrepancies(report);
                progress.done(`${total} discrepancy(ies)`);
                new ConsistencyReportModal(plugin.app, report, async () => {
                    const repair = new ProgressNotice("Repair");
                    try {
                        const done = await plugin.reconciler.reconcile("manual-repair");
                        repair.done(`${totalDiscrepancies(done)} discrepancy(ies) handled.`);
                    } catch (e) {
                        repair.fail(e);
                    }
                }).open();
            } catch (e) {
                progress.fail(e);
            }
        },
    });

    plugin.addCommand({
        id: "couchsync-chunk-consistency-report",
        name: "Chunk consistency report (local ↔ remote)",
        callback: () => runChunkConsistencyReport(plugin),
    });

    plugin.addCommand({
        id: "couchsync-config-chunk-gc",
        name: "Config: garbage-collect orphan chunks",
        callback: async () => {
            // Runs under ConfigSync's op lock on the CURRENT binding's
            // store: refused while a Push / Pull / Join / Create runs (the
            // sweep would race its writes), and Apply cannot switch the
            // store mid-sweep.
            if (!plugin.configLocalDb) {
                notify("Config DB is not configured.", 5000);
                return;
            }
            const label = "Config GC";
            const progress = new ProgressNotice(label);
            try {
                const result = await plugin.configSync.runExclusive(label, async (binding) => {
                    progress.update("Sweeping orphan chunks...");
                    return gcOrphanConfigChunks(binding.store);
                });
                progress.done(
                    `scanned ${result.scannedChunks}, ` +
                    `referenced ${result.referencedChunks}, ` +
                    `deleted ${result.deletedChunks} orphan(s).`,
                );
            } catch (e) {
                progress.fail(e);
            }
        },
    });

    plugin.addCommand({
        id: "couchsync-reconnect",
        name: "Reconnect sync",
        callback: async () => {
            if (plugin.auth.isBlocked()) {
                notify(plugin.auth.blockedError().userMessage, 8000);
                return;
            }
            if (plugin.settings.connectionState !== "syncing") {
                notify(
                    "enable Live Sync in Vault Sync (Step 3) first.",
                    5000,
                );
                return;
            }
            await plugin.replicator.requestReconnect("manual");
            notify("reconnect requested.", 3000);
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
        // Data-plane client: codec (encryption/compression) decorators
        // applied. On an encrypted vault this is mandatory — the raw client
        // would surface `file:<hmac>` ids (never matching local plaintext
        // ids → permanent needs-convergence) and would push plaintext
        // chunk bodies during repair (vault corruption). Both analyze and
        // repairChunkDrift below share this client.
        const remote = plugin.remoteOps.makeDataClient();
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
                `not converged: ${d.localOnly.length} pending push, ` +
                    `${d.remoteOnly.length} pending pull, ${d.differing.length} differing`,
            );
        } else {
            const r = result.report;
            progress.done(
                `${r.counts.localOnly} local-only, ` +
                    `${r.counts.remoteOnly} remote-only, ` +
                    `${r.counts.missingReferenced} broken, ` +
                    `${r.counts.orphanLocal + r.counts.orphanRemote} orphan(s)`,
            );
        }
        new ChunkConsistencyReportModal(
            plugin.app,
            result,
            async (currentReport) => {
                void currentReport; // the displayed snapshot is a preview only
                const repairProgress = new ProgressNotice("Chunk repair");
                // Re-analyze immediately before acting. The report shown in
                // the modal may be stale (arbitrary user think-time), and acting
                // on a stale snapshot can tombstone a chunk another device just
                // re-referenced. A fresh analyze also re-checks the convergence
                // gate; if the vault diverged meanwhile, abort rather than repair.
                let repairResult: Awaited<ReturnType<typeof repairChunkDrift>>;
                try {
                    const fresh = await analyze();
                    if (fresh.state !== "converged") {
                        repairProgress.fail(new UserFacingError(
                            "The vault is not converged, so nothing was repaired. Let sync settle and retry.",
                        ));
                        return fresh;
                    }
                    const plan = planFromReport(fresh.report);
                    repairResult = await repairChunkDrift(plan, {
                        localDb: plugin.localDb,
                        remote,
                        chunkHasher: plugin.remoteOps.chunkHasher,
                        onProgress: (phase, current, total) =>
                            repairProgress.update(`${phase}: ${current}/${total}`),
                    });
                } catch (e) {
                    // Reported here; the modal only restores its button.
                    repairProgress.fail(e);
                    throw e;
                }
                const summary =
                    `pushed ${repairResult.pushed}, pulled ${repairResult.pulled}, ` +
                    `deleted-local ${repairResult.deletedLocal}, ` +
                    `deleted-remote ${repairResult.deletedRemote}`;
                if (repairResult.failed.length === 0) {
                    repairProgress.done(summary);
                } else {
                    repairProgress.fail(new UserFacingError(
                        `${summary}, ${repairResult.failed.length} failed (see the log).`,
                    ));
                    logWarn(
                        `chunk repair failures: ${
                            repairResult.failed
                                .map((f) => `${f.direction} ${f.id}: ${f.reason}`)
                                .join("; ")
                        }`,
                    );
                }
                try {
                    return await analyze();
                } catch (e) {
                    // The repair itself was reported above; this is the
                    // re-analysis that refreshes the modal.
                    new ProgressNotice("Chunk consistency").fail(e);
                    throw e;
                }
            },
            async () => {
                const pullProgress = new ProgressNotice("Pull & re-analyse");
                try {
                    await plugin.remoteOps.pullAll((_docId, n) =>
                        pullProgress.update(`pulled ${n}`),
                    );
                } catch (e: any) {
                    logWarn(
                        `chunk-consistency retry pull failed, continuing with whatever landed: ${e?.message ?? e}`,
                    );
                }
                pullProgress.update("re-analysing...");
                let next: Awaited<ReturnType<typeof analyze>>;
                try {
                    next = await analyze();
                } catch (e) {
                    // Reported here; the modal only restores its button.
                    pullProgress.fail(e);
                    throw e;
                }
                if (next.state === "converged") {
                    pullProgress.done("converged");
                } else {
                    pullProgress.done(
                        `still not converged (${
                            next.divergence.localOnly.length +
                            next.divergence.remoteOnly.length +
                            next.divergence.differing.length
                        } diffs remaining)`,
                    );
                }
                return next;
            },
        ).open();
    } catch (e) {
        progress.fail(e);
    }
}
