import type { App } from "obsidian";
import type { LocalDB } from "../db/local-db.ts";
import type { SyncEngine } from "../db/sync-engine.ts";
import { ConflictResolver } from "./conflict-resolver.ts";
import type { HistoryCapture } from "../history/history-capture.ts";
import type { CouchSyncSettings } from "../settings.ts";
import type { FileDoc, CouchSyncDoc } from "../types.ts";
import { ConflictModal, type ConflictChoice } from "../ui/conflict-modal.ts";
import { isFileDoc } from "../types.ts";
import { joinChunks } from "../db/chunker.ts";
import { isDiffableText } from "../utils/binary.ts";
import { incrementVC, mergeVC } from "../sync/vector-clock.ts";
import { stripRev } from "../utils/doc.ts";
import { logDebug, logInfo, logError, logWarn, notify } from "../ui/log.ts";

export interface ConflictOrchestratorDeps {
    app: App;
    localDb: LocalDB;
    replicator: SyncEngine;
    hasConfigDb: boolean;
    historyCapture: HistoryCapture;
    dbToFile: (doc: FileDoc) => Promise<void>;
    getSettings: () => CouchSyncSettings;
}

/**
 * Wires conflict detection into the SyncEngine and handles UI-level conflict
 * resolution (modals, history persistence, vclock merging).
 *
 * Extracted from main.ts to keep the plugin shell thin. All conflict-related
 * callbacks that were registered in onload() now live here.
 */
export class ConflictOrchestrator {
    private openConflictModals = new Map<string, ConflictModal>();
    configConflictResolver: ConflictResolver | null = null;

    constructor(private deps: ConflictOrchestratorDeps) {}

    /**
     * Register all conflict-related callbacks on the SyncEngine and
     * ConflictResolver instances. Call once during plugin init.
     */
    register(): void {
        const { replicator, historyCapture } = this.deps;

        // Create conflict resolvers with their onConcurrent handlers.
        const conflictResolver = new ConflictResolver(async (filePath, revisions) => {
            logWarn(
                `CouchSync: concurrent edit on ${filePath} — ${revisions.length} revisions, none dominate`,
            );
            try {
                const dec = new TextDecoder("utf-8");
                for (const rev of revisions) {
                    if (!("chunks" in rev)) continue;
                    const chunks = await this.deps.localDb.getChunks(rev.chunks);
                    const buf = joinChunks(chunks);
                    if (!isDiffableText(buf)) continue;
                    await historyCapture.saveConflict(
                        filePath,
                        dec.decode(buf),
                        dec.decode(buf),
                    );
                }
            } catch (e: any) {
                logError(`CouchSync: Failed to persist concurrent-conflict history: ${e?.message ?? e}`);
            }
            notify(
                `CouchSync: concurrent edit on ${filePath.split("/").pop()} — ` +
                    "check Diff History and manually reconcile. No version has been silently dropped.",
                15000,
            );
        });

        // Config-side conflict resolver (only when config sync is enabled).
        // Not yet wired to a replicator — config sync uses one-shot
        // push/pull, not live-sync. The resolver is kept for future use.
        if (this.deps.hasConfigDb) {
            this.configConflictResolver = new ConflictResolver(async (configPath, revisions) => {
                logWarn(
                    `CouchSync: concurrent config edit on ${configPath} — ${revisions.length} revisions, none dominate`,
                );
                notify(
                    `CouchSync: concurrent config edit on ${configPath.split("/").pop()} — ` +
                        "manual resolution needed. The config DB conflict tree is preserved.",
                    15000,
                );
            });
        }

        // Wire ConflictResolver into SyncEngine for pull-time vclock guard.
        replicator.setConflictResolver(conflictResolver);

        // Interactive conflict resolution via modal (SyncEngine's onConcurrent)
        replicator.onConcurrent(
            (filePath, localDoc, remoteDoc) => this.handleConcurrent(filePath, localDoc, remoteDoc),
        );

        // Auto-dismiss conflict modals when a resolved version arrives
        // from another device (take-remote auto-resolve).
        replicator.onAutoResolve((filePath) => {
            const modal = this.openConflictModals.get(filePath);
            if (modal) {
                logInfo(`Auto-dismissing conflict modal for ${filePath.split("/").pop()}`);
                modal.dismiss();
                this.openConflictModals.delete(filePath);
            }
        });
    }

    private async handleConcurrent(
        filePath: string,
        localDoc: CouchSyncDoc,
        remoteDoc: CouchSyncDoc,
    ): Promise<void> {
        const { app, localDb, historyCapture } = this.deps;
        const fileName = filePath.split("/").pop();

        if (isFileDoc(localDoc) && isFileDoc(remoteDoc)) {
            try {
                const dec = new TextDecoder("utf-8");
                const localChunks = await localDb.getChunks(localDoc.chunks);
                const localBuf = joinChunks(localChunks);
                const remoteChunks = await localDb.getChunks(remoteDoc.chunks);
                const remoteBuf = joinChunks(remoteChunks);

                if (isDiffableText(localBuf) && isDiffableText(remoteBuf)) {
                    const modal = new ConflictModal(
                        app, filePath,
                        dec.decode(localBuf), dec.decode(remoteBuf),
                    );
                    this.openConflictModals.set(filePath, modal);
                    const choice = await modal.waitForResult();
                    this.openConflictModals.delete(filePath);

                    if (modal.wasDismissed) {
                        logInfo(`Conflict auto-resolved for ${fileName} (other device resolved)`);
                    } else {
                        await this.applyConflictChoice(
                            choice, filePath, localDoc, remoteDoc,
                        );
                    }
                } else {
                    // Binary — auto keep-local + merge vclocks for push.
                    logInfo(`Conflict resolved: keep-local (binary) for ${fileName}`);
                    await this.applyConflictChoice(
                        "keep-local", filePath, localDoc, remoteDoc,
                    );
                    notify(
                        `CouchSync: concurrent edit on binary file ${fileName} — ` +
                            "keeping local version. Check Diff History for details.",
                        10000,
                    );
                }

                // Save both versions to history.
                await historyCapture.saveConflict(
                    filePath,
                    isDiffableText(localBuf) ? dec.decode(localBuf) : "",
                    isDiffableText(remoteBuf) ? dec.decode(remoteBuf) : "",
                );
            } catch (e: any) {
                this.openConflictModals.delete(filePath);
                logError(`Conflict resolution error for ${fileName}: ${e?.message ?? e}`);
                notify(
                    `CouchSync: conflict on ${fileName} — keeping local version due to error.`,
                    10000,
                );
            }
        } else {
            // ConfigDoc or unknown — keep local, merge vclocks for push.
            if ("vclock" in localDoc && "vclock" in remoteDoc) {
                const deviceId = this.deps.getSettings().deviceId;
                const merged = mergeVC(
                    (localDoc as any).vclock ?? {},
                    (remoteDoc as any).vclock ?? {},
                );
                const updated = { ...localDoc, vclock: incrementVC(merged, deviceId) };
                await localDb.runWrite({
                    docs: [{ doc: stripRev(updated) as CouchSyncDoc }],
                });
            }
            notify(
                `CouchSync: concurrent config edit on ${fileName} — keeping local version.`,
                8000,
            );
        }
    }

    /**
     * Apply user's conflict resolution choice. Merges vclocks and writes
     * to localDB so the push loop carries the result to remote.
     */
    private async applyConflictChoice(
        choice: ConflictChoice,
        filePath: string,
        localDoc: FileDoc,
        remoteDoc: FileDoc,
    ): Promise<void> {
        const { localDb, replicator } = this.deps;
        const deviceId = this.deps.getSettings().deviceId;
        const fileName = filePath.split("/").pop();

        if (choice === "take-remote") {
            logInfo(`Conflict resolved: take-remote for ${fileName}`);
            const updated = {
                ...remoteDoc,
                vclock: incrementVC(remoteDoc.vclock ?? {}, deviceId),
            };
            await localDb.runWrite({
                docs: [{ doc: stripRev(updated) as CouchSyncDoc }],
            });
            await replicator.ensureFileChunks(updated as FileDoc);
            await this.deps.dbToFile(updated as FileDoc);
        } else {
            logInfo(`Conflict resolved: keep-local for ${fileName}`);
            const merged = mergeVC(
                localDoc.vclock ?? {},
                remoteDoc.vclock ?? {},
            );
            const updated = {
                ...localDoc,
                vclock: incrementVC(merged, deviceId),
            };
            await localDb.runWrite({
                docs: [{ doc: stripRev(updated) as CouchSyncDoc }],
            });
            logDebug(`  vclock after merge: ${JSON.stringify(updated.vclock)}`);
        }
    }
}
