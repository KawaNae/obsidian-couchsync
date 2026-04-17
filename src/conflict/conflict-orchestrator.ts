import type { LocalDB } from "../db/local-db.ts";
import type { SyncEngine } from "../db/sync-engine.ts";
import { ConflictResolver } from "./conflict-resolver.ts";
import type { HistoryCapture } from "../history/history-capture.ts";
import type { CouchSyncSettings } from "../settings.ts";
import type { FileDoc, CouchSyncDoc } from "../types.ts";
import type { IModalPresenter, ConflictChoice } from "../types/modal-presenter.ts";
import { isFileDoc, isConfigDoc } from "../types.ts";
import { joinChunks } from "../db/chunker.ts";
import { isDiffableText } from "../utils/binary.ts";
import { incrementVC, mergeVC } from "../sync/vector-clock.ts";
import { stripRev } from "../utils/doc.ts";
import { logDebug, logInfo, logError, notify } from "../ui/log.ts";

export interface ConflictOrchestratorDeps {
    modal: IModalPresenter;
    localDb: LocalDB;
    replicator: SyncEngine;
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
    private openConflictDismiss = new Map<string, () => void>();

    constructor(private deps: ConflictOrchestratorDeps) {}

    /**
     * Register all conflict-related callbacks on the SyncEngine and
     * ConflictResolver instances. Call once during plugin init.
     */
    register(): void {
        const { replicator } = this.deps;

        // ConflictResolver is a pure vclock comparison utility — no callbacks.
        const conflictResolver = new ConflictResolver();

        // Wire ConflictResolver into SyncEngine for pull-time vclock guard.
        replicator.setConflictResolver(conflictResolver);

        // Interactive conflict resolution via modal (SyncEngine's concurrent event).
        // Return the promise so subscribers that want to await (e.g. tests) can.
        replicator.events.on("concurrent", ({ filePath, localDoc, remoteDoc }) =>
            this.handleConcurrent(filePath, localDoc, remoteDoc),
        );

        // Auto-dismiss conflict modals when a resolved version arrives
        // from another device (take-remote auto-resolve).
        replicator.events.on("auto-resolve", ({ filePath }) => {
            const dismiss = this.openConflictDismiss.get(filePath);
            if (dismiss) {
                logInfo(`Auto-dismissing conflict modal for ${filePath.split("/").pop()}`);
                dismiss();
                this.openConflictDismiss.delete(filePath);
            }
        });
    }

    private async handleConcurrent(
        filePath: string,
        localDoc: CouchSyncDoc,
        remoteDoc: CouchSyncDoc,
    ): Promise<void> {
        const { modal: modalPresenter, localDb, historyCapture } = this.deps;
        const fileName = filePath.split("/").pop();

        if (isFileDoc(localDoc) && isFileDoc(remoteDoc)) {
            try {
                const dec = new TextDecoder("utf-8");
                const localChunks = await localDb.getChunks(localDoc.chunks);
                const localBuf = joinChunks(localChunks);
                const remoteChunks = await localDb.getChunks(remoteDoc.chunks);
                const remoteBuf = joinChunks(remoteChunks);

                if (isDiffableText(localBuf) && isDiffableText(remoteBuf)) {
                    const { result, dismiss } = modalPresenter.showConflictModal(
                        filePath,
                        dec.decode(localBuf), dec.decode(remoteBuf),
                    );
                    this.openConflictDismiss.set(filePath, dismiss);
                    const { choice, dismissed } = await result;
                    this.openConflictDismiss.delete(filePath);

                    if (dismissed) {
                        logInfo(`Conflict auto-resolved for ${fileName} (other device resolved)`);
                    } else {
                        await this.applyConflictChoice(
                            choice, filePath, localDoc, remoteDoc,
                        );
                        // Record conflict history AFTER choice is applied,
                        // with correct winner/loser assignment.
                        const winner = choice === "take-remote" ? "remote" as const : "local" as const;
                        await historyCapture.saveConflict(
                            filePath,
                            dec.decode(localBuf),
                            dec.decode(remoteBuf),
                            winner,
                        );
                    }
                } else {
                    // Binary — auto keep-local + merge vclocks for push.
                    logInfo(`Conflict resolved: keep-local (binary) for ${fileName}`);
                    await this.applyConflictChoice(
                        "keep-local", filePath, localDoc, remoteDoc,
                    );
                    // Record conflict history for binary files too.
                    await historyCapture.saveConflict(
                        filePath,
                        isDiffableText(localBuf) ? dec.decode(localBuf) : "",
                        isDiffableText(remoteBuf) ? dec.decode(remoteBuf) : "",
                        "local",
                    );
                    notify(
                        `CouchSync: concurrent edit on binary file ${fileName} — ` +
                            "keeping local version. Check Diff History for details.",
                        10000,
                    );
                }
            } catch (e: any) {
                this.openConflictDismiss.delete(filePath);
                logError(`Conflict resolution error for ${fileName}: ${e?.message ?? e}`);
                notify(
                    `CouchSync: conflict on ${fileName} — keeping local version due to error.`,
                    10000,
                );
            }
        } else {
            // ConfigDoc (or unknown) — keep local, merge vclocks for push.
            // Narrow to the vclock-bearing union (FileDoc | ConfigDoc);
            // ChunkDocs have no vclock, so we skip those paths silently.
            if (
                (isFileDoc(localDoc) || isConfigDoc(localDoc))
                && (isFileDoc(remoteDoc) || isConfigDoc(remoteDoc))
            ) {
                const deviceId = this.deps.getSettings().deviceId;
                const merged = mergeVC(localDoc.vclock, remoteDoc.vclock);
                const updated = { ...localDoc, vclock: incrementVC(merged, deviceId) };
                await localDb.runWriteTx({
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
            await localDb.runWriteTx({
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
            await localDb.runWriteTx({
                docs: [{ doc: stripRev(updated) as CouchSyncDoc }],
            });
            logDebug(`  vclock after merge: ${JSON.stringify(updated.vclock)}`);
        }
    }
}
