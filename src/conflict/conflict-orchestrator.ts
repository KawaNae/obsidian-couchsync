import type { LocalDB } from "../db/local-db.ts";
import type { SyncEngine } from "../db/sync-engine.ts";
import { ConflictResolver } from "./conflict-resolver.ts";
import type { HistoryCapture } from "../history/history-capture.ts";
import type { CouchSyncSettings } from "../settings.ts";
import type { WriteResult } from "../sync/vault-writer.ts";
import type { VaultSync } from "../sync/vault-sync.ts";
import type { IVaultIO } from "../types/vault-io.ts";
import type { FileDoc, CouchSyncDoc } from "../types.ts";
import type { IModalPresenter, ConflictBatchItem } from "../types/modal-presenter.ts";
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
    /** Conflicts in a single drain ≥ this count are shown as ONE batch modal
     *  instead of N stacked single modals (the black-screen fix). Default 10. */
    batchThreshold?: number;
    /** Debounce window (ms) for coalescing a burst of conflicts (e.g. a catchup
     *  that emits hundreds) into one drain so they batch together. Default 300.
     *  Tests pass 0 to drain on the next macrotask. */
    batchDebounceMs?: number;
}

const EMPTY_BUF = new ArrayBuffer(0);

/**
 * The result of surfacing a conflict to the user.
 * - `resolved`: the user picked a winner, another device resolved it, or an
 *   error forced a safe-side keep-local. The durable pending-conflict record
 *   (if any) may be cleared.
 * - `deferred`: the user closed without choosing (× = 保留). NOTHING was
 *   applied and the durable record MUST be kept for re-presentation.
 */
type ConflictOutcome = "resolved" | "deferred";

/** A conflict waiting to be presented to the user (queued for batch/serial
 *  drain). The apply closures capture the origin-specific resolution logic so
 *  the queue is origin-agnostic. `clearDurable` drops the durable
 *  pending-conflict record on resolve (no-op for reconcile-origin conflicts,
 *  which are naturally re-presented by the next reconcile). */
interface QueuedConflict {
    filePath: string;
    localBuf: ArrayBuffer;
    remoteBuf: ArrayBuffer;
    applyTakeRemote: () => Promise<void>;
    applyKeepLocal: () => Promise<void>;
    clearDurable: () => Promise<void>;
    waiters: Array<() => void>;
}

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
 *   - `handleDivergentRecreate` from Reconciler — vault file present over
 *     a LocalDB tombstone with no explaining baseline (Invariant 7,
 *     recreate-after-delete with lost causal anchor)
 *
 * All entries funnel through the same modal pipeline; only the apply
 * callbacks differ.
 */
export class ConflictOrchestrator {
    private openConflictDismiss = new Map<string, () => void>();
    /** Paths currently being SHOWN / resolved (modal open or mid-apply). Guards
     *  against a re-emit (a fresh session's pending-conflict drain or a
     *  reconnect) stacking a second modal for a path already in flight. */
    private inFlightConflicts = new Set<string>();

    /** Conflicts awaiting presentation, keyed by path (dedup). Drained as a
     *  group so a burst presents as ONE batch modal instead of N stacked ones
     *  (the 2026-06-02 black-screen). */
    private queue = new Map<string, QueuedConflict>();
    private draining = false;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private deps: ConflictOrchestratorDeps) {}

    private get batchThreshold(): number {
        return this.deps.batchThreshold ?? 10;
    }
    private get batchDebounceMs(): number {
        return this.deps.batchDebounceMs ?? 300;
    }

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
            // Another device resolved this path while it was still queued —
            // drop it from the queue so the batch/single drain doesn't show it.
            const queued = this.queue.get(filePath);
            if (queued) {
                this.queue.delete(filePath);
                for (const w of queued.waiters) w();
            }
            // Drop any durable conflict record so the pull drain won't
            // re-present it (#3 / edit-vs-edit).
            void clearPendingConflict(this.deps.localDb, makeFileId(filePath)).catch(() => {});
        });
    }

    // ── Entry points ─────────────────────────────────────

    /**
     * Pull-time concurrent event. File-vs-file conflicts are queued for
     * batched/serialized presentation; config conflicts keep-local inline
     * (no diff modal exists for config).
     */
    private async handleConcurrent(
        filePath: string,
        localDoc: CouchSyncDoc,
        remoteDoc: CouchSyncDoc,
    ): Promise<void> {
        if (this.inFlightConflicts.has(filePath) || this.queue.has(filePath)) {
            logDebug(`Concurrent for ${filePath.split("/").pop()} suppressed — already in flight/queued`);
            return;
        }

        if (isFileDoc(localDoc) && isFileDoc(remoteDoc)) {
            let localBuf: ArrayBuffer;
            let remoteBuf: ArrayBuffer;
            try {
                localBuf = joinChunks(await this.deps.localDb.getChunks(localDoc.chunks));
                remoteBuf = joinChunks(await this.deps.localDb.getChunks(remoteDoc.chunks));
            } catch (e: any) {
                logError(`Conflict resolution error for ${filePath.split("/").pop()}: ${e?.message ?? e}`);
                notify(
                    `CouchSync: conflict on ${filePath.split("/").pop()} — keeping local version due to error.`,
                    10000,
                );
                await clearPendingConflict(this.deps.localDb, localDoc._id).catch(() => {});
                return;
            }
            await this.enqueue({
                filePath,
                localBuf,
                remoteBuf,
                applyTakeRemote: () => this.applyConflictChoice("take-remote", filePath, localDoc, remoteDoc),
                applyKeepLocal: () => this.applyConflictChoice("keep-local", filePath, localDoc, remoteDoc),
                clearDurable: () => clearPendingConflict(this.deps.localDb, localDoc._id).catch(() => {}),
                waiters: [],
            });
            return;
        }

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

    // ── Queue / drain ────────────────────────────────────

    /** Add a conflict to the presentation queue and schedule a drain. Returns
     *  a promise that resolves once the conflict has been presented + applied
     *  (so the reconciler / tests can await completion). Same-path re-enqueue
     *  attaches a waiter to the existing entry; an in-flight path is skipped. */
    private enqueue(item: QueuedConflict): Promise<void> {
        if (this.inFlightConflicts.has(item.filePath)) return Promise.resolve();
        const existing = this.queue.get(item.filePath);
        if (existing) {
            return new Promise<void>((res) => existing.waiters.push(res));
        }
        const p = new Promise<void>((res) => item.waiters.push(res));
        this.queue.set(item.filePath, item);
        this.scheduleDrain();
        return p;
    }

    private scheduleDrain(): void {
        if (this.debounceTimer !== null) return;
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            void this.drain();
        }, this.batchDebounceMs);
    }

    /** Present queued conflicts. Loops until the queue is empty (items added
     *  while a group is being shown are picked up next round). Never opens more
     *  than one modal at a time (single OR batch) — the black-screen fix. */
    private async drain(): Promise<void> {
        if (this.draining) return;
        this.draining = true;
        try {
            while (this.queue.size > 0) {
                const items = Array.from(this.queue.values());
                this.queue.clear();
                for (const it of items) this.inFlightConflicts.add(it.filePath);
                try {
                    if (items.length >= this.batchThreshold) {
                        await this.processBatch(items);
                    } else {
                        for (const it of items) await this.processSingle(it);
                    }
                } finally {
                    for (const it of items) {
                        this.inFlightConflicts.delete(it.filePath);
                        for (const w of it.waiters) w();
                    }
                }
            }
        } finally {
            this.draining = false;
        }
    }

    /** Present one conflict via the side-by-side modal and apply the choice. */
    private async processSingle(item: QueuedConflict): Promise<void> {
        let outcome: ConflictOutcome = "resolved";
        try {
            outcome = await this.runConflictModalAndApply({
                filePath: item.filePath,
                localBuf: item.localBuf,
                remoteBuf: item.remoteBuf,
                applyTakeRemote: item.applyTakeRemote,
                applyKeepLocal: item.applyKeepLocal,
            });
        } catch (e: any) {
            this.openConflictDismiss.delete(item.filePath);
            logError(`Conflict resolution error for ${item.filePath.split("/").pop()}: ${e?.message ?? e}`);
            notify(
                `CouchSync: conflict on ${item.filePath.split("/").pop()} — keeping local version due to error.`,
                10000,
            );
            outcome = "resolved";
        }
        // A defer keeps the durable record so it re-presents next session
        // (Invariant B). Anything else (resolved / error keep-local) clears it.
        if (outcome !== "deferred") await item.clearDurable();
    }

    /** Present many conflicts as ONE batch modal and apply the bulk decision. */
    private async processBatch(items: QueuedConflict[]): Promise<void> {
        const dec = new TextDecoder("utf-8");
        const batchItems: ConflictBatchItem[] = items.map((it) => {
            const ld = isDiffableText(it.localBuf);
            const rd = isDiffableText(it.remoteBuf);
            return {
                filePath: it.filePath,
                localText: ld ? dec.decode(it.localBuf) : "",
                remoteText: rd ? dec.decode(it.remoteBuf) : "",
                binary: !(ld && rd),
            };
        });

        const decision = await this.deps.modal.showConflictBatchModal(batchItems);
        switch (decision.kind) {
            case "all-take-remote": {
                // Destructive bulk action — gate behind an explicit confirm.
                const ok = await this.deps.modal.showConfirmModal(
                    "Take remote for all conflicts?",
                    `This replaces your local version of ${items.length} file(s) with ` +
                        `the remote version. This cannot be undone.`,
                    "Take all remote",
                    true,
                );
                if (!ok) {
                    logInfo(`Batch take-remote cancelled — ${items.length} conflict(s) deferred`);
                    return; // keep durable records (defer)
                }
                for (const it of items) await this.applyBatchChoice(it, "take-remote");
                return;
            }
            case "all-keep-local":
                for (const it of items) await this.applyBatchChoice(it, "keep-local");
                return;
            case "individual":
                for (const it of items) await this.processSingle(it);
                return;
            case "all-defer":
            case "dismissed":
                logInfo(`Deferred ${items.length} conflict(s) — kept for later (nothing changed)`);
                return; // keep durable records
            default: {
                const _exhaustive: never = decision;
                void _exhaustive;
                return;
            }
        }
    }

    /** Apply one bulk winner to a single queued conflict + record history. */
    private async applyBatchChoice(
        item: QueuedConflict,
        choice: "keep-local" | "take-remote",
    ): Promise<void> {
        const dec = new TextDecoder("utf-8");
        try {
            if (choice === "take-remote") await item.applyTakeRemote();
            else await item.applyKeepLocal();
            await this.deps.historyCapture.saveConflict(
                item.filePath,
                isDiffableText(item.localBuf) ? dec.decode(item.localBuf) : "",
                isDiffableText(item.remoteBuf) ? dec.decode(item.remoteBuf) : "",
                choice === "take-remote" ? "remote" : "local",
            );
            await item.clearDurable();
        } catch (e: any) {
            // Leave the durable record so the failed item re-presents.
            logError(`Batch ${choice} failed for ${item.filePath.split("/").pop()}: ${e?.message ?? e}`);
        }
    }

    /**
     * Reconciler entry: vault has user edits that drifted from the last
     * integration baseline while a pull advanced the LocalDB doc beyond
     * what was integrated to the vault. Surface as a conflict instead of
     * letting the next dbToFile retry overwrite the user's edit.
     */
    async handleDivergentLocalEdit(filePath: string, remoteDoc: FileDoc): Promise<void> {
        if (this.inFlightConflicts.has(filePath) || this.queue.has(filePath)) return;
        let localBuf: ArrayBuffer;
        let remoteBuf: ArrayBuffer;
        try {
            localBuf = await this.deps.vault.readBinary(filePath);
            remoteBuf = joinChunks(await this.deps.localDb.getChunks(remoteDoc.chunks));
        } catch (e: any) {
            this.openConflictDismiss.delete(filePath);
            logError(
                `Divergent-edit resolution error for ${filePath.split("/").pop()}: ${e?.message ?? e}`,
            );
            notify(
                `CouchSync: divergent edit on ${filePath.split("/").pop()} — keeping local version due to error.`,
                10000,
            );
            return;
        }
        // Reconcile-origin: no durable record — the next reconcile re-detects
        // `true-divergent` and re-enqueues, so a defer is naturally re-presented.
        await this.enqueue({
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
            applyKeepLocal: () => this.deps.vaultSync.forceLocalEdit(filePath, remoteDoc.vclock ?? {}),
            clearDurable: async () => {},
            waiters: [],
        });
    }

    /**
     * Reconciler entry: user deleted a file in the vault while a pull
     * advanced the LocalDB doc beyond what was integrated. The deletion
     * intent was suppressed by `markDeleted`'s divergent guard. Surface
     * as a conflict so the user picks "keep deletion" or "restore from
     * remote" instead of the auto-restore default.
     */
    async handleDivergentLocalDelete(filePath: string, remoteDoc: FileDoc): Promise<void> {
        if (this.inFlightConflicts.has(filePath) || this.queue.has(filePath)) return;
        let remoteBuf: ArrayBuffer;
        try {
            remoteBuf = joinChunks(await this.deps.localDb.getChunks(remoteDoc.chunks));
        } catch (e: any) {
            this.openConflictDismiss.delete(filePath);
            logError(
                `Divergent-delete resolution error for ${filePath.split("/").pop()}: ${e?.message ?? e}`,
            );
            notify(
                `CouchSync: divergent delete on ${filePath.split("/").pop()} — keeping local deletion due to error.`,
                10000,
            );
            return;
        }
        await this.enqueue({
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
            applyKeepLocal: () => this.deps.vaultSync.forceMarkDeleted(filePath, remoteDoc.vclock ?? {}),
            clearDurable: async () => {},
            waiters: [],
        });
    }

    /**
     * Reconciler entry — a vault file exists over a LocalDB tombstone with
     * no baseline explaining it (classifier `true-divergent` with
     * `rightDeleted`, Invariant 7). Mirror image of
     * `handleDivergentLocalDelete`: there the file is gone and the doc is
     * alive; here the file is present and the doc is deleted. Neither
     * silent outcome is safe — restoring would resurrect a deletion (the
     * H-1 data-loss shape), skipping would wedge the path unpushable (the
     * W24 bug shape) — so the user arbitrates.
     *
     * Invariant 6 note: `tombstoneDoc` is the committed LocalDB tombstone
     * (markDeleted- or buildAcceptedTombstone-origin, real vclock). The
     * fake `vclock: {}` carrier built by `handlePulledDeletion` is never
     * committed, so it cannot reach this path; and `forceLocalEdit` merges
     * `existing.vclock` inside its snapshot anyway — two independent
     * layers against a placeholder seed.
     */
    async handleDivergentRecreate(filePath: string, tombstoneDoc: FileDoc): Promise<void> {
        if (this.inFlightConflicts.has(filePath) || this.queue.has(filePath)) return;
        let localBuf: ArrayBuffer;
        try {
            localBuf = await this.deps.vault.readBinary(filePath);
        } catch (e: any) {
            logError(
                `Divergent-recreate resolution error for ${filePath.split("/").pop()}: ${e?.message ?? e}`,
            );
            notify(
                `CouchSync: divergent recreate on ${filePath.split("/").pop()} — left untouched due to error.`,
                10000,
            );
            return;
        }
        await this.enqueue({
            filePath,
            localBuf,
            remoteBuf: EMPTY_BUF,
            applyTakeRemote: async () => {
                // Accept the deletion: remove the recreated file from disk and
                // establish the deleted baseline (dbToFile tombstone branch).
                const writeResult = await this.deps.dbToFile(tombstoneDoc);
                if (writeResult.applied === false) {
                    logWarn(
                        `Divergent-recreate take-remote: vault write skipped: ` +
                        `${filePath.split("/").pop()} (${writeResult.reason})`,
                    );
                }
            },
            // Keep the recreated file: commit it over the tombstone with a
            // vclock that dominates it, so the recreate replicates everywhere.
            applyKeepLocal: () => this.deps.vaultSync.forceLocalEdit(filePath, tombstoneDoc.vclock ?? {}),
            clearDurable: async () => {},
            waiters: [],
        });
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
    }): Promise<ConflictOutcome> {
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
                return "resolved";
            }
            if (choice === "defer") {
                // × / Esc / "Later" — apply NOTHING, keep the durable record
                // so it re-presents next session. Never overwrite remote.
                logInfo(`Conflict deferred for ${fileName} — kept for later (no change applied)`);
                return "deferred";
            }
            if (choice === "take-remote") {
                await applyTakeRemote();
                await historyCapture.saveConflict(filePath, localText, remoteText, "remote");
            } else {
                await applyKeepLocal();
                await historyCapture.saveConflict(filePath, localText, remoteText, "local");
            }
            return "resolved";
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
        return "resolved";
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
        choice: "keep-local" | "take-remote",
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
