/**
 * PendingApply — the one record of FileDocs that are committed to LocalDB
 * but not yet reflected in the vault, and the one place that retries them.
 *
 * Two cursors move past FileDocs without the vault necessarily following:
 * the pull's `remoteSeq` (a pulled doc whose apply failed post-commit) and
 * the Reconciler's scan cursor (a doc whose restore/pull it could not
 * apply). Both obey the same invariant: a cursor moves past a doc only when
 * the doc was applied or recorded here. The set is drained every pull cycle
 * (including the empty-longpoll branch) and by every reconcile, including
 * its fast path, so a doc recovers once its chunks become available even
 * though nothing in the docs table changes.
 *
 * Why a drain at all: chunks do NOT flow through `_changes`. A chunk that
 * becomes durable on the server never wakes the longpoll and never changes
 * this device's docs, so only an explicit retry can fetch it.
 *
 * A doc whose chunks are missing locally AND on the server is "broken"
 * (quarantined): its entry carries the missing chunk ids, the user is told
 * once, and the drain keeps probing so it recovers when another device
 * pushes the chunks again. A miss without a server answer (offline) is
 * transient and recorded without the ids.
 *
 * Stored as one meta entry per id (`_sync/pending-apply/<fileDocId>`) in
 * the docs-store meta table, so the pull can record its ids in the SAME tx
 * as the `remoteSeq` advance (`Checkpoints.commitPullBatch`).
 */
import type { FileDoc } from "../../types.ts";
import { isFileDoc } from "../../types.ts";
import type { WriteResult } from "../../sync/vault-writer.ts";
import type { MetaWrite } from "../write-transaction.ts";
import type { LocalDB } from "../local-db.ts";
import { filePathFromId } from "../../types/doc-id.ts";
import { logDebug, logError } from "../../ui/log.ts";

export const PENDING_APPLY_KEY_PREFIX = "_sync/pending-apply/";

export type PendingApplyReason =
    /** The vault apply of a live doc did not complete: a referenced chunk
     *  was unavailable, or the write failed. Retried by fetching the chunks
     *  and writing again. */
    | "missing-chunks"
    /** A clean remote soft-deletion (take-remote, no local edit) whose vault
     *  delete runs post-commit in the pull's `onCommit`. If that delete throws
     *  or the process is killed between the durable tombstone commit and the
     *  vault delete, the deletion would un-apply (LocalDB tombstone vs
     *  surviving vault file). Recorded so the drain re-applies the deletion. */
    | "pending-deletion";

export interface PendingApplyEntry {
    addedAt: number;
    reason: PendingApplyReason;
    /** Chunk ids the server was asked for and does not have: the doc is
     *  broken (quarantined). Absent while the miss may be transient. */
    missingChunks?: string[];
}

export interface PendingApplyRow {
    id: string;
    entry: PendingApplyEntry;
}

/** Availability of a FileDoc's chunks after a fetch attempt. When
 *  `stillMissing` is non-empty and `remoteConsulted` is true those are
 *  missing on the server too = broken; when false the device was offline =
 *  transient. */
export interface EnsureChunksResult {
    stillMissing: string[];
    remoteConsulted: boolean;
}

/** Outcome of applying one doc: written, broken (chunks gone everywhere,
 *  recorded), or not done for a transient reason (recorded). */
export type ApplyOutcome = "applied" | "quarantined" | "skipped";

/** Build the meta key for a given file-doc id. */
export function pendingApplyKey(docId: string): string {
    return PENDING_APPLY_KEY_PREFIX + docId;
}

/** Recover the file-doc id from a meta key, or null if the key is not in
 *  the pending-apply namespace. */
export function pendingApplyIdFromKey(key: string): string | null {
    if (!key.startsWith(PENDING_APPLY_KEY_PREFIX)) return null;
    return key.slice(PENDING_APPLY_KEY_PREFIX.length);
}

interface MetaReader {
    getMetaByPrefix<V = unknown>(
        prefix: string,
    ): Promise<Array<{ key: string; value: V }>>;
}

/** Load every pending-apply entry from the docs-store meta table. */
export async function loadAllPendingApply(db: MetaReader): Promise<PendingApplyRow[]> {
    const rows = await db.getMetaByPrefix<unknown>(PENDING_APPLY_KEY_PREFIX);
    const out: PendingApplyRow[] = [];
    for (const { key, value } of rows) {
        const id = pendingApplyIdFromKey(key);
        if (id === null) continue;
        const entry = parseEntry(value);
        if (entry) out.push({ id, entry });
    }
    return out;
}

/** Defensive parse — meta values are persisted JSON, so a malformed entry
 *  (manual edit, schema drift) shouldn't crash the load path. */
function parseEntry(raw: unknown): PendingApplyEntry | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Partial<PendingApplyEntry>;
    if (r.reason !== "missing-chunks" && r.reason !== "pending-deletion") return null;
    const addedAt = typeof r.addedAt === "number" ? r.addedAt : 0;
    const entry: PendingApplyEntry = { reason: r.reason, addedAt };
    if (Array.isArray(r.missingChunks) && r.missingChunks.every((c) => typeof c === "string")) {
        entry.missingChunks = [...r.missingChunks];
    }
    return entry;
}

export interface PendingApplyDeps {
    localDb: Pick<LocalDB, "getMetaByPrefix" | "get" | "runWriteTx">;
    /** Fetch the doc's missing chunks from the server when a live session
     *  exists; report what is still unavailable. */
    ensureChunks: (doc: FileDoc) => Promise<EnsureChunksResult>;
    /** Write a FileDoc to the vault (a live doc's content or a tombstone's
     *  deletion). */
    write: (doc: FileDoc) => Promise<WriteResult>;
    /** A recorded doc reached the vault. */
    onRecovered?: (path: string) => void;
    /** Tell the user once that a doc is broken. */
    notify?: (message: string) => void;
}

export class PendingApply {
    /** In-memory mirror of the persisted set; null until first loaded. Lets
     *  the drain of an empty set (the steady state) skip the meta read. */
    private entries: Map<string, PendingApplyEntry> | null = null;
    /** Failed drain attempts per id in this session, for the log only. */
    private readonly attempts = new Map<string, number>();
    private draining: Promise<ApplyReport> | null = null;

    constructor(private readonly deps: PendingApplyDeps) {}

    private async load(): Promise<Map<string, PendingApplyEntry>> {
        if (this.entries) return this.entries;
        const rows = await loadAllPendingApply(this.deps.localDb);
        this.entries = new Map(rows.map((r) => [r.id, r.entry]));
        return this.entries;
    }

    /** Ids recorded outside this object (the pull's pre-record, written in
     *  the same tx as the `remoteSeq` advance, replacing any earlier entry).
     *  Call after that tx commits, so the mirror matches what was written. */
    noteRecorded(added: Array<{ id: string; reason: PendingApplyReason }>): void {
        if (!this.entries) return; // not loaded yet: the next load reads them
        const now = Date.now();
        for (const { id, reason } of added) this.entries.set(id, { addedAt: now, reason });
    }

    /** Forget the in-memory mirror; the next use reads the persisted set.
     *  For a new session, which may follow a local DB rebuilt by Init or
     *  Clone. */
    invalidate(): void {
        this.entries = null;
        this.attempts.clear();
    }

    async has(id: string): Promise<boolean> {
        return (await this.load()).has(id);
    }

    /** Drop ids that reached the vault (or no longer need to). One tx. */
    async resolve(ids: string[]): Promise<void> {
        const entries = await this.load();
        const present = ids.filter((id) => entries.has(id));
        if (present.length === 0) return;
        await this.deps.localDb.runWriteTx({
            meta: present.map((id): MetaWrite => ({ op: "delete", key: pendingApplyKey(id) })),
        });
        for (const id of present) {
            entries.delete(id);
            this.attempts.delete(id);
        }
    }

    /** Record (or update) one id. Writes only when the entry changes, so a
     *  doc that stays broken costs no write per retry. Returns true when the
     *  doc became broken or its missing set changed. */
    private async record(
        id: string,
        reason: PendingApplyReason,
        missingChunks?: string[],
    ): Promise<boolean> {
        const entries = await this.load();
        const prev = entries.get(id);
        const next: PendingApplyEntry = {
            addedAt: prev?.addedAt ?? Date.now(),
            reason,
            ...(missingChunks ? { missingChunks: [...missingChunks] } : {}),
        };
        const unchanged = prev !== undefined
            && prev.reason === next.reason
            && sameIds(prev.missingChunks, next.missingChunks);
        if (unchanged) return false;
        await this.deps.localDb.runWriteTx({
            meta: [{ op: "put", key: pendingApplyKey(id), value: next }],
        });
        entries.set(id, next);
        return missingChunks !== undefined && !sameIds(prev?.missingChunks, missingChunks);
    }

    /**
     * Apply a live FileDoc to the vault: fetch its missing chunks, then
     * write. A doc that cannot be written is recorded; a recorded doc that
     * is written is dropped from the set. Never throws for a chunk miss or
     * a write failure — both are recorded and retried by the drain.
     */
    async apply(doc: FileDoc): Promise<ApplyOutcome> {
        const path = filePathFromId(doc._id);
        let res: EnsureChunksResult;
        try {
            res = await this.deps.ensureChunks(doc);
        } catch (e: any) {
            logDebug(`pending-apply: chunk fetch for ${path} failed: ${e?.message ?? e}`);
            await this.record(doc._id, "missing-chunks");
            return "skipped";
        }
        if (res.stillMissing.length > 0) {
            if (res.remoteConsulted) {
                if (await this.record(doc._id, "missing-chunks", res.stillMissing)) {
                    this.deps.notify?.(
                        `Quarantined "${path}" — ${res.stillMissing.length} chunk(s) missing ` +
                            `on this device and the server. It will recover automatically if ` +
                            `another device still has them.`,
                    );
                }
                return "quarantined";
            }
            await this.record(doc._id, "missing-chunks");
            return "skipped";
        }
        try {
            await this.deps.write(doc);
        } catch (e: any) {
            logError(`pending-apply: vault write failed: ${path}: ${e?.message ?? e}`);
            await this.record(doc._id, "missing-chunks");
            return "skipped";
        }
        // Written, or declined for a reason that is not a missing chunk (IME
        // composition, filtered path, a vault change not yet synced, which
        // the reconcile offers as a conflict): either way the doc no longer
        // waits for chunks.
        if (await this.has(doc._id)) {
            await this.resolve([doc._id]);
            this.deps.onRecovered?.(path);
        }
        return "applied";
    }

    /**
     * Retry every recorded doc. Concurrent callers (the pull loop and a
     * reconcile) share one run. Cheap when the set is empty.
     */
    drain(): Promise<ApplyReport> {
        if (!this.draining) {
            this.draining = this.runDrain().finally(() => { this.draining = null; });
        }
        return this.draining;
    }

    private async runDrain(): Promise<ApplyReport> {
        const report: ApplyReport = { applied: [], quarantined: [], skipped: [] };
        const entries = await this.load();
        if (entries.size === 0) return report;

        const moot: string[] = [];
        for (const [id, entry] of [...entries]) {
            const doc = await this.deps.localDb.get<FileDoc>(id);
            const path = filePathFromId(id);

            if (entry.reason === "pending-deletion") {
                // The durable tombstone must still be a deletion. If the doc
                // is gone or superseded by a live edit, the deletion is moot.
                if (!doc || !isFileDoc(doc) || !doc.deleted) {
                    moot.push(id);
                    continue;
                }
                try {
                    const result = await this.deps.write(doc);
                    await this.resolve([id]);
                    logDebug(`  ← ${path} (pending-deletion ${result.applied === false ? `skipped: ${result.reason}` : "recovered"})`);
                    report.applied.push(path);
                } catch {
                    this.bumpAttempt(id, `pending-deletion: ${path} re-apply failed`);
                    report.skipped.push(path);
                }
                continue;
            }

            // "missing-chunks": nothing to apply unless the doc is still live.
            if (!doc || !isFileDoc(doc) || doc.deleted) {
                moot.push(id);
                continue;
            }
            const outcome = await this.apply(doc);
            if (outcome === "applied") {
                logDebug(`  ← ${path} (pending-apply recovered)`);
                report.applied.push(path);
            } else {
                this.bumpAttempt(id, `pending-apply: ${path} still missing chunks`);
                (outcome === "quarantined" ? report.quarantined : report.skipped).push(path);
            }
        }
        await this.resolve(moot);
        return report;
    }

    private bumpAttempt(id: string, message: string): void {
        const n = (this.attempts.get(id) ?? 0) + 1;
        this.attempts.set(id, n);
        logDebug(`${message} (attempt ${n})`);
    }
}

/** Paths a drain touched, by outcome. */
export interface ApplyReport {
    applied: string[];
    quarantined: string[];
    skipped: string[];
}

function sameIds(a: string[] | undefined, b: string[] | undefined): boolean {
    if (a === undefined || b === undefined) return a === b;
    return a.length === b.length && a.every((id, i) => id === b[i]);
}
