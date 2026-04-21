import type { CouchSyncDoc, FileDoc, ChunkDoc } from "../types.ts";
import type {
    IDocStore,
    AllDocsOpts,
    AllDocsResult,
    LocalChangesResult,
    ListIdsRange,
} from "./interfaces.ts";
import { DexieStore, VCLOCK_KEY_PREFIX, vclockMetaKey } from "./dexie-store.ts";
import type { WriteTransaction, WriteBuilder } from "./write-transaction.ts";
import type { VectorClock } from "../sync/vector-clock.ts";
import { toPathKey, type PathKey } from "../utils/path.ts";
import {
    ID_RANGE,
    makeFileId,
    isFileDocId,
    isChunkDocId,
    isConfigDocId,
    isReplicatedDocId,
} from "../types/doc-id.ts";
import { HandleGuard } from "./handle-guard.ts";

/** Local-only catch-up scan cursor (not replicated). */
export interface ScanCursor {
    lastScanStartedAt: number;
    lastScanCompletedAt: number;
    /** Update seq seen at the end of the last scan. Reconciler uses
     *  this for an O(1) "did anything change in the DB?" check. */
    lastSeenUpdateSeq?: string | number;
}

/**
 * Snapshot of vault file paths this device has seen. Compared against the
 * current vault state during reconcile() to distinguish "deleted on this
 * device" from "newly arrived from another device".
 */
export interface VaultManifest {
    paths: string[];
    updatedAt: number;
}

const SCAN_CURSOR_ID = "_local/scan-cursor";
const VAULT_MANIFEST_ID = "_local/vault-manifest";
const SKIPPED_FILES_ID = "_local/skipped-files";
const LAST_SYNCED_VCLOCKS_ID = "_local/last-synced-vclocks";

/**
 * Files that fileToDb() refused to push because they exceeded
 * `maxFileSizeMB`. Persisted so the settings tab can surface them and the
 * user can decide whether to raise the limit.
 */
export interface SkippedFilesDoc {
    files: Record<string, { sizeMB: number; skippedAt: number }>;
}

/**
 * LocalDB — self-healing wrapper over two DexieStores (docs + meta).
 *
 * Every access routes through a `HandleGuard` so a silently-killed
 * IndexedDB connection (OS suspend, tab reclaim) can be reopened
 * transparently. Callers see one logical database that is always
 * available; after `HandleGuard.maxReopen` consecutive failures the
 * guard gives up and throws `DbError("degraded")` for the sync
 * supervisor to halt + notify the user.
 */
export class LocalDB implements IDocStore<CouchSyncDoc> {
    private readonly dbName: string;
    private docsGuard: HandleGuard<DexieStore<CouchSyncDoc>> | null = null;
    private metaGuard: HandleGuard<DexieStore<CouchSyncDoc>> | null = null;

    constructor(dbName: string) {
        this.dbName = dbName;
    }

    open(): void {
        if (this.docsGuard) return;
        this.docsGuard = new HandleGuard({
            factory: () => new DexieStore<CouchSyncDoc>(this.dbName),
            cleanup: async (s) => { await s.close(); },
            probe: async (s) => { await s.info(); },
        });
        this.metaGuard = new HandleGuard({
            factory: () => new DexieStore<CouchSyncDoc>(`${this.dbName}-meta`),
            cleanup: async (s) => { await s.close(); },
            probe: async (s) => { await s.info(); },
        });
    }

    async close(): Promise<void> {
        if (this.docsGuard) await this.docsGuard.close();
        if (this.metaGuard) await this.metaGuard.close();
        this.docsGuard = null;
        this.metaGuard = null;
    }

    async destroy(): Promise<void> {
        await this.runDocsOp((s) => s.destroy(), "destroy-docs");
        await this.runMetaOp((s) => s.destroy(), "destroy-meta");
        this.docsGuard = null;
        this.metaGuard = null;
    }

    // ── Guarded access (canonical) ───────────────────────

    /** Run an op against the docs store. Handle failures are retried
     *  internally; other exceptions bubble up. */
    async runDocsOp<R>(op: (s: DexieStore<CouchSyncDoc>) => Promise<R>, context: string): Promise<R> {
        const g = this.docsGuard;
        if (!g) throw new Error("Database not opened");
        return g.runOp(op, context);
    }

    /** Run an op against the meta store. */
    async runMetaOp<R>(op: (s: DexieStore<CouchSyncDoc>) => Promise<R>, context: string): Promise<R> {
        const g = this.metaGuard;
        if (!g) throw new Error("Database not opened");
        return g.runOp(op, context);
    }

    /** Probe both handles and reopen if either has expired. Called by
     *  SyncEngine.openSession() before it trusts the local DB. */
    async ensureHealthy(): Promise<void> {
        if (!this.docsGuard || !this.metaGuard) throw new Error("Database not opened");
        await this.docsGuard.ensureHealthy();
        await this.metaGuard.ensureHealthy();
    }

    // ── IDocStore: reads ─────────────────────────────────

    async get<T extends CouchSyncDoc>(id: string): Promise<T | null> {
        return this.runDocsOp((s) => s.get(id), "get") as Promise<T | null>;
    }

    async allDocs(opts?: AllDocsOpts): Promise<AllDocsResult<CouchSyncDoc>> {
        return this.runDocsOp((s) => s.allDocs(opts), "allDocs");
    }

    async listIds(range: ListIdsRange): Promise<string[]> {
        return this.runDocsOp((s) => s.listIds(range), "listIds");
    }

    async info(): Promise<{ updateSeq: number | string }> {
        return this.runDocsOp((s) => s.info(), "info");
    }

    async changes(
        since?: number | string,
        opts?: { include_docs?: boolean },
    ): Promise<LocalChangesResult<CouchSyncDoc>> {
        return this.runDocsOp((s) => s.changes(since, opts), "changes");
    }

    // ── IDocStore: writes ────────────────────────────────

    async runWriteBuilder(
        builder: WriteBuilder<CouchSyncDoc>,
        opts?: { maxAttempts?: number },
    ): Promise<boolean> {
        return this.runDocsOp((s) => s.runWriteBuilder(builder, opts), "runWriteBuilder");
    }

    async runWriteTx(tx: WriteTransaction<CouchSyncDoc>): Promise<void> {
        return this.runDocsOp((s) => s.runWriteTx(tx), "runWriteTx");
    }

    // ── Higher-level reads ───────────────────────────────

    /**
     * Probe the **vault** database for non-conforming documents. Returns
     * the `_id` of the first offender, or null if the store is empty /
     * fully current. Used by plugin startup to gate the replicator until
     * the user rebuilds via Maintenance.
     */
    async findLegacyVaultDoc(): Promise<string | null> {
        const idResult = await this.allDocs({ limit: 200 });
        for (const row of idResult.rows) {
            if (row.id.startsWith("_")) continue;
            if (!isReplicatedDocId(row.id)) return row.id;
            if (isConfigDocId(row.id)) return row.id;
            if (isFileDocId(row.id)) {
                const doc = await this.get<FileDoc>(row.id);
                if (!doc || doc.type !== "file") continue;
                if (!doc.vclock || Object.keys(doc.vclock).length === 0) {
                    return row.id;
                }
                return null; // first valid FileDoc → schema is current
            }
            if (isChunkDocId(row.id)) continue;
        }
        return null;
    }

    /**
     * Delete every document with a given `_id` prefix from the vault DB
     * in a single atomic tx. Returns the IDs of the deleted documents.
     */
    async deleteAllByPrefix(prefix: string): Promise<string[]> {
        const result = await this.allDocs({
            startkey: prefix,
            endkey: prefix + "\ufff0",
        });
        if (result.rows.length === 0) return [];
        const ids = result.rows.map((row) => row.id);
        await this.runWriteTx({ deletes: ids });
        return ids;
    }

    async getFileDoc(path: string): Promise<FileDoc | null> {
        return this.get<FileDoc>(makeFileId(path));
    }

    async getFileDocs(paths: string[]): Promise<Map<string, FileDoc>> {
        const result = new Map<string, FileDoc>();
        if (paths.length === 0) return result;
        const ids = paths.map((p) => makeFileId(p));
        const rows = await this.allDocs({ keys: ids, include_docs: true });
        for (let i = 0; i < rows.rows.length; i++) {
            const row = rows.rows[i];
            if (row.doc) {
                const doc = row.doc as unknown as CouchSyncDoc;
                if (doc.type === "file") result.set(paths[i], doc as FileDoc);
            }
        }
        return result;
    }

    async getChunks(chunkIds: string[]): Promise<ChunkDoc[]> {
        const result = await this.allDocs({ keys: chunkIds, include_docs: true });
        const chunks: ChunkDoc[] = [];
        for (const row of result.rows) {
            if (row.doc) {
                chunks.push(row.doc as unknown as ChunkDoc);
            }
        }
        return chunks;
    }

    async allFileDocs(): Promise<FileDoc[]> {
        const result = await this.allDocs({
            startkey: ID_RANGE.file.startkey,
            endkey: ID_RANGE.file.endkey,
            include_docs: true,
        });
        const files: FileDoc[] = [];
        for (const row of result.rows) {
            if (row.doc) {
                const doc = row.doc as unknown as CouchSyncDoc;
                if (doc.type === "file") files.push(doc as FileDoc);
            }
        }
        return files;
    }

    /** Delete all documents with given ID prefix. Returns deleted doc IDs. */
    async deleteByPrefix(prefix: string): Promise<string[]> {
        return this.deleteAllByPrefix(prefix);
    }

    // ── Metadata (Dexie meta store) ──────────────────────

    async getMeta<V = any>(key: string): Promise<V | null> {
        return this.runDocsOp((s) => s.getMeta<V>(key), "getMeta");
    }

    async getMetaByPrefix<V = any>(prefix: string): Promise<Array<{ key: string; value: V }>> {
        return this.runDocsOp((s) => s.getMetaByPrefix<V>(prefix), "getMetaByPrefix");
    }

    async getMetaStoreValue<V = any>(key: string): Promise<V | null> {
        return this.runMetaOp((s) => s.getMeta<V>(key), "getMetaStoreValue");
    }

    async runMetaWriteTx(tx: WriteTransaction<CouchSyncDoc>): Promise<void> {
        return this.runMetaOp((s) => s.runWriteTx(tx), "runMetaWriteTx");
    }

    async getScanCursor(): Promise<ScanCursor | null> {
        const doc = await this.getMetaStoreValue<ScanCursor>(SCAN_CURSOR_ID);
        if (!doc) return null;
        return {
            lastScanStartedAt: doc.lastScanStartedAt ?? 0,
            lastScanCompletedAt: doc.lastScanCompletedAt ?? 0,
            lastSeenUpdateSeq: doc.lastSeenUpdateSeq,
        };
    }

    async putScanCursor(cursor: ScanCursor): Promise<void> {
        await this.runMetaWriteTx({
            meta: [{ op: "put", key: SCAN_CURSOR_ID, value: cursor }],
        });
    }

    async getVaultManifest(): Promise<VaultManifest | null> {
        const doc = await this.getMetaStoreValue<VaultManifest>(VAULT_MANIFEST_ID);
        if (!doc) return null;
        return {
            paths: doc.paths ?? [],
            updatedAt: doc.updatedAt ?? 0,
        };
    }

    async putVaultManifest(manifest: VaultManifest): Promise<void> {
        await this.runMetaWriteTx({
            meta: [{ op: "put", key: VAULT_MANIFEST_ID, value: manifest }],
        });
    }

    async getSkippedFiles(): Promise<SkippedFilesDoc> {
        const doc = await this.getMetaStoreValue<SkippedFilesDoc>(SKIPPED_FILES_ID);
        return { files: doc?.files ?? {} };
    }

    async putSkippedFiles(doc: SkippedFilesDoc): Promise<void> {
        await this.runMetaWriteTx({
            meta: [{ op: "put", key: SKIPPED_FILES_ID, value: doc }],
        });
    }

    /**
     * Load every per-path lastSyncedVclock from the docs store's meta
     * table. Per-path entries (`_local/vclock/<path>`) are written in the
     * same Dexie transaction as the FileDoc / chunks they refer to, so
     * the on-disk view never lags behind the doc state.
     *
     * Performs a one-shot migration from the legacy single-doc layout
     * (`_local/last-synced-vclocks`, formerly stored on the *separate*
     * meta store) when detected, so existing vaults upgrade transparently.
     */
    async loadAllSyncedVclocks(): Promise<Map<PathKey, VectorClock>> {
        const out = new Map<PathKey, VectorClock>();
        const staleKeys: string[] = [];

        const rows = await this.getMetaByPrefix<VectorClock>(VCLOCK_KEY_PREFIX);
        for (const { key, value } of rows) {
            const rawPath = key.slice(VCLOCK_KEY_PREFIX.length);
            const normalized = toPathKey(rawPath);
            out.set(normalized, value);
            if (rawPath !== (normalized as string)) {
                staleKeys.push(key);
            }
        }

        // One-shot migration: legacy single-doc lived on the *meta* store.
        const legacy = await this.getMetaStoreValue<{ clocks: Record<string, VectorClock> }>(
            LAST_SYNCED_VCLOCKS_ID,
        );
        if (legacy?.clocks) {
            const newVclocks: Array<{ path: string; op: "set"; clock: VectorClock }> = [];
            for (const [path, vc] of Object.entries(legacy.clocks)) {
                const normalized = toPathKey(path);
                if (!out.has(normalized)) {
                    out.set(normalized, vc);
                    newVclocks.push({ path, op: "set", clock: vc });
                }
            }
            if (newVclocks.length > 0) {
                await this.runWriteTx({ vclocks: newVclocks });
            }
            await this.runMetaWriteTx({
                meta: [{ op: "delete", key: LAST_SYNCED_VCLOCKS_ID }],
            });
        }

        // Stale-key cleanup: delete non-normalized keys, re-write with normalized keys.
        if (staleKeys.length > 0) {
            await this.runWriteTx({
                meta: staleKeys.map((key) => ({ op: "delete" as const, key })),
            });
            const rewriteOps = [...out.entries()].map(([pathKey, clock]) => ({
                path: pathKey as string,
                op: "set" as const,
                clock,
            }));
            await this.runWriteTx({ vclocks: rewriteOps });
        }

        return out;
    }

    /** Compose a vclock meta key (`_local/vclock/<path>`). Exposed for tests. */
    static vclockMetaKey(path: string): string {
        return vclockMetaKey(path);
    }

    // ── Test-only hooks ──────────────────────────────────

    /** @internal */
    async __closeDocsHandleForTest(): Promise<void> {
        if (this.docsGuard) await this.docsGuard.close();
    }

    /** @internal */
    async __closeMetaHandleForTest(): Promise<void> {
        if (this.metaGuard) await this.metaGuard.close();
    }
}
