import type { IVaultIO } from "../types/vault-io.ts";
import type { LocalDB } from "../db/local-db.ts";
import type { FileDoc, ChunkDoc, CouchSyncDoc } from "../types.ts";
import type { CouchSyncSettings } from "../settings.ts";
import type { VaultWriter, WriteResult } from "./vault-writer.ts";
import { splitIntoChunks, joinChunks } from "../db/chunker.ts";
import { notify } from "../ui/log.ts";
import { compareVC, incrementVC, mergeVC } from "./vector-clock.ts";
import type { VectorClock } from "./vector-clock.ts";
import type { LastSynced } from "./last-synced.ts";
import { classifySyncRelation, type SyncRelation } from "./classify-sync-relation.ts";
import { chunkListsEqual } from "./chunk-equality.ts";
import { makeFileId, filePathFromId } from "../types/doc-id.ts";
import { toPathKey, type PathKey } from "../utils/path.ts";
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
     * Late-bound probe for "is the user editing this path right now"
     * (invariant 4). Construction-cycle-broken via `setPendingProbe`
     * because `ChangeTracker` itself depends on `VaultSync`. Null until
     * `main.ts` wires it up post-construction.
     */
    private pendingProbe: IPendingProbe | null = null;

    constructor(
        private vault: IVaultIO,
        private db: LocalDB,
        private getSettings: () => CouchSyncSettings,
        private vaultWriter: VaultWriter,
    ) {}

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
        const chunks = await splitIntoChunks(content);
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
            await this.vaultWriter.applyRemoteDeletion(vaultPath);
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
        const chunkMap = new Map(chunks.map((c) => [c._id, c]));
        const orderedChunks = fileDoc.chunks
            .map((id) => chunkMap.get(id))
            .filter((c): c is ChunkDoc => c != null);

        if (orderedChunks.length !== fileDoc.chunks.length) {
            const missing = fileDoc.chunks.filter((id) => !chunkMap.has(id));
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
     * Reconverge `lastSynced.vclock` with a FileDoc whose content matches
     * the vault but whose vclock has drifted (= `vclock-only-drift` from the
     * classifier). Pure meta write — no chunk/file write needed because
     * content is already aligned. The merged vclock dominates both sides
     * so future scans see them as equal.
     */
    async silentReconvergeVclock(path: string, fileDoc: FileDoc): Promise<void> {
        const key = toPathKey(path);
        const lastSynced = this.lastSynced.get(key);
        const baseVC = lastSynced?.vclock ?? {};
        const merged = mergeVC(baseVC, fileDoc.vclock ?? {});
        await this.db.runWriteTx({
            vclocks: [{
                path, op: "set", clock: merged,
                chunks: fileDoc.chunks, size: fileDoc.size,
            }],
        });
        this.lastSynced.set(key, {
            vclock: merged,
            chunks: fileDoc.chunks,
            size: fileDoc.size,
        });
        logDebug(`silentReconvergeVclock: ${path} ${JSON.stringify(baseVC)} ⊔ ${JSON.stringify(fileDoc.vclock ?? {})} = ${JSON.stringify(merged)}`);
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
        await this.markDeleted(path);
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
        const chunks = await splitIntoChunks(content);
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
     * True when the local file has changes not yet synced. Compares the
     * given vclock against the last-synced snapshot. Returns false when
     * no record exists (plugin just loaded — assume nothing pending).
     */
    hasUnpushedChanges(path: string, localVclock: VectorClock): boolean {
        const lastSynced = this.lastSynced.get(toPathKey(path));
        if (!lastSynced) return false;
        return compareVC(localVclock, lastSynced.vclock) !== "equal";
    }

    async handleRename(newPath: string, oldPath: string): Promise<void> {
        await this.fileToDb(newPath);
        await this.markDeleted(oldPath);
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

    private async localChunkIds(path: string): Promise<string[]> {
        const content = await this.vault.readBinary(path);
        const chunks = await splitIntoChunks(content);
        return chunks.map((c) => c._id);
    }

    private static chunksEqual(a: string[], b: string[]): boolean {
        return a.length === b.length && a.every((id, i) => id === b[i]);
    }

    private shouldSync(path: string): boolean {
        const settings = this.getSettings();
        if (path.startsWith(".")) return false;

        if (settings.syncFilter) {
            try {
                const re = new RegExp(settings.syncFilter);
                if (!re.test(path)) return false;
            } catch { logWarn(`syncFilter is not a valid regex: ${settings.syncFilter}`); }
        }
        if (settings.syncIgnore) {
            try {
                const re = new RegExp(settings.syncIgnore);
                if (re.test(path)) return false;
            } catch { logWarn(`syncIgnore is not a valid regex: ${settings.syncIgnore}`); }
        }
        return true;
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
