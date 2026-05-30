/**
 * Checkpoints — persistent sync progress markers and pull-batch atomic commit owner.
 *
 * Survives across sessions: session N consumes/advances, session N+1
 * reads the final state. SyncEngine owns the instance; it loads once
 * at startup and passes the ref to each SyncSession.
 *
 * The atomic storage boundary lives here: a pull batch lands accepted
 * docs + the new META_REMOTE_SEQ in a single `runWriteTx`, and the
 * in-memory `remoteSeq` is advanced inside the same `onCommit` so the
 * durable write, the cached cursor, and the caller's side effects are
 * observable together or not at all.
 */

import type { CouchSyncDoc } from "../../types.ts";
import type { LocalDB } from "../local-db.ts";
import type { MetaWrite } from "../write-transaction.ts";
import { logDebug } from "../../ui/log.ts";
import { unpushedKey, type UnpushedEntry, type UnpushedReason } from "./unpushed-ids.ts";
import {
    pendingApplyKey, type PendingApplyEntry, type PendingApplyReason,
} from "./pending-apply.ts";
import {
    pendingConflictKey, type PendingConflictEntry, type PendingConflictKind,
} from "./pending-conflict.ts";

export const META_REMOTE_SEQ = "_sync/remote-seq";
export const META_PUSH_SEQ = "_sync/push-seq";

export class Checkpoints {
    private remoteSeq: number | string = 0;
    private lastPushedSeq: number | string = 0;

    constructor(private localDb: LocalDB) {}

    getRemoteSeq(): number | string { return this.remoteSeq; }
    getLastPushedSeq(): number | string { return this.lastPushedSeq; }
    setRemoteSeq(s: number | string): void { this.remoteSeq = s; }
    setLastPushedSeq(s: number | string): void { this.lastPushedSeq = s; }

    async load(): Promise<void> {
        let remote = await this.localDb.getMeta<number | string>(META_REMOTE_SEQ);
        let push = await this.localDb.getMeta<number | string>(META_PUSH_SEQ);

        if (remote === null && push === null) {
            // Legacy: migrate from metaStore (pre-v0.13 location).
            const legacyRemote = await this.localDb.getMetaStoreValue<number | string>(META_REMOTE_SEQ);
            const legacyPush = await this.localDb.getMetaStoreValue<number | string>(META_PUSH_SEQ);
            if (legacyRemote !== null || legacyPush !== null) {
                const meta: Array<{ op: "put"; key: string; value: unknown }> = [];
                if (legacyRemote !== null) meta.push({ op: "put", key: META_REMOTE_SEQ, value: legacyRemote });
                if (legacyPush !== null) meta.push({ op: "put", key: META_PUSH_SEQ, value: legacyPush });
                await this.localDb.runWriteTx({ meta });
                await this.localDb.runMetaWriteTx({
                    meta: [
                        { op: "delete", key: META_REMOTE_SEQ },
                        { op: "delete", key: META_PUSH_SEQ },
                    ],
                });
                remote = legacyRemote;
                push = legacyPush;
                logDebug("checkpoints migrated from legacy metaStore");
            }
        }

        this.remoteSeq = remote ?? 0;
        this.lastPushedSeq = push ?? 0;
        logDebug(`checkpoints loaded: remoteSeq=${this.remoteSeq} pushSeq=${this.lastPushedSeq}`);
    }

    async save(): Promise<void> {
        await this.localDb.runWriteTx({
            meta: [
                { op: "put", key: META_REMOTE_SEQ, value: this.remoteSeq },
                { op: "put", key: META_PUSH_SEQ, value: this.lastPushedSeq },
            ],
        });
    }

    /**
     * Commit a pull batch: docs + new remoteSeq (+ optional pending-apply
     * adds) in a single atomic tx. The in-memory `remoteSeq` is advanced
     * at the start of `onCommit` (inside the tx boundary) before the
     * caller's `onCommit` fires, so downstream side effects always observe
     * a consistent cursor.
     *
     * `pendingApplyAdd` carries the file-doc ids whose chunks are not yet
     * local (so their vault apply, attempted in `onCommit` AFTER this tx
     * durably commits, may fail). Recording them in the SAME tx as the
     * `remoteSeq` advance is the load-bearing half of Invariant B: the
     * cursor can never move past a file that isn't either applied or
     * remembered for retry. The caller removes the ids that apply cleanly
     * (post-commit), leaving only genuine misses in the set.
     */
    async commitPullBatch(params: {
        docs: CouchSyncDoc[];
        nextRemoteSeq: number | string;
        /** File-doc ids whose vault apply may fail post-commit, with the reason
         *  so the drain re-applies correctly (missing-chunks → re-fetch+write;
         *  pending-deletion → re-apply the deletion). */
        pendingApplyAdd?: Array<{ id: string; reason: PendingApplyReason }>;
        /** File-doc ids whose deletion-vs-edit conflict (either direction) must
         *  be persisted in the SAME tx as the cursor advance (Invariant B for
         *  the deletion-conflict class — see pending-conflict.ts). */
        pendingConflictAdd?: Array<{ id: string; kind: PendingConflictKind }>;
        onCommit: () => Promise<void>;
    }): Promise<void> {
        const meta: MetaWrite[] = [
            { op: "put", key: META_REMOTE_SEQ, value: params.nextRemoteSeq },
        ];
        const now = Date.now();
        for (const { id, reason } of params.pendingApplyAdd ?? []) {
            const entry: PendingApplyEntry = { addedAt: now, reason, attempts: 0 };
            meta.push({ op: "put", key: pendingApplyKey(id), value: entry });
        }
        for (const { id, kind } of params.pendingConflictAdd ?? []) {
            const entry: PendingConflictEntry = { addedAt: now, kind };
            meta.push({ op: "put", key: pendingConflictKey(id), value: entry });
        }
        await this.localDb.runWriteTx({
            docs: params.docs.map((d) => ({ doc: d })),
            meta,
            onCommit: async () => {
                this.remoteSeq = params.nextRemoteSeq;
                await params.onCommit();
            },
        });
    }

    /**
     * Add and/or remove pending-apply entries (Invariant B). Used by the
     * post-commit cleanup (remove the ids that applied cleanly) and by the
     * drain (remove resolved ids, re-add still-missing ones with a bumped
     * attempt count). A standalone tx — not paired with a cursor advance,
     * because by the time we know an apply outcome the cursor has already
     * committed; the pre-record in `commitPullBatch` is what bounds the
     * cursor. Removing an absent key is a harmless no-op.
     */
    async commitPendingApply(params: {
        add?: Array<{ id: string; reason: PendingApplyReason; attempts: number }>;
        remove?: string[];
    }): Promise<void> {
        const meta: MetaWrite[] = [];
        for (const id of params.remove ?? []) {
            meta.push({ op: "delete", key: pendingApplyKey(id) });
        }
        const now = Date.now();
        for (const { id, reason, attempts } of params.add ?? []) {
            const entry: PendingApplyEntry = { addedAt: now, reason, attempts };
            meta.push({ op: "put", key: pendingApplyKey(id), value: entry });
        }
        if (meta.length === 0) return;
        await this.localDb.runWriteTx({ meta });
    }

    /**
     * Advance the remote checkpoint for a batch that produced no accepted
     * docs (empty fetch, or every row skipped by echo/keep-local). Persists
     * both seqs so the on-disk cursor matches in-memory state.
     */
    async saveEmptyPullBatch(
        nextRemoteSeq: number | string,
        pendingConflictAdd?: Array<{ id: string; kind: PendingConflictKind }>,
    ): Promise<void> {
        const meta: MetaWrite[] = [
            { op: "put", key: META_REMOTE_SEQ, value: nextRemoteSeq },
        ];
        // A delete-only batch produces no accepted docs but may still carry a
        // deletion-vs-edit conflict (either direction). Persist it in the SAME
        // tx as the cursor advance so the conflict survives a missed modal /
        // restart (Invariant B for the deletion-conflict class).
        const now = Date.now();
        for (const { id, kind } of pendingConflictAdd ?? []) {
            const entry: PendingConflictEntry = { addedAt: now, kind };
            meta.push({ op: "put", key: pendingConflictKey(id), value: entry });
        }
        await this.localDb.runWriteTx({
            meta,
            onCommit: () => { this.remoteSeq = nextRemoteSeq; },
        });
    }

    /**
     * Commit one push-pipeline cycle: advance `lastPushedSeq` and update
     * the unpushed-id set in a single atomic tx. Cursor advance is
     * unconditional — the set carries any ids that need to be retried.
     *
     * Without this pairing a crash between cursor write and set write
     * would leak the old silent-loss path (cursor moved past an id that
     * never made the retry set). Bundling them keeps the post-refactor
     * invariant: "an id is unpushed iff its meta entry exists, and the
     * cursor reflects every cycle that did or did not cover it."
     *
     * `unpushedAdd` and `unpushedRemove` may overlap (same id seen as
     * resolved earlier in the cycle and re-flagged at the end); the
     * caller is responsible for de-duplicating, but we apply removes
     * before adds so an in-cycle re-flag wins.
     */
    async commitPushCycle(params: {
        nextPushSeq: number | string;
        unpushedAdd: Array<{ id: string; reason: UnpushedReason; attempts: number }>;
        unpushedRemove: string[];
    }): Promise<void> {
        const meta: MetaWrite[] = [
            { op: "put", key: META_PUSH_SEQ, value: params.nextPushSeq },
        ];
        for (const id of params.unpushedRemove) {
            meta.push({ op: "delete", key: unpushedKey(id) });
        }
        const now = Date.now();
        for (const { id, reason, attempts } of params.unpushedAdd) {
            const entry: UnpushedEntry = { addedAt: now, reason, attempts };
            meta.push({ op: "put", key: unpushedKey(id), value: entry });
        }
        await this.localDb.runWriteTx({
            meta,
            onCommit: async () => {
                this.lastPushedSeq = params.nextPushSeq;
            },
        });
    }
}
