import type { IVaultIO } from "../types/vault-io.ts";
import type { LocalDB } from "../db/local-db.ts";
import type { FileDoc, ChunkDoc, CouchSyncDoc } from "../types.ts";
import type { CouchSyncSettings } from "../settings.ts";
import type { VaultWriter, WriteResult } from "./vault-writer.ts";
import { splitIntoChunks, joinChunks } from "../db/chunker.ts";
import { notify } from "../ui/log.ts";
import { compareVC, incrementVC } from "./vector-clock.ts";
import type { VectorClock } from "./vector-clock.ts";
import { makeFileId, filePathFromId } from "../types/doc-id.ts";
import { toPathKey, type PathKey } from "../utils/path.ts";
import { logDebug, logWarn } from "../ui/log.ts";
import { DbError } from "../db/write-transaction.ts";

/**
 * Result of comparing a vault file against its local DB record.
 *
 * Answers *local drift* ("has the vault diverged from the DB?"), not
 * cross-device ordering. Cross-device ordering lives in Vector Clocks
 * and is decided by ConflictResolver via resolveOnPull().
 */
export type CompareResult = "identical" | "local-unpushed" | "remote-pending";

/**
 * Subset of ChangeTracker that EditorAwareVaultWriter needs.
 *
 * Modify-path echo suppression no longer flows through this token —
 * the `chunksEqual` short-circuit in `fileToDb` provides data-level
 * idempotency. Only the deletion path still needs explicit signalling
 * (deletions have no chunksEqual analog).
 */
export interface IWriteIgnore {
    /** Mark the next `delete` event on `path` as sync-driven. */
    ignoreDelete(path: string): void;
}

/** Max snapshot→commit retries inside runWrite when a concurrent pull lands
 *  between our read and our CAS check. Realistic worst case is 1. */
const CAS_MAX_ATTEMPTS = 4;

export class VaultSync {
    /**
     * vault path → vclock at the time of the last successful sync write.
     *
     * **Read cache only** — every mutation is the in-memory mirror of an
     * already-committed `runWrite({ vclocks })` so the persisted state and
     * the cache stay in lock-step. There is no flush window: a crash after
     * any successful write loses no vclock information.
     *
     * Loaded once via `loadLastSyncedVclocks()` at plugin init; the on-disk
     * representation is per-path meta entries (`_local/vclock/<path>`).
     */
    private lastSyncedVclock = new Map<PathKey, VectorClock>();

    /**
     * In-memory mirror of `_local/skipped-files` paths. Lets the hot path
     * skip a DB read on every successful file sync.
     */
    private skippedPaths: Set<PathKey> | null = null;

    constructor(
        private vault: IVaultIO,
        private db: LocalDB,
        private getSettings: () => CouchSyncSettings,
        private vaultWriter: VaultWriter,
    ) {}

    /**
     * Load persisted lastSyncedVclock entries. Called once during plugin
     * init, before reconciliation starts. Performs a transparent migration
     * from the legacy single-doc layout if present.
     */
    async loadLastSyncedVclocks(): Promise<void> {
        const stored = await this.db.loadAllSyncedVclocks();
        this.lastSyncedVclock.clear();
        for (const [path, vc] of stored) {
            this.lastSyncedVclock.set(path, vc);
        }
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
                        vclocks: [{ path, op: "set", clock: newVclock }],
                        onCommit: () => {
                            this.lastSyncedVclock.set(toPathKey(path), newVclock);
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

    async dbToFile(fileDoc: FileDoc): Promise<void> {
        const vaultPath = filePathFromId(fileDoc._id);

        // Deletion tombstones pass through the filter — deletions are always applied.
        if (!fileDoc.deleted && !this.shouldSync(vaultPath)) {
            logDebug(`dbToFile: skipped filtered path ${vaultPath}`);
            return;
        }

        if (fileDoc.deleted) {
            await this.vaultWriter.applyRemoteDeletion(vaultPath);
            return;
        }

        const existingStat = await this.vault.stat(vaultPath);

        if (existingStat && existingStat.size === fileDoc.size) {
            const ids = await this.localChunkIds(vaultPath);
            if (VaultSync.chunksEqual(ids, fileDoc.chunks)) {
                return; // identical content
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
            // VaultWriter declined to apply (e.g., the local doc
            // diverged during IME composition). Leave bookkeeping
            // untouched so Reconciler picks up the discrepancy on
            // its next pass.
            logDebug(`dbToFile: skipped ${vaultPath} (${result.reason})`);
            return;
        }

        const clock = { ...(fileDoc.vclock ?? {}) };
        // Persist the vclock in the docs store's meta so it lives in
        // the same IDB as the FileDoc itself. Pure meta write — no CAS
        // needed, so pass a fixed tx rather than a builder.
        await this.db.runWriteTx({
            vclocks: [{ path: vaultPath, op: "set", clock }],
        });
        this.lastSyncedVclock.set(toPathKey(vaultPath), clock);

        // History capture is now owned by VaultWriter (it knows when
        // the content has actually landed in the editor/disk).
    }

    /**
     * Compare a vault file against its local DB record to detect drift.
     * Step 1 — chunk equality.
     * Step 2 — vclock comparison against `lastSyncedVclock[path]`.
     */
    async compareFileToDoc(fileDoc: FileDoc, filePath: string, fileSize: number): Promise<CompareResult> {
        if (fileSize === fileDoc.size) {
            const ids = await this.localChunkIds(filePath);
            if (VaultSync.chunksEqual(ids, fileDoc.chunks)) {
                return "identical";
            }
        }
        const lastSynced = this.lastSyncedVclock.get(toPathKey(filePathFromId(fileDoc._id)));
        if (lastSynced) {
            const rel = compareVC(fileDoc.vclock ?? {}, lastSynced);
            return rel === "equal" ? "local-unpushed" : "remote-pending";
        }
        return "remote-pending";
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
                            onCommit: () => { this.lastSyncedVclock.delete(toPathKey(path)); },
                        };
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
                        onCommit: () => { this.lastSyncedVclock.delete(toPathKey(path)); },
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
     * True when the local file has changes not yet synced. Compares the
     * given vclock against the last-synced snapshot. Returns false when
     * no record exists (plugin just loaded — assume nothing pending).
     */
    hasUnpushedChanges(path: string, localVclock: VectorClock): boolean {
        const lastSynced = this.lastSyncedVclock.get(toPathKey(path));
        if (!lastSynced) return false;
        return compareVC(localVclock, lastSynced) !== "equal";
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
