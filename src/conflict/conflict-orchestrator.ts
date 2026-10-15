import type { LocalDB } from "../db/local-db.ts";
import type { SyncEngine } from "../db/sync-engine.ts";
import { ConflictResolver } from "./conflict-resolver.ts";
import type { HistoryCapture } from "../history/history-capture.ts";
import type { CouchSyncSettings } from "../settings.ts";
import type { VaultSync, ForceWriteOutcome } from "../sync/vault-sync.ts";
import type { IVaultIO } from "../types/vault-io.ts";
import type { FileDoc, CouchSyncDoc } from "../types.ts";
import type { IModalPresenter, ConflictBatchItem, ConflictContent } from "../types/modal-presenter.ts";
import { isFileDoc, isConfigDoc } from "../types.ts";
import { joinChunks } from "../db/chunker.ts";
import { isDiffableText } from "../utils/binary.ts";
import { incrementVC, mergeVC, compareVC } from "../sync/vector-clock.ts";
import { stripRev } from "../utils/doc.ts";
import { clearPendingConflict } from "../db/sync/pending-conflict.ts";
import { makeFileId } from "../types/doc-id.ts";
import { logDebug, logInfo, logError, notify } from "../ui/log.ts";

export interface ConflictOrchestratorDeps {
    modal: IModalPresenter;
    localDb: LocalDB;
    replicator: SyncEngine;
    historyCapture: HistoryCapture;
    getSettings: () => CouchSyncSettings;
    vault: IVaultIO;
    vaultSync: VaultSync;
    /** Ask the reconcile to look at the vault again. A choice on a
     *  conflict it found that applied nothing is offered again this way,
     *  with the versions as they are now. */
    requestReconcile: () => void;
    /** Conflicts in a single drain ≥ this count are shown as ONE batch modal
     *  instead of N stacked single modals (the black-screen fix). Default 10. */
    batchThreshold?: number;
    /** Debounce window (ms) for coalescing a burst of conflicts (e.g. a catchup
     *  that emits hundreds) into one drain so they batch together. Default 300.
     *  Tests pass 0 to drain on the next macrotask. */
    batchDebounceMs?: number;
}

const EMPTY_BUF = new ArrayBuffer(0);

/** What the conflict modals show: a diff when both sides are text, each
 *  side's size when either is binary. Either way the user chooses. */
function conflictContent(localBuf: ArrayBuffer, remoteBuf: ArrayBuffer): ConflictContent {
    if (isDiffableText(localBuf) && isDiffableText(remoteBuf)) {
        const dec = new TextDecoder("utf-8");
        return { kind: "text", localText: dec.decode(localBuf), remoteText: dec.decode(remoteBuf) };
    }
    return { kind: "binary", localSize: localBuf.byteLength, remoteSize: remoteBuf.byteLength };
}

/** The conflict history keeps the text of a side; a binary side is kept as "". */
function historyText(buf: ArrayBuffer): string {
    return isDiffableText(buf) ? new TextDecoder("utf-8").decode(buf) : "";
}

/**
 * What applying the user's choice did.
 * - `applied`: the chosen version was committed.
 * - `superseded`: nothing was written, because the local DB doc the dialog
 *   showed had been replaced before the choice was applied (or the vault
 *   file it showed was gone). The conflict is presented again with the
 *   current versions.
 */
type ApplyOutcome = "applied" | "superseded";

/**
 * The result of surfacing a conflict to the user.
 * - `resolved`: the user picked a winner, another device resolved it, or an
 *   error forced a safe-side keep-local. The durable pending-conflict record
 *   (if any) may be cleared.
 * - `deferred`: the user closed without choosing (× = 保留). NOTHING was
 *   applied and the durable record MUST be kept for re-presentation.
 * - `superseded`: the choice applied nothing (see `ApplyOutcome`). The
 *   durable record is kept, as for `deferred`.
 */
type ConflictOutcome = "resolved" | "deferred" | "superseded";

/** A conflict waiting to be presented to the user (queued for batch/serial
 *  drain). The apply closures capture the origin-specific resolution logic so
 *  the queue is origin-agnostic. `clearDurable` drops the durable
 *  pending-conflict record on resolve (no-op for reconcile-origin conflicts,
 *  which are naturally re-presented by the next reconcile). */
interface QueuedConflict {
    filePath: string;
    localBuf: ArrayBuffer;
    remoteBuf: ArrayBuffer;
    applyTakeRemote: () => Promise<ApplyOutcome>;
    applyKeepLocal: () => Promise<ApplyOutcome>;
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
 *     pull
 *   - `handleDivergentLocalDelete` from Reconciler — vault file removed
 *     by user while LocalDB doc was advanced by a pull
 *   - `handleDivergentRecreate` from Reconciler — vault file present over
 *     a LocalDB tombstone with no explaining baseline (recreate-after-
 *     delete with lost causal anchor)
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

    /** Newer concurrent events that arrived while a modal was showing.
     *  After the in-flight resolution completes, these are re-enqueued
     *  so the user sees the latest remote state. */
    private pendingUpdates = new Map<string, { localDoc: CouchSyncDoc; remoteDoc: CouchSyncDoc }>();

    /** Conflicts awaiting presentation, keyed by path (dedup). Drained as a
     *  group so a burst presents as ONE batch modal instead of N stacked ones
     *  (stacked modal overlays turned the screen black). */
    private queue = new Map<string, QueuedConflict>();
    private draining = false;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;

    /** The pull's judgment of local vs remote. Shared with the replicator so
     *  a remote version re-checked here is judged by the same rules. */
    private readonly resolver = new ConflictResolver();

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

        replicator.setConflictResolver(this.resolver);

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
            // re-present it (edit-vs-edit included).
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
        if (this.queue.has(filePath)) {
            if (isFileDoc(localDoc) && isFileDoc(remoteDoc)) {
                const existing = this.queue.get(filePath)!;
                try {
                    existing.remoteBuf = joinChunks(await this.deps.localDb.getChunks(remoteDoc.chunks));
                    existing.localBuf = joinChunks(await this.deps.localDb.getChunks(localDoc.chunks));
                    existing.applyTakeRemote = () => this.applyConflictChoice("take-remote", filePath, localDoc, remoteDoc);
                    existing.applyKeepLocal = () => this.applyConflictChoice("keep-local", filePath, localDoc, remoteDoc);
                } catch {
                    // chunk fetch failed — keep existing entry
                }
            }
            logDebug(`Concurrent for ${filePath.split("/").pop()} updated in queue — newer rev captured`);
            return;
        }
        if (this.inFlightConflicts.has(filePath)) {
            this.pendingUpdates.set(filePath, { localDoc, remoteDoc });
            logDebug(`Concurrent for ${filePath.split("/").pop()} stashed — in-flight resolution pending`);
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
                    `conflict on ${filePath.split("/").pop()} — keeping local version due to error.`,
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
            `concurrent config edit on ${filePath.split("/").pop()} — keeping local version.`,
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
                        const pending = this.pendingUpdates.get(it.filePath);
                        if (pending) {
                            this.pendingUpdates.delete(it.filePath);
                            void this.recheckStashed(it.filePath, pending).catch((e: any) => {
                                logError(`Re-check of ${it.filePath.split("/").pop()} failed: ${e?.message ?? e}`);
                                void this.handleConcurrent(it.filePath, pending.localDoc, pending.remoteDoc);
                            });
                        }
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
                `conflict on ${item.filePath.split("/").pop()} — keeping local version due to error.`,
                10000,
            );
            outcome = "resolved";
        }
        // A defer keeps the durable record so it re-presents next session
        // (it is not re-derived from the pull feed), and so does a choice
        // that applied nothing. Anything else (resolved / error keep-local)
        // clears it.
        if (outcome === "resolved") {
            await item.clearDurable();
            this.deps.replicator.events.emit("conflict-resolved", { filePath: item.filePath });
        }
    }

    /** Present many conflicts as ONE batch modal and apply the bulk decision. */
    private async processBatch(items: QueuedConflict[]): Promise<void> {
        const batchItems: ConflictBatchItem[] = items.map((it) => ({
            filePath: it.filePath,
            content: conflictContent(it.localBuf, it.remoteBuf),
        }));

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
        try {
            const applied = choice === "take-remote"
                ? await item.applyTakeRemote()
                : await item.applyKeepLocal();
            if (applied === "superseded") return; // keep the durable record
            await this.deps.historyCapture.saveConflict(
                item.filePath,
                historyText(item.localBuf),
                historyText(item.remoteBuf),
                choice === "take-remote" ? "remote" : "local",
            );
            await item.clearDurable();
            this.deps.replicator.events.emit("conflict-resolved", { filePath: item.filePath });
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
                `divergent edit on ${filePath.split("/").pop()} — keeping local version due to error.`,
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
            applyTakeRemote: async () => this.vaultSideApplied(
                filePath, await this.deps.vaultSync.takeDocToVault(filePath, remoteDoc.vclock),
            ),
            applyKeepLocal: async () => this.vaultSideApplied(
                filePath, await this.deps.vaultSync.forceLocalEdit(filePath, remoteDoc.vclock),
            ),
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
                `divergent delete on ${filePath.split("/").pop()} — keeping local deletion due to error.`,
                10000,
            );
            return;
        }
        await this.enqueue({
            filePath,
            localBuf: EMPTY_BUF,
            remoteBuf,
            applyTakeRemote: async () => this.vaultSideApplied(
                filePath, await this.deps.vaultSync.takeDocToVault(filePath, remoteDoc.vclock),
            ),
            applyKeepLocal: async () => this.vaultSideApplied(
                filePath, await this.deps.vaultSync.forceMarkDeleted(filePath, remoteDoc.vclock),
            ),
            clearDurable: async () => {},
            waiters: [],
        });
    }

    /**
     * Reconciler entry — a vault file exists over a LocalDB tombstone with
     * no baseline explaining it (classifier `true-divergent` with
     * `rightDeleted`). Mirror image of
     * `handleDivergentLocalDelete`: there the file is gone and the doc is
     * alive; here the file is present and the doc is deleted. Neither
     * silent outcome is safe — restoring would resurrect a deletion (silent
     * un-delete), skipping would wedge the path unpushable forever — so the
     * user arbitrates.
     *
     * vclock provenance: `tombstoneDoc` is the committed LocalDB tombstone
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
                `divergent recreate on ${filePath.split("/").pop()} — left untouched due to error.`,
                10000,
            );
            return;
        }
        await this.enqueue({
            filePath,
            localBuf,
            remoteBuf: EMPTY_BUF,
            // Accept the deletion: remove the recreated file from disk and
            // establish the deleted baseline (dbToFile tombstone branch).
            applyTakeRemote: async () => this.vaultSideApplied(
                filePath, await this.deps.vaultSync.takeDocToVault(filePath, tombstoneDoc.vclock),
            ),
            // Keep the recreated file: commit it over the tombstone with a
            // vclock that dominates it, so the recreate replicates everywhere.
            applyKeepLocal: async () => this.vaultSideApplied(
                filePath, await this.deps.vaultSync.forceLocalEdit(filePath, tombstoneDoc.vclock),
            ),
            clearDurable: async () => {},
            waiters: [],
        });
    }

    /**
     * What a choice on a conflict the reconcile found did. When it wrote
     * nothing (the local DB doc the dialog showed was replaced, or the vault
     * file is gone), the reconcile looks at the path again and offers what
     * is there now, as a pull conflict is offered again with the current
     * version.
     */
    private vaultSideApplied(filePath: string, outcome: ForceWriteOutcome): ApplyOutcome {
        if (outcome === "written") return "applied";
        logInfo(
            `Conflict on ${filePath.split("/").pop()} not applied: the ` +
            `${outcome === "no-file" ? "vault file is gone" : "local version moved"}; re-checking`,
        );
        this.deps.requestReconcile();
        return "superseded";
    }

    /**
     * Shared modal+apply pipeline used by all conflict entries. Shows the
     * two versions (a diff for text, the sizes for binary), awaits the
     * user's choice (or auto-dismiss), invokes the matching apply callback,
     * and persists conflict history.
     */
    private async runConflictModalAndApply(args: {
        filePath: string;
        localBuf: ArrayBuffer;
        remoteBuf: ArrayBuffer;
        applyTakeRemote: () => Promise<ApplyOutcome>;
        applyKeepLocal: () => Promise<ApplyOutcome>;
    }): Promise<ConflictOutcome> {
        const { filePath, localBuf, remoteBuf, applyTakeRemote, applyKeepLocal } = args;
        const { modal, historyCapture } = this.deps;
        const fileName = filePath.split("/").pop();

        const { result, dismiss } = modal.showConflictModal(
            filePath, conflictContent(localBuf, remoteBuf),
        );
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
        const applied = choice === "take-remote" ? await applyTakeRemote() : await applyKeepLocal();
        if (applied === "superseded") return "superseded";
        await historyCapture.saveConflict(
            filePath,
            historyText(localBuf),
            historyText(remoteBuf),
            choice === "take-remote" ? "remote" : "local",
        );
        return "resolved";
    }

    /**
     * Judge again a remote version that arrived while its path's conflict
     * was being resolved, against the local doc as it is now. The pull
     * judged it against the local doc of that moment; the resolution has
     * since changed that doc, often by taking the remote in (Keep Local
     * merges the remote vclock, Take Remote adopts it). So the same
     * resolver judges it again:
     *   - concurrent: still a conflict, offered with the current local doc.
     *   - keep-local: the local doc already includes the remote (or equals
     *     it). Nothing to do; offering it again would show a conflict the
     *     user just resolved.
     *   - take-remote: the remote is newer than the local doc. Taken
     *     without a modal.
     *   - silent-merge: the same content. Taken without a modal only when
     *     the remote vclock is ahead; otherwise there is nothing to choose.
     *
     * The tombstone a remote hard-deletion produces carries `vclock: {}`
     * and so no causal history: the resolver would always find the local
     * doc ahead of it. It stays a conflict while the local doc is alive,
     * as the pending-conflict drain decides for it.
     *
     * A failure here offers the conflict as stashed (the caller catches).
     */
    private async recheckStashed(
        filePath: string,
        stashed: { localDoc: CouchSyncDoc; remoteDoc: CouchSyncDoc },
    ): Promise<void> {
        const { remoteDoc } = stashed;
        const fileName = filePath.split("/").pop();
        const currentLocal = await this.deps.localDb.get<CouchSyncDoc>(makeFileId(filePath));
        if (!currentLocal || !isFileDoc(currentLocal) || !isFileDoc(remoteDoc)) {
            void this.handleConcurrent(filePath, currentLocal ?? stashed.localDoc, remoteDoc);
            return;
        }

        if (remoteDoc.deleted === true && Object.keys(remoteDoc.vclock ?? {}).length === 0) {
            if (currentLocal.deleted === true) {
                logDebug(`Stashed deletion for ${fileName} already applied — skipping`);
                return;
            }
            void this.handleConcurrent(filePath, currentLocal, remoteDoc);
            return;
        }

        const verdict = await this.resolver.resolveOnPull(currentLocal, remoteDoc);
        switch (verdict) {
            case "concurrent":
                void this.handleConcurrent(filePath, currentLocal, remoteDoc);
                return;
            case "keep-local":
                logDebug(`Stashed concurrent for ${fileName} already included in local — skipping`);
                return;
            case "take-remote":
                logDebug(`Stashed concurrent for ${fileName} newer than local — silent take-remote`);
                await this.takeRemoteSilently(filePath, currentLocal, remoteDoc);
                return;
            case "silent-merge":
                if (compareVC(currentLocal.vclock ?? {}, remoteDoc.vclock ?? {}) === "dominated") {
                    logDebug(`Stashed concurrent for ${fileName} same content, newer clock — silent take-remote`);
                    await this.takeRemoteSilently(filePath, currentLocal, remoteDoc);
                    return;
                }
                logDebug(`Stashed concurrent for ${fileName} same content — skipping`);
                return;
            default: {
                const _exhaustive: never = verdict;
                void _exhaustive;
                return;
            }
        }
    }

    /**
     * Take a remote version the re-check found newer than the local doc,
     * without a modal. When the local doc moved again since it was read,
     * nothing was written and the remote version is judged once more against
     * the doc now there, unless a conflict for the path is queued or open:
     * its resolution re-checks it then.
     */
    private async takeRemoteSilently(
        filePath: string,
        localDoc: FileDoc,
        remoteDoc: FileDoc,
    ): Promise<void> {
        if (await this.applyConflictChoice("take-remote", filePath, localDoc, remoteDoc) !== "superseded") return;
        if (this.inFlightConflicts.has(filePath) || this.queue.has(filePath)) return;
        const again = this.pendingUpdates.get(filePath);
        if (!again) return;
        this.pendingUpdates.delete(filePath);
        await this.recheckStashed(filePath, again);
    }

    /**
     * Apply the user's conflict-modal choice. The take-remote branch
     * has a special-case for **fake tombstones** produced by
     * `pull-writer.handlePulledDeletion` for the remote-deleted vs
     * local-edit shape: those tombstones carry `vclock: {}` because
     * CouchDB's `_changes` doesn't expose deleted-doc bodies, so the
     * pull side cannot reconstruct the deleting device's vclock.
     *
     * **vclock 派生の出所制限.** A fake tombstone is a
     * flag carrier — never a causality source. When we promote one to
     * a real LocalDB tombstone via take-remote, the seed vclock comes
     * from `localDoc.vclock` (the only place this device has observed
     * causal history for `path`), merged with whatever `remoteDoc.vclock`
     * happens to carry (= empty for fake tombstones). The resulting
     * `incrementVC(merged, deviceId)` strictly dominates `localDoc`,
     * so peer devices accept the deletion as a normal update instead
     * of treating the empty-seeded `{deviceId:1}` as a concurrent rev.
     *
     * Either choice is applied only over the local DB doc the dialog
     * showed. When that doc was replaced meanwhile (a pull, or a vault edit
     * pushed to the local DB), nothing is written and the conflict is
     * offered again with the current doc. For take-remote this also keeps
     * the seed above sound: `localDoc` is the doc the tombstone replaces.
     */
    private async applyConflictChoice(
        choice: "keep-local" | "take-remote",
        filePath: string,
        localDoc: FileDoc,
        remoteDoc: FileDoc,
    ): Promise<ApplyOutcome> {
        const { replicator } = this.deps;
        const deviceId = this.deps.getSettings().deviceId;
        const fileName = filePath.split("/").pop();

        if (choice === "take-remote") {
            const isDeletionConflict = remoteDoc.deleted === true;
            let updatedVC: Record<string, number>;
            if (isDeletionConflict) {
                // The fake tombstone's vclock is {} by
                // construction — seed from localDoc so the result
                // strictly dominates both sides and propagates cleanly.
                updatedVC = incrementVC(
                    mergeVC(localDoc.vclock ?? {}, remoteDoc.vclock ?? {}),
                    deviceId,
                );
            } else {
                // Chunks-equal → doc is vclock authority:
                // take-remote adopts remote content verbatim, so chunks
                // will equal the remote head. The remote vclock is the
                // sole authority — adding a self-component would create
                // a clock that the push churn guard skips forever,
                // poisoning future comparisons into false concurrent (a
                // conflict that re-appears every cycle).
                updatedVC = remoteDoc.vclock ?? {};
            }
            const updated: FileDoc = {
                ...stripRev(remoteDoc) as FileDoc,
                vclock: updatedVC,
            };
            await replicator.ensureFileChunks(updated);
            // No overwrite of a vault change: the choice was made between
            // the local DB doc and the remote, not the vault's version. If
            // the vault changed since the last sync, dbToFile keeps it and
            // the reconcile offers it against this doc.
            const taken = await this.deps.vaultSync.takeRemoteDoc(
                filePath, localDoc.vclock ?? {}, updated,
            );
            if (taken !== "written") return this.localVersionMoved(filePath, localDoc, remoteDoc);
            logInfo(`Conflict resolved: take-remote for ${fileName}`);
            return "applied";
        }

        // Keep the local DB doc the dialog showed. VaultSync commits it with
        // the vault's baseline, so the next vault change is judged against
        // the version kept.
        const kept = await this.deps.vaultSync.keepLocalDoc(
            filePath, localDoc.vclock, remoteDoc.vclock,
        );
        if (kept !== "written") return this.localVersionMoved(filePath, localDoc, remoteDoc);
        logInfo(`Conflict resolved: keep-local for ${fileName}`);
        return "applied";
    }

    /**
     * The local version changed while the dialog was open, so the choice
     * wrote nothing. Present the conflict again with the current version,
     * as for a newer remote version that arrives meanwhile; one already
     * waiting is newer than this one.
     */
    private localVersionMoved(filePath: string, localDoc: FileDoc, remoteDoc: FileDoc): ApplyOutcome {
        if (!this.pendingUpdates.has(filePath)) {
            this.pendingUpdates.set(filePath, { localDoc, remoteDoc });
        }
        return "superseded";
    }
}
