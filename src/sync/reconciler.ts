import type { App } from "obsidian";
import type { LocalDB, VaultManifest } from "../db/local-db.ts";
import type { VaultSync, CompareResult } from "./vault-sync.ts";
import type { CouchSyncSettings } from "../settings.ts";
import type { FileDoc } from "../types.ts";

const CLOCK_SKEW_MARGIN_MS = 5000;
const LARGE_DELETE_RATIO = 0.1;

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
 * a vault manifest plus the editedBy field.
 *
 * Triggered on plugin load, sync toggle, network reconnect, init/clone
 * completion, replicator pause, and the manual verify-consistency command.
 *
 * Cost is near-zero on the steady-state hot path: combining the cursor's
 * mtime threshold, manifest path equality, and PouchDB update_seq check
 * lets the fast-path return without ever calling allFileDocs().
 */
export class Reconciler {
    private currentRun: Promise<ReconcileReport> | null = null;

    constructor(
        private app: App,
        private localDb: LocalDB,
        private vaultSync: VaultSync,
        private getSettings: () => CouchSyncSettings,
        private notify: ReconcileNotify = () => {},
    ) {}

    isRunning(): boolean {
        return this.currentRun !== null;
    }

    async reconcile(
        reason: ReconcileReason,
        opts: { mode?: ReconcileMode } = {},
    ): Promise<ReconcileReport> {
        // Coalesce concurrent calls onto the in-flight promise so callers
        // (especially the verify command) get a real result instead of an
        // empty report.
        if (this.currentRun) return this.currentRun;
        this.currentRun = this.runOnce(reason, opts.mode ?? "apply");
        try {
            return await this.currentRun;
        } finally {
            this.currentRun = null;
        }
    }

    private async runOnce(reason: ReconcileReason, mode: ReconcileMode): Promise<ReconcileReport> {
        const startedAt = Date.now();
        const report = emptyReport(reason, mode);

        // Fast path: cheap inputs only (no allFileDocs). If everything looks
        // unchanged we return without ever scanning the DB.
        const vaultFiles = this.app.vault.getFiles();
        const vaultPathSet = new Set(vaultFiles.map((f) => f.path));
        const manifest = await this.localDb.getVaultManifest();
        const manifestPaths = manifest ? new Set(manifest.paths) : null;

        if (mode === "apply") {
            const cursor = await this.localDb.getScanCursor();
            const threshold = (cursor?.lastScanStartedAt ?? 0) - CLOCK_SKEW_MARGIN_MS;
            const hasMtimeChanges = vaultFiles.some((f) => f.stat.mtime > threshold);
            const manifestMatchesVault =
                manifestPaths !== null && setEquals(manifestPaths, vaultPathSet);
            const currentSeq = (await this.localDb.getDb().info()).update_seq;
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
        const vaultByPath = new Map(vaultFiles.map((f) => [f.path, f]));
        const dbDocs = await this.localDb.allFileDocs();
        const dbByPath = new Map(dbDocs.map((d) => [d._id, d]));
        const allPaths = new Set<string>([...vaultByPath.keys(), ...dbByPath.keys()]);
        const deviceId = this.getSettings().deviceId;

        console.log(
            `CouchSync: reconcile (${reason}, ${mode}) — ${vaultByPath.size} vault, ${dbByPath.size} db, manifest=${manifestPaths?.size ?? "null"}`,
        );

        for (const path of allPaths) {
            const file = vaultByPath.get(path);
            const doc = dbByPath.get(path);

            // Case E: vault and DB both empty (or DB tombstone) → no-op
            if (!file && (!doc || doc.deleted)) continue;

            // Case C: vault has it, DB doesn't (or DB tombstone)
            if (file && (!doc || doc.deleted)) {
                if (await this.tryStep(path, "push", () => this.vaultSync.fileToDb(file), mode)) {
                    report.pushed.push(path);
                }
                continue;
            }

            // Case D: vault doesn't have it, DB alive
            if (!file && doc && !doc.deleted) {
                const decision = this.classifyMissingFromVault(doc, deviceId, manifestPaths);
                if (decision === "delete") {
                    if (await this.tryStep(path, "delete", () => this.vaultSync.markDeleted(path), mode)) {
                        report.deleted.push(path);
                    }
                } else {
                    if (await this.tryStep(path, "restore", () => this.vaultSync.dbToFile(doc), mode)) {
                        report.restored.push(path);
                    }
                }
                continue;
            }

            // Case A/B: both vault and DB have an alive entry
            if (file && doc && !doc.deleted) {
                let cmp: CompareResult;
                try {
                    cmp = await this.vaultSync.compareFileToDoc(doc, file);
                } catch (e) {
                    console.error(`CouchSync: reconcile compare failed for ${path}:`, e);
                    continue;
                }
                if (cmp === "identical") {
                    report.inSync++;
                } else if (cmp === "local-newer") {
                    if (await this.tryStep(path, "push", () => this.vaultSync.fileToDb(file), mode)) {
                        report.localWins.push(path);
                    }
                } else {
                    if (await this.tryStep(path, "pull", () => this.vaultSync.dbToFile(doc), mode)) {
                        report.remoteWins.push(path);
                    }
                }
            }
        }

        // Persist the new manifest and cursor (apply mode only).
        if (mode === "apply") {
            const newManifest: VaultManifest = {
                paths: vaultFiles.map((f) => f.path),
                updatedAt: Date.now(),
            };
            await this.localDb.putVaultManifest(newManifest);
            const finalSeq = (await this.localDb.getDb().info()).update_seq;
            await this.localDb.putScanCursor({
                lastScanStartedAt: startedAt,
                lastScanCompletedAt: Date.now(),
                lastSeenUpdateSeq: finalSeq,
            });
        }

        // Safety net: warn on large deletions so a corrupt manifest can't
        // silently wipe a vault.
        if (mode === "apply" && report.deleted.length > vaultFiles.length * LARGE_DELETE_RATIO) {
            const msg = `Large deletion detected: ${report.deleted.length} files removed (>${Math.floor(LARGE_DELETE_RATIO * 100)}% of vault). Verify with consistency check.`;
            console.warn(`CouchSync: ${msg}`);
            this.notify(msg);
        }

        const total = totalDiscrepancies(report);
        if (total > 0) {
            console.log(
                `CouchSync: reconcile (${reason}) — ${total} change(s): ` +
                    `pushed=${report.pushed.length} pulled=${report.remoteWins.length + report.restored.length} ` +
                    `deleted=${report.deleted.length} localWins=${report.localWins.length}`,
            );
            if (mode === "apply") {
                this.notify(`Reconcile: ${total} change(s) applied`);
            }
        }

        return report;
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
        try {
            await op();
            return true;
        } catch (e) {
            console.error(`CouchSync: reconcile ${label} failed for ${path}:`, e);
            return false;
        }
    }

    /**
     * Hybrid rule for "vault doesn't have it × DB alive":
     *
     *   editedBy === self                        → this device deleted it
     *   editedBy !== self & path in manifest     → this device once had it, now removed → deleted
     *   editedBy !== self & path not in manifest → another device created it, never seen here → restore
     *   manifest === null (first run)            → always restore (safe side)
     */
    private classifyMissingFromVault(
        doc: FileDoc,
        deviceId: string,
        manifestPaths: Set<string> | null,
    ): "delete" | "restore" {
        if (manifestPaths === null) return "restore";
        if (doc.editedBy && doc.editedBy === deviceId) return "delete";
        if (manifestPaths.has(doc._id)) return "delete";
        return "restore";
    }
}

function setEquals<T>(a: Set<T>, b: Set<T>): boolean {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
}
