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
import { logDebug } from "../../ui/log.ts";

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

        if (remote !== null) this.remoteSeq = remote;
        if (push !== null) this.lastPushedSeq = push;
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
     * Commit a pull batch: docs + new remoteSeq in a single atomic tx.
     * The in-memory `remoteSeq` is advanced at the start of `onCommit`
     * (inside the tx boundary) before the caller's `onCommit` fires, so
     * downstream side effects always observe a consistent cursor.
     */
    async commitPullBatch(params: {
        docs: CouchSyncDoc[];
        nextRemoteSeq: number | string;
        onCommit: () => Promise<void>;
    }): Promise<void> {
        await this.localDb.runWriteTx({
            docs: params.docs.map((d) => ({ doc: d })),
            meta: [{ op: "put", key: META_REMOTE_SEQ, value: params.nextRemoteSeq }],
            onCommit: async () => {
                this.remoteSeq = params.nextRemoteSeq;
                await params.onCommit();
            },
        });
    }

    /**
     * Advance the remote checkpoint for a batch that produced no accepted
     * docs (empty fetch, or every row skipped by echo/keep-local). Persists
     * both seqs so the on-disk cursor matches in-memory state.
     */
    async saveEmptyPullBatch(nextRemoteSeq: number | string): Promise<void> {
        this.remoteSeq = nextRemoteSeq;
        await this.save();
    }
}
