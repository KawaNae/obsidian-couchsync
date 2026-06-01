import type { IVaultIO } from "../types/vault-io.ts";
import type { LocalDB } from "../db/local-db.ts";
import type { FileDoc, ChunkDoc, CouchSyncDoc } from "../types.ts";
import { FILE_SCHEMA_VERSION } from "../types.ts";
import type { CouchSyncSettings } from "../settings.ts";
import type { VaultWriter, WriteResult } from "./vault-writer.ts";
import { splitIntoChunks, joinChunks, type ChunkHasher } from "../db/chunker.ts";
import { notify } from "../ui/log.ts";
import { compareVC, incrementVC, mergeVC } from "./vector-clock.ts";
import type { VectorClock } from "./vector-clock.ts";
import type { LastSynced } from "./last-synced.ts";
import { classifySyncRelation, type SyncRelation } from "./classify-sync-relation.ts";
import { chunkListsEqual } from "./chunk-equality.ts";
import { makeFileId, filePathFromId } from "../types/doc-id.ts";
import { toPathKey, parentDir, type PathKey } from "../utils/path.ts";
import { logDebug, logWarn } from "../ui/log.ts";
import { DbError } from "../db/write-transaction.ts";

/**
 * Subset of ChangeTracker that EditorAwareVaultWriter needs.
 *
 * `ignoreNextModify` suppresses the modify event that follows a sync-driven
 * `writeBinary` (PR1 disk-write invariant). The `chunksEqual` short-circuit
 * in `fileToDb` is still data-level idempotent, but suppressing here saves
 * the debounce timer and avoids history double-capture through the modify
 * → fileToDb → captureLocal path.
 */
export interface IWriteIgnore {
    /** Mark the next `delete` event on `path` as sync-driven. */
    ignoreDelete(path: string): void;
    /** Mark the next `modify` event on `path` as sync-driven (echo from a
     *  pull-side writeBinary). Consumed by the modify handler before any
     *  scheduling work runs. */
    ignoreNextModify(path: string): void;
}

/**
 * Read-only probe for "is a fileToDb pass pending for this path?" — the
 * pending-edit oracle (invariant 4).
 *
 * **Invariant 4** (Pending-edit oracle): "Has the vault been edited but
 * not yet pushed?" must be answered through this primitive plus a
 * chunks-vs-`lastSynced.chunks` comparison, never through vclock-only
 * lookups (which are kept in lockstep by `fileToDb`/`dbToFile` and so
 * always say "no" — the bug shape this primitive closes). The single
 * call site is `VaultSync.hasUnpushedChanges`.
 *
 * Implemented by `ChangeTracker`. Wired via late-binding setter from
 * `main.ts` to break the construction-time cycle (`ChangeTracker` itself
 * depends on `VaultSync`).
 *
 * Returns `true` iff the path has a debounced or min-interval-deferred
 * `fileToDb` scheduled. Modify/delete echo suppressors do **not** count
 * — those are sync-driven, not user-driven.
 */
export interface IPendingProbe {
    hasPending(path: string): boolean;
}

/** Max snapshot→commit retries inside runWrite when a concurrent pull lands
 *  between our read and our CAS check. Realistic worst case is 1. */
const CAS_MAX_ATTEMPTS = 4;

export class VaultSync {
    /**
     * vault path → integration point at the last successful sync write.
     *
     * Each entry records `{vclock, chunks, size}` — the causality and
     * the content snapshot at the moment the path was integrated. The
     * pair lets the reconciler distinguish "vault is pure stale" from
     * "user edited the stale state" (= divergent edit), and route the
     * latter to the conflict orchestrator instead of overwriting.
     *
     * **Read cache only** — every mutation is the in-memory mirror of an
     * already-committed `runWrite({ vclocks })` so the persisted state and
     * the cache stay in lock-step. There is no flush window: a crash after
     * any successful write loses no information.
     *
     * Loaded once via `loadLastSyncedVclocks()` at plugin init; the on-disk
     * representation is per-path meta entries (`_local/vclock/<path>`).
     * Entries written before the chunks/size extension carry only the
     * vclock (`chunks`/`size` undefined); they are treated as "legacy
     * skip" by the divergent-edit guard until the next push/pull
     * rewrites them in full shape.
     */
    private lastSynced = new Map<PathKey, LastSynced>();

    /**
     * In-memory mirror of `_local/skipped-files` paths. Lets the hot path
     * skip a DB read on every successful file sync.
     */
    private skippedPaths: Set<PathKey> | null = null;

    /**
     * In-memory mirror of `_local/quarantined-files` paths (Invariant II).
     * Lets reconcile skip a restore attempt for a broken FileDoc without a
     * DB read on every cycle.
     */
    private quarantinedPaths: Set<PathKey> | null = null;

    private syncFilterCache: { pattern: string; re: RegExp } | null = null;
    private syncIgnoreCache: { pattern: string; re: RegExp } | null = null;

    /**
     * Late-bound probe for "is the user editing this path right now"
     * (invariant 4). Construction-cycle-broken via `setPendingProbe`
     * because `ChangeTracker` itself depends on `VaultSync`. Null until
     * `main.ts` wires it up post-construction.
     */
    private pendingProbe: IPendingProbe | null = null;

    private readonly hasher?: ChunkHasher;

    constructor(
        private vault: IVaultIO,
        private db: LocalDB,
        private getSettings: () => CouchSyncSettings,
        private vaultWriter: VaultWriter,
        hasher?: ChunkHasher,
    ) {
        this.hasher = hasher;
    }

    /**
     * Wire the pending-edit probe (invariant 4). Called from `main.ts`
     * after both `VaultSync` and `ChangeTracker` are constructed.
     * Tests / harness code that don't need the probe leave it null;
     * `hasUnpushedChanges` then falls back to chunks-only comparison
     * (which still catches the most common silent-loss shape — the
     * probe is the second layer for the in-flight debounce window).
     */
    setPendingProbe(probe: IPendingProbe): void {
        this.pendingProbe = probe;
    }

    /**
     * Load persisted lastSyncedVclock entries. Called once during plugin
     * init, before reconciliation starts. Performs a transparent migration
     * from the legacy single-doc layout if present.
     */
    async loadLastSyncedVclocks(): Promise<void> {
        const stored = await this.db.loadAllSyncedVclocks();
        this.lastSynced.clear();
        for (const [path, entry] of stored) {
            this.lastSynced.set(path, entry);
        }
    }

    /** Public read accessor for divergent-edit detection in Reconciler. */
    getLastSynced(path: string): LastSynced | undefined {
        return this.lastSynced.get(toPathKey(path));
    }

    /** Compute the chunk-id list for a vault file (content fingerprint).
     *  Used by Reconciler to compare against `lastSynced.chunks`. */
    async computeVaultChunks(path: string): Promise<string[]> {
        return this.localChunkIds(path);
    }

    /** Cancel anything still in flight at unload. No flush needed — every
     *  vclock update is already on disk. */
    async teardown(): Promise<void> {
        // intentionally empty: state is never buffered
    }

    async fileToDb(path: string): Promise<void> {
        const settings = this.getSettings();
        const fileStat = await this.vault.stat(path);
        if (!fileStat) return; // file disappeared before we could read it

        const sizeMB = fileStat.size / (1024 * 1024);
        if (sizeMB > settings.maxFileSizeMB) {
            await this.recordSkipped(path, sizeMB, settings.maxFileSizeMB);
            return;
        }
        if (!this.shouldSync(path)) return;

        if (await this.wasSkipped(path)) {
            await this.forgetSkipped(path);
        }

        const content = await this.vault.readBinary(path);
        const chunks = await splitIntoChunks(content, this.hasher);
        const chunkIds = chunks.map((c) => c._id);

        const deviceId = settings.deviceId;
        const fileId = makeFileId(path);

        // Builder-form runWrite: the snapshot read + CAS retry is handled
        // inside the store. This function only decides WHAT to write based
        // on the current doc state.
        try {
            await this.db.runWriteBuilder(
                async (snap) => {
                    const existing = (await snap.get(fileId)) as FileDoc | null;
                    if (existing && VaultSync.chunksEqual(existing.chunks, chunkIds)) {
                        return null; // already on disk
                    }
                    // CLASSIFIER: do not duplicate inline. The push-side
                    // divergent guard delegates to `classifySyncRelation`
                    // so the rev 197 phantom-write check, the pending-
                    // pull-integration check, and the user-edited-stale
                    // check all share one matrix. Skip when the local
                    // disk lags the LocalDB doc (= remote-edit pending
                    // integration) or both sides have drifted
                    // (= true-divergent). Push only when the classifier
                    // confirms `local-edit`.
                    if (existing) {
                        const existingVC = existing.vclock ?? {};
                        const lastSynced = this.lastSynced.get(toPathKey(path));
                        const relation = classifySyncRelation({
                            leftVC: lastSynced?.vclock ?? {},
                            leftChunks: chunkIds,
                            leftSize: fileStat.size,
                            rightVC: existingVC,
                            rightChunks: existing.chunks,
                            rightSize: existing.size,
                            lastSynced,
                        });
                        if (relation === "remote-edit" || relation === "true-divergent") {
                            logWarn(
                                `fileToDb: skipping push for ${path} — ${relation} ` +
                                `(observed=${JSON.stringify(existingVC)} ` +
                                `integrated=${lastSynced ? JSON.stringify(lastSynced.vclock) : "null"})`,
                            );
                            return null;
                        }
                        if (relation === "legacy-skip") {
                            // Pre-extension lastSynced — fall back to the
                            // legacy vclock-only check until PR5 sweep
                            // upgrades the entry to the {chunks,size}
                            // shape.
                            const isDivergent = lastSynced
                                ? compareVC(existingVC, lastSynced.vclock) === "dominates"
                                : Object.keys(existingVC).length > 0;
                            if (isDivergent) {
                                logWarn(
                                    `fileToDb: skipping push for ${path} — legacy-skip divergent ` +
                                    `(observed=${JSON.stringify(existingVC)})`,
                                );
                                return null;
                            }
                        }
                        // identical / local-edit / vclock-only-drift fall
                        // through to push. (vclock-only-drift requires
                        // chunks equal, which the chunksEqual short-circuit
                        // above already handled — defensive only.)
                    }
                    const newVclock = incrementVC(existing?.vclock, deviceId);
                    const newDoc: FileDoc = {
                        _id: fileId,
                        schemaVersion: FILE_SCHEMA_VERSION,
                        type: "file",
                        chunks: chunkIds,
                        mtime: fileStat.mtime,
                        ctime: fileStat.ctime,
                        size: fileStat.size,
                        vclock: newVclock,
                    };
                    return {
                        chunks: chunks as unknown as CouchSyncDoc[],
                        docs: [{
                            doc: newDoc as unknown as CouchSyncDoc,
                            expectedVclock: existing?.vclock ?? {},
                        }],
                        vclocks: [{
                            path, op: "set", clock: newVclock,
                            chunks: chunkIds, size: fileStat.size,
                        }],
                        onCommit: () => {
                            this.lastSynced.set(toPathKey(path), {
                                vclock: newVclock,
                                chunks: chunkIds,
                                size: fileStat.size,
                            });
                        },
                    };
                },
                { maxAttempts: CAS_MAX_ATTEMPTS },
            );
        } catch (e) {
            this.surfaceWriteError(e, `fileToDb ${path}`);
            throw e;
        }
    }

    async dbToFile(fileDoc: FileDoc): Promise<WriteResult> {
        const vaultPath = filePathFromId(fileDoc._id);

        // Deletion tombstones pass through the filter — deletions are always applied.
        if (!fileDoc.deleted && !this.shouldSync(vaultPath)) {
            logDebug(`dbToFile: skipped filtered path ${vaultPath}`);
            return { applied: false, reason: "filtered" };
        }

        if (fileDoc.deleted) {
            // Case-safe deletion (invariant S3/S5): only remove the physical
            // file when an EXACT-case match exists in the vault. If the sole
            // same-PathKey file on disk is under a DIFFERENT case, it is a
            // distinct logical occupant — the surviving canonical of a resolved
            // collision — and must NOT be deleted. On a case-insensitive FS the
            // two cases share ONE physical file, so deleting "scripts/X" would
            // nuke the canonical "Scripts/X"; `getFiles()` reports the real
            // on-disk case, making this decision correct on every FS. The
            // tombstone is still integrated (bookkeeping advances).
            const exactOnDisk = this.vault.getFiles().some((f) => f.path === vaultPath);
            if (!exactOnDisk) {
                const sibling = this.findExistingByPathKey(vaultPath);
                if (sibling) {
                    logWarn(
                        `dbToFile: skipping disk delete of ${vaultPath} — different-case ` +
                            `sibling ${sibling} present (case-dedup tombstone)`,
                    );
                    return { applied: true };
                }
            }
            await this.vaultWriter.applyRemoteDeletion(vaultPath);
            await this.pruneEmptyParents(vaultPath);
            return { applied: true };
        }

        const existingStat = await this.vault.stat(vaultPath);

        if (existingStat && existingStat.size === fileDoc.size) {
            const ids = await this.localChunkIds(vaultPath);
            if (VaultSync.chunksEqual(ids, fileDoc.chunks)) {
                return { applied: true }; // identical content
            }
        }

        const chunks = await this.db.getChunks(fileDoc.chunks);
        // Availability (Invariant I): a chunk counts as present only when its
        // doc exists AND carries a real content buffer. A content-less doc is
        // unavailable — fold it into the same "Missing chunk(s)" path as an
        // absent doc, so the caller (reconciler) gets one clean, routable
        // error instead of an opaque joinChunks TypeError.
        const usable = new Map(
            chunks
                .filter((c) => c.content instanceof Uint8Array)
                .map((c) => [c._id, c]),
        );
        const orderedChunks = fileDoc.chunks
            .map((id) => usable.get(id))
            .filter((c): c is ChunkDoc => c != null);

        if (orderedChunks.length !== fileDoc.chunks.length) {
            const missing = fileDoc.chunks.filter((id) => !usable.has(id));
            throw new Error(
                `Missing ${missing.length} chunk(s) for ${vaultPath}: ${missing.join(", ")}`,
            );
        }

        const content = joinChunks(orderedChunks);

        // Delegate the vault write to the editor-aware VaultWriter.
        // For new files we use createFile (no editor session can exist
        // yet); for existing files applyRemoteContent picks the right
        // strategy (CM dispatch, defer-on-composing, or fallback).
        let result: WriteResult;
        if (existingStat) {
            result = await this.vaultWriter.applyRemoteContent(vaultPath, content);
        } else {
            const collidingPath = this.findExistingByPathKey(vaultPath);
            if (collidingPath) {
                // A same-PathKey file already exists under a different case
                // (the case-collision class behind the scripts/Scripts
                // incident). Do NOT createFile — on a case-insensitive FS it
                // throws "File already exists"; on a case-sensitive FS it
                // would mint a second physical file. Defer to reconcile Case F
                // (invariant S2/S5), the single authority that picks the
                // canonical case and tombstones the rest.
                logWarn(
                    `dbToFile: path-key collision for ${vaultPath} ` +
                        `(on-disk variant ${collidingPath}) — deferring to reconcile`,
                );
                return { applied: false, reason: "path-key-collision" };
            }
            await this.ensureParentDir(vaultPath);
            await this.vaultWriter.createFile(vaultPath, content);
            result = { applied: true };
        }

        if (result.applied === false) {
            // VaultWriter declined to apply (e.g., the local doc diverged
            // during IME composition). Leave lastSyncedVclock untouched so
            // the divergent state is detectable: the LocalDB doc has been
            // advanced to fileDoc.vclock by PullWriter, but vault content
            // is stale. fileToDb's divergent guard refuses any push from
            // this state; the pull-skipped → reconcile schedule path
            // re-attempts dbToFile on the next cycle.
            return result;
        }

        const clock = { ...(fileDoc.vclock ?? {}) };
        // Persist the integration point in the docs store's meta so it
        // lives in the same IDB as the FileDoc itself. Pure meta write —
        // no CAS needed, so pass a fixed tx rather than a builder.
        await this.db.runWriteTx({
            vclocks: [{
                path: vaultPath, op: "set", clock,
                chunks: fileDoc.chunks, size: fileDoc.size,
            }],
        });
        this.lastSynced.set(toPathKey(vaultPath), {
            vclock: clock,
            chunks: fileDoc.chunks,
            size: fileDoc.size,
        });

        // History capture is now owned by VaultWriter (it knows when
        // the content has actually landed in the editor/disk).
        return { applied: true };
    }

    /**
     * Classify the sync relation between a vault file and its DB record.
     *
     * **CLASSIFIER:** routes through `classifySyncRelation` (the single
     * source of truth). Do not duplicate the chunks/vclock matrix logic
     * here — extend the classifier instead.
     *
     * Step 1 — read disk chunks/size.
     * Step 2 — call `classifySyncRelation` with vault as left (using
     *          `lastSynced.vclock` as the disk's attributed vclock) and
     *          FileDoc as right.
     */
    async classifyFileVsDoc(fileDoc: FileDoc, filePath: string, fileSize: number): Promise<SyncRelation> {
        const lastSynced = this.lastSynced.get(toPathKey(filePathFromId(fileDoc._id)));
        const diskChunks = await this.localChunkIds(filePath);
        return classifySyncRelation({
            leftVC: lastSynced?.vclock ?? {},
            leftChunks: diskChunks,
            leftSize: fileSize,
            rightVC: fileDoc.vclock ?? {},
            rightChunks: fileDoc.chunks,
            rightSize: fileDoc.size,
            lastSynced,
        });
    }

    /**
     * Adopt the FileDoc's vclock as `lastSynced.vclock` when the classifier
     * returned `vclock-only-drift` (= chunks already match the FileDoc but
     * vclocks differ). Pure meta write — no chunk/file write needed because
     * content is already aligned.
     *
     * Invariant 3 (chunks-equal vclock authority): chunks match means the
     * FileDoc is the canonical authority for this path's vclock identity.
     * Any extra stamps on the prior `lastSynced.vclock` are either phantom
     * orphans (stamps never on remote — see project_phantom_lastsynced_stamp.md,
     * 2026-05-10) or echoes of rev-tree conflict branches that already live
     * on remote — neither needs preservation in the local integration baseline.
     *
     * Asymmetry note: `pull-writer` and `config-pull-writer` write merged
     * vclocks back to doc.vclock (replicated to remote, so the next reconcile
     * naturally sees identity). Reconciler vault-scan keeps the FileDoc
     * untouched to avoid rev-tree inflation across the ~hundreds of paths
     * a steady vault holds, so adopting fileDoc.vclock on the lastSynced
     * side is the only convergence path. A merge-based resolver here
     * produces a `lastSynced > fileDoc` state that re-triggers
     * `vclock-only-drift` forever (the phantom-loop bug shape).
     */
    async adoptDocVclock(path: string, fileDoc: FileDoc): Promise<void> {
        const key = toPathKey(path);
        const before = this.lastSynced.get(key)?.vclock ?? {};
        const docVC = fileDoc.vclock ?? {};
        await this.db.runWriteTx({
            vclocks: [{
                path, op: "set", clock: docVC,
                chunks: fileDoc.chunks, size: fileDoc.size,
            }],
        });
        this.lastSynced.set(key, {
            vclock: docVC,
            chunks: fileDoc.chunks,
            size: fileDoc.size,
        });
        logDebug(`adoptDocVclock: ${path} ${JSON.stringify(before)} → ${JSON.stringify(docVC)}`);
    }

    /**
     * PR5 — align `lastSynced.{chunks,size}` to the FileDoc's actual content
     * fingerprint when the reconciler observes them as identical.
     *
     * Two scenarios this handles:
     *
     *   - **Legacy upgrade**: pre-`{chunks,size}` entries (`chunks: undefined`)
     *     are written by older versions of the plugin. PR5's startup sweep
     *     piggybacks on the first reconcile to upgrade them in-place by
     *     reading fileDoc.chunks/size. After one full session every entry
     *     is in the new shape.
     *
     *   - **Stale-bookkeeping recovery**: defensive — if PR1's disk-write
     *     invariant ever breaks (crash window, external tool), `lastSynced`
     *     can drift from disk. When classifier returns `identical`, we know
     *     disk chunks == fileDoc.chunks; if lastSynced disagrees, align it.
     *
     * Returns the action taken so callers / tests can observe.
     */
    async alignLastSyncedToDoc(
        path: string,
        fileDoc: FileDoc,
    ): Promise<"already-aligned" | "upgraded-legacy" | "recovered-stale"> {
        const key = toPathKey(path);
        const existing = this.lastSynced.get(key);
        const docVC = fileDoc.vclock ?? {};

        if (!existing) {
            // No baseline at all — establish one from the FileDoc.
            await this.db.runWriteTx({
                vclocks: [{
                    path, op: "set", clock: docVC,
                    chunks: fileDoc.chunks, size: fileDoc.size,
                }],
            });
            this.lastSynced.set(key, {
                vclock: docVC,
                chunks: fileDoc.chunks,
                size: fileDoc.size,
            });
            return "upgraded-legacy";
        }

        const isLegacy =
            existing.chunks === undefined || existing.size === undefined;
        if (isLegacy) {
            const upgraded: LastSynced = {
                vclock: existing.vclock,
                chunks: fileDoc.chunks,
                size: fileDoc.size,
            };
            await this.db.runWriteTx({
                vclocks: [{
                    path, op: "set", clock: upgraded.vclock,
                    chunks: fileDoc.chunks, size: fileDoc.size,
                }],
            });
            this.lastSynced.set(key, upgraded);
            logDebug(
                `alignLastSyncedToDoc: ${path} legacy entry upgraded to ${fileDoc.chunks.length} chunks / ${fileDoc.size} bytes`,
            );
            return "upgraded-legacy";
        }

        const aligned =
            existing.size === fileDoc.size &&
            chunkListsEqual(existing.chunks!, fileDoc.chunks);
        if (aligned) return "already-aligned";

        // Stale-bookkeeping: lastSynced drifted from the integrated content.
        // The classifier has just confirmed disk == fileDoc, so it's safe
        // to overwrite the bookkeeping with the doc's fingerprint.
        const realigned: LastSynced = {
            vclock: existing.vclock,
            chunks: fileDoc.chunks,
            size: fileDoc.size,
        };
        await this.db.runWriteTx({
            vclocks: [{
                path, op: "set", clock: realigned.vclock,
                chunks: fileDoc.chunks, size: fileDoc.size,
            }],
        });
        this.lastSynced.set(key, realigned);
        logWarn(
            `alignLastSyncedToDoc: ${path} stale-bookkeeping recovered ` +
            `(was ${existing.size} bytes / ${existing.chunks!.length} chunks → ` +
            `now ${fileDoc.size} bytes / ${fileDoc.chunks.length} chunks)`,
        );
        return "recovered-stale";
    }

    async markDeleted(path: string): Promise<void> {
        const fileId = makeFileId(path);
        const deviceId = this.getSettings().deviceId;
        try {
            await this.db.runWriteBuilder(
                async (snap) => {
                    const existing = (await snap.get(fileId)) as FileDoc | null;
                    if (!existing || existing.deleted) {
                        return {
                            vclocks: [{ path, op: "delete" }],
                            onCommit: () => { this.lastSynced.delete(toPathKey(path)); },
                        };
                    }
                    // Divergent guard: same shape as fileToDb. A delete during
                    // pending pull integration would produce a phantom tombstone
                    // that stealth-deletes the file on every other device.
                    // Yield: user re-deletes after the integration completes.
                    {
                        const existingVC = existing.vclock ?? {};
                        const lastSynced = this.lastSynced.get(toPathKey(path));
                        const isDivergent = lastSynced
                            ? compareVC(existingVC, lastSynced.vclock) === "dominates"
                            : Object.keys(existingVC).length > 0;
                        if (isDivergent) {
                            logWarn(
                                `markDeleted: skipping tombstone for ${path} — pending pull integration ` +
                                `(observed=${JSON.stringify(existingVC)} ` +
                                `integrated=${lastSynced ? JSON.stringify(lastSynced.vclock) : "null"})`,
                            );
                            return null;
                        }
                    }
                    const newVclock = incrementVC(existing.vclock, deviceId);
                    return {
                        docs: [{
                            doc: {
                                ...existing,
                                deleted: true,
                                mtime: Date.now(),
                                vclock: newVclock,
                            } as unknown as CouchSyncDoc,
                            expectedVclock: existing.vclock,
                        }],
                        vclocks: [{ path, op: "delete" }],
                        onCommit: () => { this.lastSynced.delete(toPathKey(path)); },
                    };
                },
                { maxAttempts: CAS_MAX_ATTEMPTS },
            );
        } catch (e) {
            this.surfaceWriteError(e, `markDeleted ${path}`);
            throw e;
        }
    }

    /**
     * Triage a DbError from any VaultSync write. Quota errors escalate via
     * Notice so the user can take action (chunk GC); everything else is
     * warn-logged for observability. Callers still rethrow — the sync loop
     * upstream decides whether to halt or continue based on `e.recovery`.
     */
    private surfaceWriteError(e: unknown, context: string): void {
        if (!(e instanceof DbError)) return;
        if (e.recovery === "halt" && e.userMessage) {
            notify(e.userMessage, 15000);
        }
        logWarn(`CouchSync: ${context}: ${e.kind} — ${e.message}`);
    }

    async applyRemoteDeletion(path: string): Promise<void> {
        await this.vaultWriter.applyRemoteDeletion(path);
        await this.pruneEmptyParents(path);
        await this.markDeleted(path);
    }

    /**
     * After a pull-applied deletion removes a file, prune any parent folders
     * that became empty, walking upward until a non-empty (or root) folder.
     *
     * Why this is needed (invariant S1): folders have no document in the sync
     * model, so a folder rename/delete reaches a receiving device as per-file
     * tombstones. Deleting the files leaves the now-empty parent folder behind
     * (the originating device's FS removed it as part of the move/delete, but
     * the receiver only ever saw file deletions). This closes that asymmetry so
     * both sides converge to the same folder structure.
     *
     * Only the pull-apply paths call this — the live local-delete path doesn't
     * touch the FS (the user's own action already did), and Obsidian prunes the
     * folder there. Deleting an empty folder is safe: it fires a folder-delete
     * event whose `handleFolderDelete` finds zero alive children (no-op, no
     * push). Best-effort — a failed prune just leaves a cosmetic empty folder,
     * never risks data, so errors are swallowed with a warn.
     */
    private async pruneEmptyParents(filePath: string): Promise<void> {
        let dir = parentDir(filePath);
        while (dir !== "") {
            try {
                const { files, folders } = await this.vault.list(dir);
                if (files.length > 0 || folders.length > 0) return; // not empty
                if (!(await this.vault.exists(dir))) return;
                await this.vault.delete(dir);
            } catch (e: any) {
                logWarn(`CouchSync: pruneEmptyParents ${dir}: ${e?.message ?? e}`);
                return;
            }
            dir = parentDir(dir);
        }
    }

    /**
     * Force-push the local vault content for `path`, merging the supplied
     * `baselineVclock` into the new doc's vclock. Bypasses the divergent
     * guard. Used by ConflictOrchestrator when the user picks keep-local
     * in the divergent-edit modal — at that point the divergent state IS
     * the resolution, and the user's content must reach the LocalDB so
     * the push loop carries it to remote.
     */
    async forceLocalEdit(path: string, baselineVclock: VectorClock): Promise<void> {
        const settings = this.getSettings();
        const fileStat = await this.vault.stat(path);
        if (!fileStat) return;
        const content = await this.vault.readBinary(path);
        const chunks = await splitIntoChunks(content, this.hasher);
        const chunkIds = chunks.map((c) => c._id);
        const fileId = makeFileId(path);
        const deviceId = settings.deviceId;
        try {
            await this.db.runWriteBuilder(
                async (snap) => {
                    const existing = (await snap.get(fileId)) as FileDoc | null;
                    const merged = mergeVC(baselineVclock, existing?.vclock ?? {});
                    const newVclock = incrementVC(merged, deviceId);
                    const newDoc: FileDoc = {
                        _id: fileId,
                        schemaVersion: FILE_SCHEMA_VERSION,
                        type: "file",
                        chunks: chunkIds,
                        mtime: fileStat.mtime,
                        ctime: fileStat.ctime,
                        size: fileStat.size,
                        vclock: newVclock,
                    };
                    return {
                        chunks: chunks as unknown as CouchSyncDoc[],
                        docs: [{
                            doc: newDoc as unknown as CouchSyncDoc,
                            expectedVclock: existing?.vclock ?? {},
                        }],
                        vclocks: [{
                            path, op: "set", clock: newVclock,
                            chunks: chunkIds, size: fileStat.size,
                        }],
                        onCommit: () => {
                            this.lastSynced.set(toPathKey(path), {
                                vclock: newVclock,
                                chunks: chunkIds,
                                size: fileStat.size,
                            });
                        },
                    };
                },
                { maxAttempts: CAS_MAX_ATTEMPTS },
            );
        } catch (e) {
            this.surfaceWriteError(e, `forceLocalEdit ${path}`);
            throw e;
        }
    }

    /**
     * Force-tombstone the local doc for `path`, merging `baselineVclock`
     * into the tombstone's vclock. Bypasses the divergent guard. Used by
     * ConflictOrchestrator when the user picks keep-local (= keep
     * deletion) in the divergent-delete modal.
     */
    async forceMarkDeleted(path: string, baselineVclock: VectorClock): Promise<void> {
        const fileId = makeFileId(path);
        const deviceId = this.getSettings().deviceId;
        try {
            await this.db.runWriteBuilder(
                async (snap) => {
                    const existing = (await snap.get(fileId)) as FileDoc | null;
                    if (!existing || existing.deleted) {
                        return {
                            vclocks: [{ path, op: "delete" }],
                            onCommit: () => { this.lastSynced.delete(toPathKey(path)); },
                        };
                    }
                    const merged = mergeVC(baselineVclock, existing.vclock ?? {});
                    const newVclock = incrementVC(merged, deviceId);
                    return {
                        docs: [{
                            doc: {
                                ...existing,
                                deleted: true,
                                mtime: Date.now(),
                                vclock: newVclock,
                            } as unknown as CouchSyncDoc,
                            expectedVclock: existing.vclock,
                        }],
                        vclocks: [{ path, op: "delete" }],
                        onCommit: () => { this.lastSynced.delete(toPathKey(path)); },
                    };
                },
                { maxAttempts: CAS_MAX_ATTEMPTS },
            );
        } catch (e) {
            this.surfaceWriteError(e, `forceMarkDeleted ${path}`);
            throw e;
        }
    }

    /**
     * **Invariant 4 (Pending-edit oracle).** True iff the vault has
     * user-driven work that hasn't reached the LocalDB FileDoc yet.
     *
     * Two-layer check, both chunks-aware:
     *   1. `pendingProbe.hasPending(path)` — ChangeTracker has a debounced
     *      or min-interval-deferred `fileToDb` scheduled for `path`.
     *      Catches the in-flight window between user keystroke and
     *      LocalDB commit (= the pull-delete-vs-debounce silent-loss
     *      race this primitive closes).
     *   2. Disk vs `lastSynced.{chunks,size}` — defense in depth. If the
     *      probe is missing (test harness, race during construction)
     *      OR returns false but the actual disk content differs from
     *      the last integration baseline, still report pending. Catches
     *      the rare crash window where invariant 1 is broken.
     *
     * The legacy `localVclock` parameter is gone — vclock comparison was
     * always `compareVC(local, lastSynced) === "equal"` because the two
     * are kept in lockstep by `fileToDb`/`dbToFile`, so the function was
     * effectively a no-op (always returned false). The new signature is
     * `(path) => Promise<boolean>` and the only caller in `main.ts` was
     * updated to await it.
     */
    async hasUnpushedChanges(path: string): Promise<boolean> {
        if (this.pendingProbe?.hasPending(path)) return true;
        const ls = this.lastSynced.get(toPathKey(path));
        if (!ls || ls.chunks === undefined || ls.size === undefined) {
            // Legacy baseline (pre-{chunks,size} extension). The old code
            // returned false unconditionally here — which let a remote
            // deletion silently overwrite a divergent, un-integrated on-disk
            // edit (#8). Choose the non-destructive side instead: fall back to
            // the LocalDB FileDoc (which still carries the last-integrated
            // chunks/size) as the baseline; if even that is unavailable, a
            // present-on-disk file is treated as possibly-unpushed so the
            // deletion surfaces a CONFLICT rather than destroying local work.
            // The legacy entry self-heals to a real baseline on the next
            // identical reconcile (alignLastSyncedToDoc).
            const stat = await this.vault.stat(path);
            if (!stat) return false; // nothing on disk to lose
            const doc = await this.db.get<FileDoc>(makeFileId(path));
            if (doc && !doc.deleted && doc.chunks !== undefined && doc.size !== undefined) {
                if (stat.size !== doc.size) return true;
                const diskChunks = await this.localChunkIds(path);
                return !chunkListsEqual(diskChunks, doc.chunks);
            }
            return true;
        }
        const stat = await this.vault.stat(path);
        if (!stat) {
            // File gone from vault. The user-driven deletion is handled
            // by the `delete` event path, not here.
            return false;
        }
        if (stat.size !== ls.size) return true;
        const diskChunks = await this.localChunkIds(path);
        return !chunkListsEqual(diskChunks, ls.chunks);
    }

    async handleRename(newPath: string, oldPath: string): Promise<void> {
        await this.fileToDb(newPath);
        await this.markDeleted(oldPath);
    }

    /**
     * Desugar a folder-level delete into per-file tombstones (invariant S1).
     * Obsidian fires one event for the folder, not one per descendant; the
     * children are already gone from the vault FS, so the DB is the only
     * enumeration source (`fileDocsUnderPrefix`). Each child rides the normal
     * `markDeleted` path, so its divergent guard still protects a child a
     * remote device is concurrently editing (it is skipped → surfaced via
     * conflict/reconcile, not force-deleted). A per-child failure is logged
     * and skipped rather than aborting the whole folder — the reconcile
     * backstop (S2) recovers anything missed here.
     */
    async handleFolderDelete(dir: string): Promise<void> {
        const children = await this.db.fileDocsUnderPrefix(dir);
        logDebug(`handleFolderDelete: ${dir} — ${children.length} child file(s)`);
        for (const child of children) {
            const childPath = filePathFromId(child._id);
            try {
                await this.markDeleted(childPath);
            } catch (e: any) {
                logWarn(
                    `handleFolderDelete: child markDeleted failed for ${childPath}: ` +
                        `${e?.message ?? e} — leaving to reconcile`,
                );
            }
        }
    }

    /**
     * Find an on-disk file that shares `targetPath`'s PathKey (NFC+lowercase)
     * but differs in exact spelling — i.e. a case/Unicode-variant of the same
     * logical path. Returns its original-case path, or null when the only
     * match is `targetPath` itself. Used by `dbToFile` to avoid a
     * create-collision and by callers that must detect a case duplicate
     * before writing.
     */
    private findExistingByPathKey(targetPath: string): string | null {
        const key = toPathKey(targetPath);
        for (const f of this.vault.getFiles()) {
            if (f.path !== targetPath && toPathKey(f.path) === key) return f.path;
        }
        return null;
    }

    private async loadSkippedCache(): Promise<Set<PathKey>> {
        if (this.skippedPaths) return this.skippedPaths;
        const doc = await this.db.getSkippedFiles();
        this.skippedPaths = new Set(Object.keys(doc.files).map(toPathKey));
        return this.skippedPaths;
    }

    private async wasSkipped(path: string): Promise<boolean> {
        const cache = await this.loadSkippedCache();
        return cache.has(toPathKey(path));
    }

    private async recordSkipped(path: string, sizeMB: number, limitMB: number): Promise<void> {
        const doc = await this.db.getSkippedFiles();
        const key = toPathKey(path);
        const existing = doc.files[key];
        const roundedSize = Math.round(sizeMB * 10) / 10;
        const isNew = !existing || Math.round(existing.sizeMB * 10) / 10 !== roundedSize;
        doc.files[key] = { sizeMB: roundedSize, skippedAt: Date.now() };
        await this.db.putSkippedFiles(doc);
        (await this.loadSkippedCache()).add(key);
        if (isNew) {
            notify(
                `Skipped "${path}" — ${roundedSize} MB exceeds ${limitMB} MB limit. ` +
                    `Raise the limit in settings to sync it.`,
                8000,
            );
        }
    }

    private async forgetSkipped(path: string): Promise<void> {
        const doc = await this.db.getSkippedFiles();
        const key = toPathKey(path);
        if (!(key in doc.files)) return;
        delete doc.files[key];
        await this.db.putSkippedFiles(doc);
        this.skippedPaths?.delete(key);
    }

    // ── Quarantine (Invariant II): broken FileDocs whose chunks are
    //    unavailable on both sides. Mirrors the skipped-files mechanism but
    //    with chunk-arrival as the clear condition. ────────────────────────

    private async loadQuarantinedCache(): Promise<Set<PathKey>> {
        if (this.quarantinedPaths) return this.quarantinedPaths;
        const doc = await this.db.getQuarantinedFiles();
        this.quarantinedPaths = new Set(Object.keys(doc.files).map(toPathKey));
        return this.quarantinedPaths;
    }

    /** True when `path` is quarantined (broken, restore suppressed). */
    async wasQuarantined(path: string): Promise<boolean> {
        const cache = await this.loadQuarantinedCache();
        return cache.has(toPathKey(path));
    }

    /** Quarantine a broken FileDoc: record its missing chunks, suppress
     *  further restore attempts, and notify once on a new/changed entry.
     *  Returns true when this is a newly-quarantined (or changed) path. */
    async recordQuarantined(path: string, missingChunks: string[]): Promise<boolean> {
        const doc = await this.db.getQuarantinedFiles();
        const key = toPathKey(path);
        const existing = doc.files[key];
        const isNew = !existing
            || existing.missingChunks.length !== missingChunks.length
            || existing.missingChunks.some((id, i) => id !== missingChunks[i]);
        doc.files[key] = { missingChunks: [...missingChunks], quarantinedAt: Date.now() };
        await this.db.putQuarantinedFiles(doc);
        (await this.loadQuarantinedCache()).add(key);
        if (isNew) {
            notify(
                `Quarantined "${path}" — ${missingChunks.length} chunk(s) missing ` +
                    `on this device and the server. It will recover automatically if ` +
                    `another device still has them.`,
                8000,
            );
        }
        return isNew;
    }

    /** Clear quarantine for `path` (its chunks became available again). */
    async clearQuarantined(path: string): Promise<void> {
        const doc = await this.db.getQuarantinedFiles();
        const key = toPathKey(path);
        if (!(key in doc.files)) return;
        delete doc.files[key];
        await this.db.putQuarantinedFiles(doc);
        this.quarantinedPaths?.delete(key);
    }

    private async localChunkIds(path: string): Promise<string[]> {
        const content = await this.vault.readBinary(path);
        const chunks = await splitIntoChunks(content, this.hasher);
        return chunks.map((c) => c._id);
    }

    private static chunksEqual(a: string[], b: string[]): boolean {
        return a.length === b.length && a.every((id, i) => id === b[i]);
    }

    private shouldSync(path: string): boolean {
        const settings = this.getSettings();
        if (path.startsWith(".")) return false;

        if (settings.syncFilter) {
            const re = this.compileSyncRegex("syncFilter", settings.syncFilter);
            if (re && !re.test(path)) return false;
        }
        if (settings.syncIgnore) {
            const re = this.compileSyncRegex("syncIgnore", settings.syncIgnore);
            if (re && re.test(path)) return false;
        }
        return true;
    }

    private compileSyncRegex(
        which: "syncFilter" | "syncIgnore",
        pattern: string,
    ): RegExp | null {
        const cache = which === "syncFilter" ? this.syncFilterCache : this.syncIgnoreCache;
        if (cache && cache.pattern === pattern) return cache.re;
        try {
            const re = new RegExp(pattern);
            if (which === "syncFilter") {
                this.syncFilterCache = { pattern, re };
            } else {
                this.syncIgnoreCache = { pattern, re };
            }
            return re;
        } catch {
            logWarn(`${which} is not a valid regex: ${pattern}`);
            return null;
        }
    }

    private async ensureParentDir(filePath: string): Promise<void> {
        const parts = filePath.split("/");
        if (parts.length <= 1) return;
        const dir = parts.slice(0, -1).join("/");
        if (!(await this.vault.exists(dir))) {
            await this.vault.createFolder(dir);
        }
    }
}
