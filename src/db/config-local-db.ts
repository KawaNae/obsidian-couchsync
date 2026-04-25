/**
 * ConfigLocalDB — DexieStore-backed local store dedicated to ConfigDocs.
 *
 * v0.11.0 splits config storage out of the main vault DB. ConfigDocs now
 * live in a separate store (and a separate remote CouchDB), which lets
 * device pools (e.g. mobile vs desktop) maintain independent `.obsidian/`
 * configurations against the same shared vault.
 *
 * v0.20.5 wraps the underlying DexieStore in a `HandleGuard` so a
 * silently-killed IndexedDB connection (iOS Safari aborts in-flight
 * transactions on visibilitychange→hidden) reopens transparently —
 * matching the discipline LocalDB has had since v0.18.
 */

import type { ConfigDoc, CouchSyncDoc } from "../types.ts";
import type {
    IDocStore,
    AllDocsOpts,
    AllDocsResult,
    LocalChangesResult,
    ListIdsRange,
} from "./interfaces.ts";
import { DexieStore } from "./dexie-store.ts";
import { HandleGuard } from "./handle-guard.ts";
import type { WriteTransaction, WriteBuilder } from "./write-transaction.ts";
import { ID_RANGE, isConfigDocId } from "../types/doc-id.ts";

export class ConfigLocalDB implements IDocStore<CouchSyncDoc> {
    private readonly dbName: string;
    private guard: HandleGuard<DexieStore<CouchSyncDoc>> | null = null;

    constructor(dbName: string) {
        this.dbName = dbName;
    }

    // ── Lifecycle ───────────────────────────────────────

    open(): void {
        if (this.guard) return;
        this.guard = new HandleGuard({
            factory: () => new DexieStore<CouchSyncDoc>(this.dbName),
            cleanup: async (s) => { await s.close(); },
            probe: async (s) => { await s.info(); },
        });
    }

    async close(): Promise<void> {
        if (this.guard) await this.guard.close();
        this.guard = null;
    }

    async destroy(): Promise<void> {
        // destroy needs an active handle: open lazily if not already.
        this.open();
        await this.runOp((s) => s.destroy(), "destroy");
        this.guard = null;
    }

    /** Probe the handle and reopen once if dead. Symmetric with LocalDB. */
    async ensureHealthy(): Promise<void> {
        if (!this.guard) throw new Error("Database not opened");
        await this.guard.ensureHealthy();
    }

    // ── Guarded access ──────────────────────────────────

    private runOp<R>(
        op: (s: DexieStore<CouchSyncDoc>) => Promise<R>,
        context: string,
    ): Promise<R> {
        if (!this.guard) {
            // Auto-open: callers built before v0.20.5 didn't know to call
            // open() explicitly. Lazy open keeps the failure mode the
            // same as LocalDB, which DOES require explicit open().
            this.open();
        }
        return this.guard!.runOp(op, context);
    }

    // ── Read surface ────────────────────────────────────

    async get(id: string): Promise<ConfigDoc | null> {
        return this.runOp((s) => s.get(id), "get") as Promise<ConfigDoc | null>;
    }

    async allDocs(opts?: AllDocsOpts): Promise<AllDocsResult<CouchSyncDoc>> {
        return this.runOp((s) => s.allDocs(opts), "allDocs");
    }

    async listIds(range: ListIdsRange): Promise<string[]> {
        return this.runOp((s) => s.listIds(range), "listIds");
    }

    async changes(
        since?: number | string,
        opts?: { include_docs?: boolean },
    ): Promise<LocalChangesResult<CouchSyncDoc>> {
        return this.runOp((s) => s.changes(since, opts), "changes");
    }

    async info(): Promise<{ updateSeq: number | string }> {
        return this.runOp((s) => s.info(), "info");
    }

    // ── Write surface ───────────────────────────────────

    /** Builder-style atomic write with CAS retry. */
    async runWriteBuilder(
        builder: WriteBuilder<CouchSyncDoc>,
        opts?: { maxAttempts?: number },
    ): Promise<boolean> {
        return this.runOp((s) => s.runWriteBuilder(builder, opts), "runWriteBuilder");
    }

    /** Simple atomic batch write (no CAS retry needed). */
    async runWriteTx(tx: WriteTransaction<CouchSyncDoc>): Promise<void> {
        return this.runOp((s) => s.runWriteTx(tx), "runWriteTx");
    }

    // ── Domain helpers ──────────────────────────────────

    /**
     * Return every ConfigDoc in the store. Uses a `config:` range query.
     */
    async allConfigDocs(): Promise<ConfigDoc[]> {
        const result = await this.allDocs({
            startkey: ID_RANGE.config.startkey,
            endkey: ID_RANGE.config.endkey,
            include_docs: true,
        });
        const docs: ConfigDoc[] = [];
        for (const row of result.rows) {
            if (row.doc) {
                const d = row.doc as unknown as CouchSyncDoc;
                if (d.type === "config") docs.push(d as ConfigDoc);
            }
        }
        return docs;
    }

    /**
     * Delete all documents with the given ID prefix in a single rw tx.
     * Returns deleted IDs.
     */
    async deleteByPrefix(prefix: string): Promise<string[]> {
        const result = await this.allDocs({
            startkey: prefix,
            endkey: prefix + "\ufff0",
        });
        if (result.rows.length === 0) return [];
        const ids = result.rows.map((row) => row.id);
        await this.runWriteTx({ deletes: ids });
        return ids;
    }

    /**
     * Probe for documents that don't conform to the v0.11.0 ConfigDoc
     * schema. Returns the offending `_id`, or null if the store is
     * empty / fully current.
     */
    async findLegacyConfigDoc(): Promise<string | null> {
        const result = await this.allDocs({ limit: 200 });
        for (const row of result.rows) {
            if (row.id.startsWith("_")) continue;
            if (!isConfigDocId(row.id)) {
                return row.id;
            }
            const doc = await this.get(row.id) as ConfigDoc | null;
            if (!doc) continue;
            if (!doc.vclock || Object.keys(doc.vclock).length === 0) {
                return row.id;
            }
            return null; // first valid → schema is current
        }
        return null;
    }

    // ── Test-only hooks ──────────────────────────────────

    /** @internal Expose runOp so tests can simulate dead handles. */
    async __closeHandleForTest(): Promise<void> {
        if (this.guard) await this.guard.close();
    }
}
