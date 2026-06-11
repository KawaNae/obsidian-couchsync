import type { IVaultIO, VaultFile } from "../types/vault-io.ts";
import type { LocalDB, VaultManifest } from "../db/local-db.ts";
import { docsSigEquals } from "../db/dexie-store.ts";
import type { VaultSync } from "./vault-sync.ts";
import type { SyncRelation } from "./classify-sync-relation.ts";
import type { CouchSyncSettings } from "../settings.ts";
import type { FileDoc } from "../types.ts";
import type { ConflictOrchestrator } from "../conflict/conflict-orchestrator.ts";
import { compareVC, latestDevice, findDominator } from "./vector-clock.ts";
import { chunkListsEqual } from "./chunk-equality.ts";
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
    /** Canonical paths kept after resolving a PathKey collision (invariant
     *  S4/S5 — two case/NFC variants of one logical file de-duplicated to a
     *  single canonical case). */
    collisionsResolved: string[];
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
        collisionsResolved: [],
        shortCircuited: false,
    };
}

export function totalDiscrepancies(report: ReconcileReport): number {
    return (
        report.localWins.length +
        report.remoteWins.length +
        report.pushed.length +
        report.deleted.length +
        report.restored.length +
        report.collisionsResolved.length
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
 * mtime threshold, manifest path equality, and the docs change signature
 * lets the fast-path return without ever calling allFileDocs(). The
 * signature (see `DocsChangeSignature`) tracks the docs row set only —
 * checkpoint/vclock/manifest bookkeeping, including this reconciler's
 * own cursor writes, cannot invalidate the fast path.
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
            const currentSig = await this.localDb.docsChangeSignature();
            const dbUnchanged = docsSigEquals(cursor?.lastSeenDocsSig, currentSig);
            // Invariant S7: never let the short-circuit hide a collision. Two
            // vault files folding to one PathKey (a case-sensitive FS holding
            // both `scripts/X` and `Scripts/X` — the incident source) must take
            // the slow path so Case F runs. DB-side-only duplicates always
            // arrive via a pull, which writes docs rows and moves the
            // signature → `dbUnchanged` is false, so they already force the
            // slow path.
            const vaultHasDup = vaultPathSet.size !== vaultFiles.length;

            if (cursor && !hasMtimeChanges && manifestMatchesVault && dbUnchanged
                && !vaultHasDup) {
                await this.localDb.putScanCursor({
                    lastScanStartedAt: startedAt,
                    lastScanCompletedAt: Date.now(),
                    lastSeenDocsSig: currentSig,
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
        // Group by PathKey into ARRAYS, not last-wins scalars (invariant S4):
        // the DB id space is case-sensitive, so `scripts/X` and `Scripts/X`
        // are distinct docs that fold to one PathKey. A scalar Map would drop
        // the shadow and hide the collision; the array form makes a >1-occupant
        // PathKey a first-class, detectable state resolved by Case F.
        const vaultByPath = groupByPathKey(vaultFiles, (f) => f.path);
        // Captured BEFORE allFileDocs(): concurrent writes landing during
        // the scan — including this run's own fileToDb/markDeleted commits —
        // stay "unseen", so the next reconcile conservatively re-scans them.
        const sigBeforeScan = await this.localDb.docsChangeSignature();
        const dbDocs = await this.localDb.allFileDocs();
        const dbByPath = groupByPathKey(dbDocs, (d) => filePathFromId(d._id));
        const allPaths = new Set<PathKey>([
            ...vaultByPath.keys(),
            ...dbByPath.keys(),
        ]);
        const deviceId = this.getSettings().deviceId;

        logDebug(
            `reconcile (${reason}, ${mode}) — ${vaultByPath.size} vault, ${dbByPath.size} db, manifest=${manifestPaths?.size ?? "null"}`,
        );

        for (const pathKey of allPaths) {
            const files = vaultByPath.get(pathKey) ?? [];
            const docs = dbByPath.get(pathKey) ?? [];
            const aliveDocs = docs.filter((d) => !d.deleted);

            // Case F (invariant S4/S5): a PathKey with genuine MULTIPLICITY —
            // two case-variant files on disk (case-sensitive FS) or two alive
            // DB docs of different case (the scripts/Scripts incident). This is
            // distinct from benign single-occupant case drift (one vault file
            // whose case differs from its one DB doc), which the normal Case
            // A–E logic already handles via the vault-case `displayPath`. Two
            // alive docs can only share a PathKey by differing in case (same
            // case ⇒ same id ⇒ same doc); likewise two files. Resolve before
            // the per-occupant logic, which assumes a single occupant.
            if (files.length > 1 || aliveDocs.length > 1) {
                await this.resolvePathKeyCollision(files, aliveDocs, mode, report);
                continue;
            }

            const file = files[0];
            // Representative doc: prefer an alive doc; fall back to a tombstone
            // so the Case E / Case C deletion branches still observe it.
            const doc = aliveDocs[0] ?? docs[0];

            // Case E: vault and DB both empty (or DB tombstone) → no-op,
            // plus baseline hygiene: a tombstone whose baseline is still the
            // old alive entry (pre-Invariant-7 pull-applied deletions) is
            // upgraded to the deleted baseline so a later remote recreate
            // classifies as a restore instead of a false conflict.
            if (!file && (!doc || doc.deleted)) {
                if (doc?.deleted) {
                    const ls = this.vaultSync.getLastSynced(filePathFromId(doc._id));
                    if (ls && !ls.deleted) {
                        await this.tryStep(filePathFromId(doc._id), "baseline-align",
                            async (): Promise<void> => {
                                await this.vaultSync.dbToFile(doc);
                            },
                            mode);
                    }
                }
                continue;
            }

            // Display path: prefer the vault's case (current truth) when both
            // exist; fall back to the DB doc's stored path otherwise.
            const displayPath = file?.path ?? filePathFromId(doc!._id);

            // Case C: vault has it, DB doesn't (or DB tombstone)
            if (file && (!doc || doc.deleted)) {
                if (!doc) {
                    // No doc at all — plain new-file push.
                    if (await this.tryStep(displayPath, "push", () => this.vaultSync.fileToDb(file.path), mode)) {
                        report.pushed.push(displayPath);
                    }
                    continue;
                }
                // DB tombstone under a vault file (Invariant 7). The old code
                // blind-forwarded to fileToDb, whose divergent guard skipped
                // every relation except local-edit — the W24 wedged-path shape.
                // Route through the classifier and dispatch each verdict to
                // its real action instead.
                let relation: SyncRelation;
                try {
                    relation = await this.vaultSync.classifyFileVsDoc(doc, file.path, file.stat.size);
                } catch (e) {
                    logError(`CouchSync: reconcile classify (tombstone) failed for ${displayPath}: ${e?.message ?? e}`);
                    continue;
                }
                switch (relation) {
                    case "local-edit":
                        // Deleted baseline matches the tombstone — the file is
                        // a legitimate recreate. fileToDb increments past the
                        // tombstone's vclock (recreate push).
                        if (await this.tryStep(displayPath, "push", () => this.vaultSync.fileToDb(file.path), mode)) {
                            report.pushed.push(displayPath);
                        }
                        break;
                    case "remote-edit":
                        // Alive baseline still matches the disk content — the
                        // deletion simply hasn't been applied to disk yet.
                        // dbToFile's tombstone branch deletes the file and
                        // establishes the deleted baseline; it reads no chunks,
                        // so no ensureChunks / applyRemoteToVault detour.
                        if (await this.tryStep(displayPath, "delete-apply",
                            async (): Promise<void> => { await this.vaultSync.dbToFile(doc); },
                            mode)) {
                            report.deleted.push(displayPath);
                        }
                        break;
                    case "true-divergent":
                        // No baseline explains the file over the tombstone
                        // (the wedged W24 state itself, or a recreate raced by
                        // another device's re-delete). Neither silent restore
                        // (H-1 data-loss shape) nor silent skip (W24 shape) —
                        // the user arbitrates.
                        if (this.conflictOrchestrator) {
                            if (await this.tryStep(displayPath, "conflict-recreate",
                                () => this.conflictOrchestrator!.handleDivergentRecreate(file.path, doc),
                                mode)) {
                                report.pushed.push(displayPath);
                            }
                        } else {
                            logWarn(
                                `CouchSync: divergent recreate on ${displayPath} — no conflict ` +
                                `orchestrator wired; leaving untouched (re-detected next reconcile).`,
                            );
                        }
                        break;
                    default:
                        // identical / vclock-only-drift / legacy-skip cannot be
                        // produced for alive-file × tombstone input (Invariant 7
                        // makes contentEqual false and legacy baselines refine
                        // to true-divergent). Guard for visibility.
                        logError(
                            `CouchSync: unexpected relation '${relation}' for tombstone reconcile of ${displayPath}`,
                        );
                        break;
                }
                continue;
            }

            // Case D: vault doesn't have it, DB alive. The question is "have I
            // ever integrated this path here?" — if yes, the missing file is a
            // local delete to propagate; if no, another device created it and
            // we restore to converge. Decide by FIDELITY-ORDERED oracles:
            //
            //   1. lastSynced (per-path integration baseline, written ONLY on a
            //      successful push/pull apply — vault-sync.ts:271/404) is the
            //      authoritative "I integrated this content" record.
            //   2. The vault manifest is a coarse fallback: it is written ONLY
            //      by reconcile (line ~447), so a freshly pulled-but-not-yet-
            //      reconciled path is invisible to it. Using it as the primary
            //      oracle resurrected user deletions in that window (the H-1
            //      bug). Demoted to legacy / first-run / no-lastSynced fallback.
            if (!file && doc && !doc.deleted) {
                const lastSynced = this.vaultSync.getLastSynced(displayPath);
                if (lastSynced?.deleted) {
                    // Deleted baseline (Invariant 7): we integrated a deletion
                    // of this path, and the alive doc tells us what happened
                    // next on the causal axis.
                    const rel = compareVC(doc.vclock ?? {}, lastSynced.vclock);
                    if (rel === "dominates") {
                        // Another device legitimately recreated the path after
                        // the deletion we integrated — restore it. Before the
                        // deleted baseline existed, the stale alive baseline
                        // made this a false divergent-local-delete conflict.
                        const r = await this.applyRemoteToVault(displayPath, doc, "restore", mode);
                        if (r === "applied") report.restored.push(displayPath);
                        else if (r === "quarantined") report.quarantined.push(displayPath);
                    } else if (rel === "concurrent") {
                        // Recreate raced our deletion — deletion vs recreate
                        // conflict, same modal as divergent-local-delete.
                        if (this.conflictOrchestrator) {
                            if (await this.tryStep(displayPath, "conflict-delete",
                                () => this.conflictOrchestrator!.handleDivergentLocalDelete(displayPath, doc),
                                mode)) {
                                report.deleted.push(displayPath);
                            }
                        } else {
                            const r = await this.applyRemoteToVault(displayPath, doc, "restore", mode);
                            if (r === "applied") report.restored.push(displayPath);
                            else if (r === "quarantined") report.quarantined.push(displayPath);
                        }
                    } else {
                        // equal/dominated: an alive doc at-or-below the
                        // integrated tombstone is stale bookkeeping (the
                        // tombstone replaced it) — re-propagate the deletion.
                        if (await this.tryStep(displayPath, "delete",
                            () => this.vaultSync.markDeleted(displayPath), mode)) {
                            report.deleted.push(displayPath);
                        }
                    }
                    continue;
                }
                if (lastSynced) {
                    const rel = compareVC(doc.vclock ?? {}, lastSynced.vclock);
                    if (rel === "dominates") {
                        // A pull advanced the doc beyond our integration
                        // baseline while the file was locally gone: divergent
                        // local-delete vs remote-edit → conflict (production
                        // always wires the orchestrator; without it, fall back
                        // to remote-wins restore, matching the Case A/B path).
                        if (this.conflictOrchestrator) {
                            if (await this.tryStep(displayPath, "conflict-delete",
                                () => this.conflictOrchestrator!.handleDivergentLocalDelete(displayPath, doc),
                                mode)) {
                                report.deleted.push(displayPath);
                            }
                        } else {
                            const r = await this.applyRemoteToVault(displayPath, doc, "restore", mode);
                            if (r === "applied") report.restored.push(displayPath);
                            else if (r === "quarantined") report.quarantined.push(displayPath);
                        }
                    } else {
                        // equal/dominated: we integrated this content and the
                        // doc has NOT advanced past our baseline → the missing
                        // file is a genuine local delete. Propagate the
                        // tombstone (H-1 fix: previously the manifest-blind
                        // classifier restored it on a dropped delete event).
                        if (await this.tryStep(displayPath, "delete",
                            () => this.vaultSync.markDeleted(displayPath), mode)) {
                            report.deleted.push(displayPath);
                        }
                    }
                    continue;
                }

                // No integration baseline here → fall back to the manifest.
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
                lastSeenDocsSig: sigBeforeScan,
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
     * Case F — resolve a PathKey collision (invariant S4/S5): two case/NFC
     * variants of one logical file. Converge using the SAME lens as content
     * conflicts — chunks decide reality, vclock decides causality (symmetric
     * with Invariant 3) — never an ad-hoc disk-preference rule.
     *
     *  - Auto-converge ONLY when every variant is content-equal (same chunk
     *    list) AND no colliding on-disk file has unpushed edits. The canonical
     *    is the causal dominator (or a deterministic tiebreak for truly
     *    concurrent variants, so all devices pick the same case); non-canonical
     *    docs are tombstoned and non-canonical on-disk files removed; the
     *    canonical is restored if absent locally.
     *  - Otherwise the variants are genuinely different files sharing a name:
     *    Phase 1 leaves them untouched and logs (Phase 2 routes to the conflict
     *    orchestrator). No destructive action without proven content equality.
     *
     * The disk-delete is FS-correct without special-casing: `files` carries
     * each file's REAL case (from `getFiles()`), so on a case-insensitive FS a
     * non-canonical raw is simply not an on-disk file (`hasFile` false) and the
     * single shared physical file — which is the canonical — is never touched.
     */
    private async resolvePathKeyCollision(
        files: VaultFile[],
        aliveDocs: FileDoc[],
        mode: ReconcileMode,
        report: ReconcileReport,
    ): Promise<void> {
        const rawOf = (d: FileDoc): string => filePathFromId(d._id);
        const variants = [...new Set<string>([
            ...files.map((f) => f.path),
            ...aliveDocs.map(rawOf),
        ])];

        // Content-equality gate. Equality is provable only from doc chunk
        // lists, so every on-disk file must be backed by an alive doc and all
        // docs must share one chunk list.
        const docByRaw = new Map(aliveDocs.map((d) => [rawOf(d), d] as const));
        const everyFileBacked = files.every((f) => docByRaw.has(f.path));
        const ref = aliveDocs[0]?.chunks;
        const contentEqual = ref !== undefined && everyFileBacked
            && aliveDocs.every((d) => chunkListsEqual(d.chunks, ref));

        // Refuse to auto-resolve if any colliding file has unpushed edits — the
        // doc chunks would not reflect that edit, so a disk delete could lose
        // it (Invariant 4 oracle).
        let anyPending = false;
        if (contentEqual) {
            for (const f of files) {
                if (await this.vaultSync.hasUnpushedChanges(f.path)) {
                    anyPending = true;
                    break;
                }
            }
        }

        if (!contentEqual || anyPending) {
            logWarn(
                `reconcile: PathKey collision among [${variants.join(", ")}] not ` +
                    `auto-resolved (${!contentEqual ? "content differs / unbacked file" : "pending local edit"}) ` +
                    `— left for conflict resolution`,
            );
            return;
        }

        // Canonical = causal dominator, else the lexicographically smallest
        // raw path. For genuinely concurrent variants there is no "latest"
        // writer, and the content is provably equal here, so WHICH case wins
        // is immaterial — only that every device picks the SAME one. The raw
        // path (doc id) is the one key that is byte-identical on every device;
        // a vclock-derived tiebreak (latestDevice) was not, because mergeVC can
        // persist the same logical clock with different key order, so two
        // devices could pick different canonicals and tombstone each other.
        const canonicalDoc = findDominator(aliveDocs)
            ?? [...aliveDocs].sort((a, b) => (rawOf(a) < rawOf(b) ? -1 : 1))[0];
        const canonicalRaw = rawOf(canonicalDoc);

        for (const raw of variants) {
            if (raw === canonicalRaw) continue;
            const hasFile = files.some((f) => f.path === raw);
            if (hasFile) {
                // Disk + DB: applyRemoteDeletion removes the exact-case physical
                // file and tombstones the doc.
                await this.tryStep(raw, "collision-dedup",
                    () => this.vaultSync.applyRemoteDeletion(raw), mode);
            } else if (docByRaw.has(raw)) {
                // DB-only variant (no exact-case file here — incl. every
                // non-canonical variant on a case-insensitive FS): tombstone
                // only. Its tombstone is case-safe on pull (see dbToFile).
                await this.tryStep(raw, "collision-dedup",
                    () => this.vaultSync.markDeleted(raw), mode);
            }
        }

        // Ensure the canonical exists on disk (it may have been DB-only, or we
        // just removed the non-canonical physical file on a device lacking the
        // canonical case).
        if (!files.some((f) => f.path === canonicalRaw)) {
            await this.applyRemoteToVault(canonicalRaw, canonicalDoc, "collision-restore", mode);
        }

        logInfo(
            `Reconcile: resolved PathKey collision → kept ${canonicalRaw}, ` +
                `dropped ${variants.filter((r) => r !== canonicalRaw).join(", ")}`,
        );
        report.collisionsResolved.push(canonicalRaw);
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

/**
 * Group items by their PathKey (NFC + lowercase) into arrays. Unlike a
 * last-wins scalar Map, this preserves every original-case occupant of a
 * folded key so a collision (invariant S4) is detectable rather than
 * silently dropped.
 */
function groupByPathKey<T>(
    items: readonly T[],
    rawPath: (item: T) => string,
): Map<PathKey, T[]> {
    const map = new Map<PathKey, T[]>();
    for (const item of items) {
        const key = toPathKey(rawPath(item));
        const bucket = map.get(key);
        if (bucket) bucket.push(item);
        else map.set(key, [item]);
    }
    return map;
}
