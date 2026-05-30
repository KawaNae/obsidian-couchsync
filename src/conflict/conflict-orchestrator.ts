import type { LocalDB } from "../db/local-db.ts";
import type { SyncEngine } from "../db/sync-engine.ts";
import { ConflictResolver } from "./conflict-resolver.ts";
import type { HistoryCapture } from "../history/history-capture.ts";
import type { CouchSyncSettings } from "../settings.ts";
import type { WriteResult } from "../sync/vault-writer.ts";
import type { VaultSync } from "../sync/vault-sync.ts";
import type { IVaultIO } from "../types/vault-io.ts";
import type { FileDoc, CouchSyncDoc } from "../types.ts";
import type { IModalPresenter, ConflictChoice } from "../types/modal-presenter.ts";
import { isFileDoc, isConfigDoc } from "../types.ts";
import { joinChunks } from "../db/chunker.ts";
import { isDiffableText } from "../utils/binary.ts";
import { incrementVC, mergeVC } from "../sync/vector-clock.ts";
import { stripRev } from "../utils/doc.ts";
import { clearPendingConflict } from "../db/sync/pending-conflict.ts";
import { makeFileId } from "../types/doc-id.ts";
import { logDebug, logInfo, logWarn, logError, notify } from "../ui/log.ts";

export interface ConflictOrchestratorDeps {
    modal: IModalPresenter;
    localDb: LocalDB;
    replicator: SyncEngine;
    historyCapture: HistoryCapture;
    dbToFile: (doc: FileDoc) => Promise<WriteResult>;
    getSettings: () => CouchSyncSettings;
    vault: IVaultIO;
    vaultSync: VaultSync;
}

const EMPTY_BUF = new ArrayBuffer(0);

/**
 * Wires conflict detection into the SyncEngine and handles UI-level conflict
 * resolution (modals, history persistence, vclock merging).
 *
 * Three entry points:
 *   - `concurrent` event from PullWriter — pull-time vclock-concurrent
 *     (CRDT-level conflict, neither side dominates)
 *   - `handleDivergentLocalEdit` from Reconciler — vault-content drifted
 *     from last integration baseline while LocalDB doc was advanced by a
 *     pull (Regression A path)
 *   - `handleDivergentLocalDelete` from Reconciler — vault file removed
 *     by user while LocalDB doc was advanced by a pull (Regression B
 *     path)
 *
 * All three funnel through the same modal pipeline; only the apply
 * callbacks differ.
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

        const conflictResolver = new ConflictResolver();
        replicator.setConflictResolver(conflictResolver);

        replicator.events.on("concurrent", ({ filePath, localDoc, remoteDoc }) =>
            this.handleConcurrent(filePath, localDoc, remoteDoc),
        );

        replicator.events.on("auto-resolve", ({ filePath }) => {
            const dismiss = this.openConflictDismiss.get(filePath);
            if (dismiss) {
                logInfo(`Auto-dismissing conflict modal for ${filePath.split("/").pop()}`);
                dismiss();
                this.openConflictDismiss.delete(filePath);
            }
            // Another device resolved this path — drop any durable deletion-
            // conflict record so the pull drain won't re-present it (#3).
            void clearPendingConflict(this.deps.localDb, makeFileId(filePath)).catch(() => {});
        });
    }

    private async handleConcurrent(
        filePath: string,
        localDoc: CouchSyncDoc,
        remoteDoc: CouchSyncDoc,
    ): Promise<void> {
        try {
            await this.handleConcurrentInner(filePath, localDoc, remoteDoc);
        } finally {
            // The deletion-conflict has now been surfaced and handled (resolved,
            // kept-local on error, or dismissed) — drop its durable record so
            // the pull drain does not re-present it (#3). No-op for ids that
            // were never persisted (edit-vs-edit, config). The key is the
            // plaintext file-doc id (local docs are always plaintext-keyed).
            await clearPendingConflict(this.deps.localDb, localDoc._id).catch(() => {});
        }
    }

    private async handleConcurrentInner(
        filePath: string,
        localDoc: CouchSyncDoc,
        remoteDoc: CouchSyncDoc,
    ): Promise<void> {
        if (isFileDoc(localDoc) && isFileDoc(remoteDoc)) {
            try {
                const localChunks = await this.deps.localDb.getChunks(localDoc.chunks);
                const localBuf = joinChunks(localChunks);
                const remoteChunks = await this.deps.localDb.getChunks(remoteDoc.chunks);
                const remoteBuf = joinChunks(remoteChunks);
                await this.runConflictModalAndApply({
                    filePath,
                    localBuf,
                    remoteBuf,
                    applyTakeRemote: () => this.applyConflictChoice(
                        "take-remote", filePath, localDoc, remoteDoc,
                    ),
                    applyKeepLocal: () => this.applyConflictChoice(
                        "keep-local", filePath, localDoc, remoteDoc,
                    ),
                });
            } catch (e: any) {
                this.openConflictDismiss.delete(filePath);
                logError(`Conflict resolution error for ${filePath.split("/").pop()}: ${e?.message ?? e}`);
                notify(
                    `CouchSync: conflict on ${filePath.split("/").pop()} — keeping local version due to error.`,
                    10000,
                );
            }
        } else {
            // ConfigDoc (or unknown) — keep local, merge vclocks for push.
            if (
                (isFileDoc(localDoc) || isConfigDoc(localDoc))
                && (isFileDoc(remoteDoc) || isConfigDoc(remoteDoc))
            ) {
                const deviceId = this.deps.getSettings().deviceId;
                const merged = mergeVC(localDoc.vclock, remoteDoc.vclock);
                const updated = { ...localDoc, vclock: incrementVC(merged, deviceId) };
                await this.deps.localDb.runWriteTx({
                    docs: [{ doc: stripRev(updated) as CouchSyncDoc }],
                });
            }
            notify(
                `CouchSync: concurrent config edit on ${filePath.split("/").pop()} — keeping local version.`,
                8000,
            );
        }
    }

    /**
     * Reconciler entry: vault has user edits that drifted from the last
     * integration baseline while a pull advanced the LocalDB doc beyond
     * what was integrated to the vault. Surface as a conflict instead of
     * letting the next dbToFile retry overwrite the user's edit.
     */
    async handleDivergentLocalEdit(filePath: string, remoteDoc: FileDoc): Promise<void> {
        try {
            const localBuf = await this.deps.vault.readBinary(filePath);
            const remoteChunks = await this.deps.localDb.getChunks(remoteDoc.chunks);
            const remoteBuf = joinChunks(remoteChunks);
            await this.runConflictModalAndApply({
                filePath,
                localBuf,
                remoteBuf,
                applyTakeRemote: async () => {
                    const writeResult = await this.deps.dbToFile(remoteDoc);
                    if (writeResult.applied === false) {
                        logWarn(
                            `Divergent-edit take-remote: vault write skipped: ` +
                            `${filePath.split("/").pop()} (${writeResult.reason})`,
                        );
                    }
                },
                applyKeepLocal: () => this.deps.vaultSync.forceLocalEdit(
                    filePath, remoteDoc.vclock ?? {},
                ),
            });
        } catch (e: any) {
            this.openConflictDismiss.delete(filePath);
            logError(
                `Divergent-edit resolution error for ${filePath.split("/").pop()}: ${e?.message ?? e}`,
            );
            notify(
                `CouchSync: divergent edit on ${filePath.split("/").pop()} — keeping local version due to error.`,
                10000,
            );
        }
    }

    /**
     * Reconciler entry: user deleted a file in the vault while a pull
     * advanced the LocalDB doc beyond what was integrated. The deletion
     * intent was suppressed by `markDeleted`'s divergent guard. Surface
     * as a conflict so the user picks "keep deletion" or "restore from
     * remote" instead of the auto-restore default.
     */
    async handleDivergentLocalDelete(filePath: string, remoteDoc: FileDoc): Promise<void> {
        try {
            const remoteChunks = await this.deps.localDb.getChunks(remoteDoc.chunks);
            const remoteBuf = joinChunks(remoteChunks);
            await this.runConflictModalAndApply({
                filePath,
                localBuf: EMPTY_BUF,
                remoteBuf,
                applyTakeRemote: async () => {
                    const writeResult = await this.deps.dbToFile(remoteDoc);
                    if (writeResult.applied === false) {
                        logWarn(
                            `Divergent-delete take-remote: vault write skipped: ` +
                            `${filePath.split("/").pop()} (${writeResult.reason})`,
                        );
                    }
                },
                applyKeepLocal: () => this.deps.vaultSync.forceMarkDeleted(
                    filePath, remoteDoc.vclock ?? {},
                ),
            });
        } catch (e: any) {
            this.openConflictDismiss.delete(filePath);
            logError(
                `Divergent-delete resolution error for ${filePath.split("/").pop()}: ${e?.message ?? e}`,
            );
            notify(
                `CouchSync: divergent delete on ${filePath.split("/").pop()} — keeping local deletion due to error.`,
                10000,
            );
        }
    }

    /**
     * Shared modal+apply pipeline used by all three conflict entries.
     * Decodes the bufs, picks text/binary path, shows the modal, awaits
     * the user's choice (or auto-dismiss), invokes the matching apply
     * callback, and persists conflict history.
     */
    private async runConflictModalAndApply(args: {
        filePath: string;
        localBuf: ArrayBuffer;
        remoteBuf: ArrayBuffer;
        applyTakeRemote: () => Promise<void>;
        applyKeepLocal: () => Promise<void>;
    }): Promise<void> {
        const { filePath, localBuf, remoteBuf, applyTakeRemote, applyKeepLocal } = args;
        const { modal, historyCapture } = this.deps;
        const fileName = filePath.split("/").pop();
        const dec = new TextDecoder("utf-8");

        const localDiffable = isDiffableText(localBuf);
        const remoteDiffable = isDiffableText(remoteBuf);

        if (localDiffable && remoteDiffable) {
            const localText = dec.decode(localBuf);
            const remoteText = dec.decode(remoteBuf);
            const { result, dismiss } = modal.showConflictModal(filePath, localText, remoteText);
            this.openConflictDismiss.set(filePath, dismiss);
            const { choice, dismissed } = await result;
            this.openConflictDismiss.delete(filePath);

            if (dismissed) {
                logInfo(`Conflict auto-resolved for ${fileName} (other device resolved)`);
                return;
            }
            if (choice === "take-remote") {
                await applyTakeRemote();
                await historyCapture.saveConflict(filePath, localText, remoteText, "remote");
            } else {
                await applyKeepLocal();
                await historyCapture.saveConflict(filePath, localText, remoteText, "local");
            }
            return;
        }

        // Binary path — auto keep-local (matches existing concurrent
        // behavior). saveConflict captures whichever side is text-like.
        logInfo(`Conflict resolved: keep-local (binary) for ${fileName}`);
        await applyKeepLocal();
        await historyCapture.saveConflict(
            filePath,
            localDiffable ? dec.decode(localBuf) : "",
            remoteDiffable ? dec.decode(remoteBuf) : "",
            "local",
        );
        notify(
            `CouchSync: concurrent edit on binary file ${fileName} — ` +
                "keeping local version. Check Diff History for details.",
            10000,
        );
    }

    /**
     * Apply user's conflict resolution choice for the pull-time
     * `concurrent` event. Merges vclocks and writes to localDB so the
     * push loop carries the result to remote.
     */
    /**
     * Apply the user's conflict-modal choice. The take-remote branch
     * has a special-case for **fake tombstones** produced by
     * `pull-writer.handlePulledDeletion` for the remote-deleted vs
     * local-edit shape: those tombstones carry `vclock: {}` because
     * CouchDB's `_changes` doesn't expose deleted-doc bodies, so the
     * pull side cannot reconstruct the deleting device's vclock.
     *
     * **Invariant 6 (vclock 派生の出所制限).** A fake tombstone is a
     * flag carrier — never a causality source. When we promote one to
     * a real LocalDB tombstone via take-remote, the seed vclock comes
     * from `localDoc.vclock` (the only place this device has observed
     * causal history for `path`), merged with whatever `remoteDoc.vclock`
     * happens to carry (= empty for fake tombstones). The resulting
     * `incrementVC(merged, deviceId)` strictly dominates `localDoc`,
     * so peer devices accept the deletion as a normal update instead
     * of treating the empty-seeded `{deviceId:1}` as a concurrent rev.
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
            // Invariant 6: deletion conflicts seed from localDoc because
            // the fake tombstone's vclock is empty by construction.
            // Non-deletion concurrent edits keep the existing behaviour
            // (remoteDoc.vclock is real causality from the remote rev).
            const isDeletionConflict = remoteDoc.deleted === true;
            const seedVC = isDeletionConflict
                ? mergeVC(localDoc.vclock ?? {}, remoteDoc.vclock ?? {})
                : (remoteDoc.vclock ?? {});
            const updated = {
                ...remoteDoc,
                vclock: incrementVC(seedVC, deviceId),
            };
            await localDb.runWriteTx({
                docs: [{ doc: stripRev(updated) as CouchSyncDoc }],
            });
            await replicator.ensureFileChunks(updated as FileDoc);
            const writeResult = await this.deps.dbToFile(updated as FileDoc);
            if (writeResult.applied === false) {
                logWarn(
                    `Conflict take-remote applied to LocalDB but vault write skipped: ` +
                    `${fileName} (${writeResult.reason})`,
                );
            }
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
