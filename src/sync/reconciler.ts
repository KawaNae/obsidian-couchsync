import type { IVaultIO, VaultFile } from "../types/vault-io.ts";
import type { LocalDB, VaultManifest } from "../db/local-db.ts";
import type { VaultSync } from "./vault-sync.ts";
import type { SyncRelation } from "./classify-sync-relation.ts";
import type { CouchSyncSettings } from "../settings.ts";
import type { FileDoc } from "../types.ts";
import type { ConflictOrchestrator } from "../conflict/conflict-orchestrator.ts";
import { compareVC, latestDevice } from "./vector-clock.ts";
import { filePathFromId } from "../types/doc-id.ts";
import { toPathKey, type PathKey } from "../utils/path.ts";
import { logDebug, logInfo, logWarn, logError } from "../ui/log.ts";
import type { EnsureChunksResult } from "../db/sync-engine.ts";

/**
 * Margin absorbing local filesystem clock jitter when asking "has any vault
 * file been touched since the last scan?". This is *local* drift detection,
 * not cross-device ordering — the latter is handled entirely by Vector
 * Clocks in ConflictResolver.
 */
const CLOCK_SKEW_MARGIN_MS = 5000;
const LARGE_DELETE_RATIO = 0.1;

/**
 * Reasons the user triggered directly — for these, a toast notice makes
 * sense because the user is watching for feedback. Automatic triggers
 * (paused, foreground, reconnect, onload) are silent except when they pick
 * up an unusually large batch.
 */
const MANUAL_REASONS: ReadonlySet<ReconcileReason> = new Set([
    "startSync",
    "manual",
    "manual-repair",
    "setup",
]);

const AUTO_NOTIFY_THRESHOLD = 5;
const AUTO_NOTIFY_DEBOUNCE_MS = 5000;

export type ReconcileReason =
    | "onload"
    | "startSync"
    | "reconnect"
    | "paused"
    | "foreground"
    | "setup"
    | "manual"
    | "manual-repair";

export type ReconcileMode = "apply" | "report";

export type ReconcileNotify = (message: string) => void;

export interface ReconcileReport {
    reason: ReconcileReason;
    mode: ReconcileMode;
    /** Number of files that were already in sync (case A). */
    inSync: number;
    /** Local edits that pushed to DB (case B local-win). */
    localWins: string[];
    /** Remote edits that overwrote local (case B remote-win). */
    remoteWins: string[];
    /** Files newly pushed to DB (case C). */
    pushed: string[];
    /** Files tombstoned because the device deleted them while not watching (case D delete). */
    deleted: string[];
    /** Files restored from DB because another device created them (case D restore). */
    restored: string[];
    /** Files quarantined because their chunks are unavailable on this device
     *  AND the server (broken / missingReferenced). Restore is suppressed
     *  until the chunks arrive — no infinite retry (Invariant II). */
    quarantined: string[];
    /** Whether the run took the fast-path short-circuit (no full scan). */
    shortCircuited: boolean;
}

function emptyReport(reason: ReconcileReason, mode: ReconcileMode): ReconcileReport {
    return {
        reason,
        mode,
        inSync: 0,
        localWins: [],
        remoteWins: [],
        pushed: [],
        deleted: [],
        restored: [],
        quarantined: [],
        shortCircuited: false,
    };
}

export function totalDiscrepancies(report: ReconcileReport): number {
    return (
        report.localWins.length +
        report.remoteWins.length +
        report.pushed.length +
        report.deleted.length +
        report.restored.length
    );
}

/**
 * Single source of truth for vault ↔ local DB consistency.
 *
 * Combines what was previously split between CatchUpScanner (vault → DB) and
 * VaultSync.reconcile (DB → vault), and adds delete detection (case D) using
 * a vault manifest plus the vclock's latest-writer device.
 *
 * Triggered on plugin load, sync toggle, network reconnect, init/clone
 * completion, replicator pause, and the manual verify-consistency command.
 *
 * Cost is near-zero on the steady-state hot path: combining the cursor's
 * mtime threshold, manifest path equality, and local update_seq check
 * lets the fast-path return without ever calling allFileDocs().
 */
export class Reconciler {
    private currentRun: Promise<ReconcileReport> | null = null;
    /** When a reconcile is requested while one is in flight, the reason
     *  is queued here so a fresh run starts after the current one ends. */
    private pendingReason: ReconcileReason | null = null;
    private autoPendingTotal = 0;
    private autoPendingTimer: ReturnType<typeof setTimeout> | null = null;
    /** Latched by `destroy()` on plugin unload. Once set, no new reconcile
     *  starts and in-flight side effects are skipped, so reconcile work never
     *  outlives the localDb it writes through (otherwise an in-flight
     *  vclock-adopt runs after `localDb.close()` → DatabaseClosedError). */
    private disposed = false;

    private conflictOrchestrator: ConflictOrchestrator | null = null;

    constructor(
        private vault: IVaultIO,
        private localDb: LocalDB,
        private vaultSync: VaultSync,
        private getSettings: () => CouchSyncSettings,
        private notify: ReconcileNotify = () => {},
        private ensureChunks: (doc: FileDoc) => Promise<EnsureChunksResult> =
            async () => ({ stillMissing: [], remoteConsulted: false }),
    ) {}

    /**
     * Late-binding setter for `conflictOrchestrator`. Reconciler is
     * constructed before ConflictOrchestrator in main.ts; this setter
     * resolves the dependency cycle. When the orchestrator is null
     * (tests / pre-init), divergent routing falls back to the prior
     * silent dbToFile behavior.
     */
    setConflictOrchestrator(co: ConflictOrchestrator): void {
        this.conflictOrchestrator = co;
    }

    isRunning(): boolean {
        return this.currentRun !== null;
    }

    /** Latch disposal and cancel pending work. Call from plugin unload
     *  BEFORE closing localDb. Callers should `await settle()` afterwards to
     *  let any in-flight run drain before the DB handle is torn down. */
    destroy(): void {
        this.disposed = true;
        if (this.autoPendingTimer) {
            clearTimeout(this.autoPendingTimer);
            this.autoPendingTimer = null;
        }
        this.autoPendingTotal = 0;
        this.pendingReason = null;
    }

    /** Resolve once any in-flight reconcile has finished. Lets `onunload`
     *  drain reconcile work before `localDb.close()`. */
    async settle(): Promise<void> {
        if (this.currentRun) {
            try { await this.currentRun; } catch { /* already logged */ }
        }
    }

    async reconcile(
        reason: ReconcileReason,
        opts: { mode?: ReconcileMode } = {},
    ): Promise<ReconcileReport> {
        // Disposal barrier: never start reconcile work during/after unload.
        // The localDb may already be closing; a write here would race the
        // teardown (DatabaseClosedError).
        if (this.disposed) return emptyReport(reason, opts.mode ?? "apply");
        // If a run is in flight, queue a re-run instead of dropping the
        // request. The old coalesce approach returned the in-flight promise,
        // which meant data written after the run started was never processed.
        if (this.currentRun) {
            this.pendingReason = reason;
            return this.currentRun;
        }
        this.currentRun = this.runOnce(reason, opts.mode ?? "apply");
        try {
            return await this.currentRun;
        } finally {
            this.currentRun = null;
            if (this.pendingReason) {
                const next = this.pendingReason;
                this.pendingReason = null;
                this.reconcile(next).catch((e) =>
                    logError(`CouchSync: queued ${next} reconcile failed: ${e?.message ?? e}`),
                );
            }
        }
    }

    private async runOnce(reason: ReconcileReason, mode: ReconcileMode): Promise<ReconcileReport> {
        const startedAt = Date.now();
        const report = emptyReport(reason, mode);

        // Fast path: cheap inputs only (no allFileDocs). If everything looks
        // unchanged we return without ever scanning the DB.
        //
        // All in-memory comparison structures key by `PathKey` (NFC + lowercase)
        // so case-insensitive filesystems and Unicode-equivalent forms collapse
        // to one entry. The original-case path is preserved inside the value
        // (TFile.path / FileDoc._id) for filesystem I/O and user-facing strings.
        const vaultFiles = this.vault.getFiles();
        const vaultPathSet = new Set<PathKey>(vaultFiles.map((f) => toPathKey(f.path)));
        const manifest = await this.localDb.getVaultManifest();
        const manifestPaths = manifest
            ? new Set<PathKey>(manifest.paths.map(toPathKey))
            : null;

        if (mode === "apply") {
            const cursor = await this.localDb.getScanCursor();
            const threshold = (cursor?.lastScanStartedAt ?? 0) - CLOCK_SKEW_MARGIN_MS;
            const hasMtimeChanges = vaultFiles.some((f) => f.stat.mtime > threshold);
            const manifestMatchesVault =
                manifestPaths !== null && setEquals(manifestPaths, vaultPathSet);
            const currentSeq = (await this.localDb.info()).updateSeq;
            const dbUnchanged = cursor?.lastSeenUpdateSeq !== undefined &&
                cursor.lastSeenUpdateSeq === currentSeq;

            if (cursor && !hasMtimeChanges && manifestMatchesVault && dbUnchanged) {
                await this.localDb.putScanCursor({
                    lastScanStartedAt: startedAt,
                    lastScanCompletedAt: Date.now(),
                    lastSeenUpdateSeq: currentSeq,
                });
                report.shortCircuited = true;
                return report;
            }
        }

        // Slow path: scan the union of vault and DB and process every path.
        // Both maps key by `PathKey` (normalized) so a vault path differing
        // only in case from the DB doc — common on case-insensitive FS —
        // collapses to one entry instead of being mis-classified as both
        // "push" (vault side) and "delete" (DB side).
        // The original-case path lives inside each value (TFile.path or
        // FileDoc._id) and is what we use for FS I/O and reporting.
        const vaultByPath = new Map<PathKey, VaultFile>(
            vaultFiles.map((f) => [toPathKey(f.path), f]),
        );
        const seqBeforeScan = (await this.localDb.info()).updateSeq;
        const dbDocs = await this.localDb.allFileDocs();
        const dbByPath = new Map<PathKey, FileDoc>(
            dbDocs.map((d) => [toPathKey(filePathFromId(d._id)), d]),
        );
        const allPaths = new Set<PathKey>([
            ...vaultByPath.keys(),
            ...dbByPath.keys(),
        ]);
        const deviceId = this.getSettings().deviceId;

        logDebug(
            `reconcile (${reason}, ${mode}) — ${vaultByPath.size} vault, ${dbByPath.size} db, manifest=${manifestPaths?.size ?? "null"}`,
        );

        for (const pathKey of allPaths) {
            const file = vaultByPath.get(pathKey);
            const doc = dbByPath.get(pathKey);

            // Case E: vault and DB both empty (or DB tombstone) → no-op
            if (!file && (!doc || doc.deleted)) continue;

            // Display path: prefer the vault's case (current truth) when both
            // exist; fall back to the DB doc's stored path otherwise.
            const displayPath = file?.path ?? filePathFromId(doc!._id);

            // Case C: vault has it, DB doesn't (or DB tombstone)
            if (file && (!doc || doc.deleted)) {
                if (await this.tryStep(displayPath, "push", () => this.vaultSync.fileToDb(file.path), mode)) {
                    report.pushed.push(displayPath);
                }
                continue;
            }

            // Case D: vault doesn't have it, DB alive
            if (!file && doc && !doc.deleted) {
                // Divergent-delete guard runs before classifyMissingFromVault.
                // Signal: lastSynced exists (= this device integrated the
                // path) AND doc.vclock dominates lastSynced.vclock (= a pull
                // advanced the doc beyond integration baseline). User
                // deleted the file during that window — surface as conflict
                // instead of either auto-deleting (no-op via the guard,
                // then auto-restore on the next cycle) or auto-restoring.
                const lastSynced = this.vaultSync.getLastSynced(displayPath);
                if (lastSynced && this.conflictOrchestrator
                    && compareVC(doc.vclock ?? {}, lastSynced.vclock) === "dominates") {
                    if (await this.tryStep(displayPath, "conflict-delete",
                        () => this.conflictOrchestrator!.handleDivergentLocalDelete(displayPath, doc),
                        mode)) {
                        report.deleted.push(displayPath);
                    }
                    continue;
                }

                const decision = this.classifyMissingFromVault(doc, deviceId, manifestPaths);
                if (decision === "delete") {
                    if (await this.tryStep(displayPath, "delete", () => this.vaultSync.markDeleted(displayPath), mode)) {
                        report.deleted.push(displayPath);
                    }
                } else {
                    const r = await this.applyRemoteToVault(displayPath, doc, "restore", mode);
                    if (r === "applied") report.restored.push(displayPath);
                    else if (r === "quarantined") report.quarantined.push(displayPath);
                }
                continue;
            }

            // Case A/B: both vault and DB have an alive entry.
            // CLASSIFIER: do not duplicate inline — route through
            // classifyFileVsDoc which delegates to classifySyncRelation.
            if (file && doc && !doc.deleted) {
                let relation: SyncRelation;
                try {
                    relation = await this.vaultSync.classifyFileVsDoc(doc, file.path, file.stat.size);
                } catch (e) {
                    logError(`CouchSync: reconcile classify failed for ${displayPath}: ${e?.message ?? e}`);
                    continue;
                }
                switch (relation) {
                    case "identical":
                        report.inSync++;
                        // PR5: align lastSynced to the FileDoc's content
                        // fingerprint. No-op when already aligned; upgrades
                        // legacy entries and recovers from stale-bookkeeping
                        // when invariant 1 has been violated.
                        await this.tryStep(displayPath, "align",
                            async (): Promise<void> => {
                                await this.vaultSync.alignLastSyncedToDoc(file.path, doc);
                            },
                            mode);
                        break;
                    case "vclock-only-drift":
                        // Same content, different causality. Adopt fileDoc.vclock
                        // as the lastSynced baseline (Invariant 3, chunks-equal
                        // vclock authority). Closes audit-2026-05-08 MEDIUM
                        // (false-positive concurrent on initial-sync devices)
                        // and the 2026-05-10 phantom-loop shape
                        // (project_phantom_lastsynced_stamp.md).
                        if (await this.tryStep(displayPath, "vclock-adopt",
                            () => this.vaultSync.adoptDocVclock(file.path, doc), mode)) {
                            report.inSync++;
                        }
                        break;
                    case "local-edit":
                        // CLASSIFIER FIX (PR3): the previous "local-unpushed"
                        // branch had no divergent guard. The classifier now
                        // returns true-divergent when local has drifted from
                        // baseline AND remote dominates, so the local-edit
                        // case here is genuinely a push.
                        if (await this.tryStep(displayPath, "push", () => this.vaultSync.fileToDb(file.path), mode)) {
                            report.localWins.push(displayPath);
                        }
                        break;
                    case "remote-edit":
                    case "legacy-skip": {
                        // legacy-skip: pre-extension lastSynced — fall back to
                        // pull (= old behavior when divergent guard couldn't
                        // run). PR5 startup sweep will upgrade the entries.
                        const r = await this.applyRemoteToVault(displayPath, doc, "pull", mode);
                        if (r === "applied") report.remoteWins.push(displayPath);
                        else if (r === "quarantined") report.quarantined.push(displayPath);
                        break;
                    }
                    case "true-divergent":
                        if (this.conflictOrchestrator) {
                            if (await this.tryStep(displayPath, "conflict-edit",
                                () => this.conflictOrchestrator!.handleDivergentLocalEdit(file.path, doc),
                                mode)) {
                                report.remoteWins.push(displayPath);
                            }
                        } else {
                            // No orchestrator wired (e.g., test harness pre-
                            // ConflictOrchestrator) — fall back to pull. The
                            // divergent local edit is lost in this fallback;
                            // production main.ts always wires the orchestrator.
                            const r = await this.applyRemoteToVault(displayPath, doc, "pull", mode);
                            if (r === "applied") report.remoteWins.push(displayPath);
                            else if (r === "quarantined") report.quarantined.push(displayPath);
                        }
                        break;
                }
            }
        }

        // Persist the new manifest and cursor (apply mode only). Skip when
        // disposed: onunload latches `disposed` then closes localDb right after
        // settle(), so an unguarded write here races teardown
        // (DatabaseClosedError). The per-file writes above already gate on
        // `disposed` (tryStep / applyRemoteToVault); this trailing persist was
        // the lone gap (#err-7). A skipped persist just means a full rescan
        // next session — safe.
        if (mode === "apply" && !this.disposed) {
            const newManifest: VaultManifest = {
                paths: vaultFiles.map((f) => f.path),
                updatedAt: Date.now(),
            };
            await this.localDb.putVaultManifest(newManifest);
            await this.localDb.putScanCursor({
                lastScanStartedAt: startedAt,
                lastScanCompletedAt: Date.now(),
                lastSeenUpdateSeq: seqBeforeScan,
            });
        } else if (mode === "apply") {
            logDebug("reconcile: skipped manifest/cursor persist (shutting down)");
        }

        // Safety net: warn on large deletions so a corrupt manifest can't
        // silently wipe a vault.
        if (mode === "apply" && report.deleted.length > vaultFiles.length * LARGE_DELETE_RATIO) {
            const msg = `Large deletion detected: ${report.deleted.length} files removed (>${Math.floor(LARGE_DELETE_RATIO * 100)}% of vault). Verify with consistency check.`;
            logWarn(`CouchSync: ${msg}`);
            this.notify(msg);
        }

        // Quarantine is not a "change applied" (recordQuarantined notifies
        // once on its own), but surface the count in the console summary so a
        // persistent broken file is observable without log spam.
        if (report.quarantined.length > 0) {
            logInfo(`Reconcile (${reason}): ${report.quarantined.length} quarantined (broken — chunks missing on this device and server)`);
        }

        const total = totalDiscrepancies(report);
        if (total > 0) {
            const parts: string[] = [];
            if (report.remoteWins.length + report.restored.length > 0)
                parts.push(`${report.remoteWins.length + report.restored.length} pulled`);
            if (report.pushed.length + report.localWins.length > 0)
                parts.push(`${report.pushed.length + report.localWins.length} pushed`);
            if (report.deleted.length > 0)
                parts.push(`${report.deleted.length} deleted`);
            logInfo(`Reconcile (${reason}): ${parts.join(", ")}`);
            if (mode === "apply") {
                if (MANUAL_REASONS.has(reason)) {
                    // User-driven: always confirm with a toast.
                    this.notify(`Reconcile: ${total} change(s) applied`);
                } else if (total >= AUTO_NOTIFY_THRESHOLD) {
                    // Automatic trigger with a non-trivial batch: debounce
                    // across adjacent cycles so a burst of edits produces a
                    // single summary notice instead of one per pause.
                    this.scheduleAutoNotify(total);
                }
                // Small automatic batches: console log only, no toast.
            }
        }

        return report;
    }

    private scheduleAutoNotify(total: number): void {
        this.autoPendingTotal += total;
        if (this.autoPendingTimer) clearTimeout(this.autoPendingTimer);
        this.autoPendingTimer = setTimeout(() => {
            if (this.autoPendingTotal > 0) {
                this.notify(`Reconcile: ${this.autoPendingTotal} change(s) applied`);
            }
            this.autoPendingTotal = 0;
            this.autoPendingTimer = null;
        }, AUTO_NOTIFY_DEBOUNCE_MS);
    }

    /**
     * Run an apply-mode side effect with error logging. Returns false on
     * failure so the caller can skip recording the path. In report mode the
     * side effect is not invoked but the path is still counted.
     */
    private async tryStep(
        path: string,
        label: string,
        op: () => Promise<void>,
        mode: ReconcileMode,
    ): Promise<boolean> {
        if (mode !== "apply") return true;
        // Disposal barrier: a long restore/pull batch may still be iterating
        // when unload latches `disposed`. Stop issuing DB writes so they don't
        // race localDb teardown.
        if (this.disposed) return false;
        try {
            await op();
            return true;
        } catch (e) {
            this.logStepError(label, path, e);
            return false;
        }
    }

    /** Log a reconcile step failure, downgrading shutdown-race errors
     *  (disposed) to debug so teardown doesn't spam the log. */
    private logStepError(label: string, path: string, e: unknown): void {
        if (this.disposed) {
            logDebug(`CouchSync: reconcile ${label} skipped for ${path} (shutting down)`);
            return;
        }
        logError(`CouchSync: reconcile ${label} failed for ${path}: ${(e as any)?.message ?? e}`);
    }

    /**
     * Apply a remote FileDoc to the vault (restore/pull) with broken-chunk
     * quarantine (Invariant II). Returns the outcome so the caller records it
     * in the right report bucket.
     *
     *  - "applied": chunks available, file written.
     *  - "quarantined": chunks unavailable on this device AND the server
     *    (broken). Recorded once, restore suppressed — no infinite retry.
     *  - "skipped": transient (offline / shutdown / error) — retried later.
     *
     * Recovery: `ensureChunks` only hits the network when a chunk is actually
     * missing, so a healthy file never probes. A quarantined file re-probes
     * once per reconcile (cheap, quiet — recordQuarantined's isNew guard
     * suppresses repeat notices) and clears the moment its chunks reappear
     * anywhere. No restore ping-pong: a still-broken file never reaches
     * dbToFile, so it can't throw or loop.
     */
    private async applyRemoteToVault(
        displayPath: string,
        doc: FileDoc,
        label: string,
        mode: ReconcileMode,
    ): Promise<"applied" | "quarantined" | "skipped"> {
        if (mode !== "apply") return "applied";
        if (this.disposed) return "skipped";

        let res: EnsureChunksResult;
        try {
            res = await this.ensureChunks(doc);
        } catch (e) {
            this.logStepError(label, displayPath, e);
            return "skipped";
        }
        if (res.stillMissing.length > 0) {
            if (res.remoteConsulted) {
                // Unavailable here AND on the server → broken. Quarantine to
                // end the restore ping-pong; recovers when chunks reappear.
                await this.vaultSync.recordQuarantined(displayPath, res.stillMissing);
                return "quarantined";
            }
            return "skipped"; // offline — transient, retry when online
        }
        // All chunks available — recover from any prior quarantine, then apply.
        if (await this.vaultSync.wasQuarantined(displayPath)) {
            await this.vaultSync.clearQuarantined(displayPath);
        }
        try {
            await this.vaultSync.dbToFile(doc);
            return "applied";
        } catch (e) {
            this.logStepError(label, displayPath, e);
            return "skipped";
        }
    }

    /**
     * Hybrid rule for "vault doesn't have it × DB alive":
     *
     *   last-writer === self                         → this device deleted it
     *   last-writer !== self & path in manifest      → this device once had it, now removed → deleted
     *   last-writer !== self & path not in manifest  → another device created it, never seen here → restore
     *   manifest === null (first run)                → always restore (safe side)
     *
     * "last-writer" is derived from the doc's vclock — the device whose
     * counter is highest is the one that made the most recent write.
     */
    private classifyMissingFromVault(
        doc: FileDoc,
        deviceId: string,
        manifestPaths: Set<PathKey> | null,
    ): "delete" | "restore" {
        if (manifestPaths === null) return "restore";
        const lastWriter = latestDevice(doc.vclock ?? {});
        if (this.isLocalDevice(lastWriter)) return "delete";
        // Manifest paths are case-folded for comparison; do the same for
        // the doc's stored path before lookup.
        if (manifestPaths.has(toPathKey(filePathFromId(doc._id)))) return "delete";
        return "restore";
    }

    /** Check if writerDeviceId matches this device (current or previous IDs). */
    private isLocalDevice(writerDeviceId: string | null): boolean {
        if (!writerDeviceId) return false;
        const s = this.getSettings();
        if (writerDeviceId === s.deviceId) return true;
        return (s.previousDeviceIds ?? []).includes(writerDeviceId);
    }
}

function setEquals<T>(a: Set<T>, b: Set<T>): boolean {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
}
