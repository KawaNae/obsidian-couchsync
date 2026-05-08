/**
 * ConfigCheckpoints — sync progress markers for the config DB.
 *
 * Mirror of `Checkpoints` (`src/db/sync/checkpoints.ts`) for the vault
 * sync, but against `ConfigLocalDB`. Holds the next-cursor for both
 * directions:
 *   - `pullSeq`: last `_changes` cursor consumed by ConfigPullWriter
 *   - `pushSeq`: last LocalDB.changes cursor pushed by ConfigPushPipeline
 *
 * Persisted under `_sync/config-pull-seq` / `_sync/config-push-seq` in
 * the ConfigLocalDB meta store. No legacy migration: pre-PR2 users have
 * no checkpoint stored, so `load()` leaves the in-memory cursors at 0
 * and the first ConfigPullWriter run does a full catchup from `since=0`
 * (== current `pullByPrefix` semantics — backwards compatible).
 *
 * The atomic boundary lives here: a pull batch lands accepted docs +
 * the new pull-seq in a single `runWriteTx`, and `pullSeq` is advanced
 * inside `onCommit` so callers always observe a consistent cursor.
 */

import type { CouchSyncDoc } from "../../types.ts";
import type { ConfigLocalDB } from "../config-local-db.ts";
import { logDebug } from "../../ui/log.ts";

export const META_CONFIG_PULL_SEQ = "_sync/config-pull-seq";
export const META_CONFIG_PUSH_SEQ = "_sync/config-push-seq";

export class ConfigCheckpoints {
    private pullSeq: number | string = 0;
    private pushSeq: number | string = 0;

    constructor(private db: ConfigLocalDB) {}

    getPullSeq(): number | string { return this.pullSeq; }
    getPushSeq(): number | string { return this.pushSeq; }
    setPullSeq(s: number | string): void { this.pullSeq = s; }
    setPushSeq(s: number | string): void { this.pushSeq = s; }

    async load(): Promise<void> {
        const pull = await this.db.getMeta<number | string>(META_CONFIG_PULL_SEQ);
        const push = await this.db.getMeta<number | string>(META_CONFIG_PUSH_SEQ);
        if (pull !== null) this.pullSeq = pull;
        if (push !== null) this.pushSeq = push;
        logDebug(
            `config-checkpoints loaded: pullSeq=${this.pullSeq} pushSeq=${this.pushSeq}`,
        );
    }

    async save(): Promise<void> {
        await this.db.runWriteTx({
            meta: [
                { op: "put", key: META_CONFIG_PULL_SEQ, value: this.pullSeq },
                { op: "put", key: META_CONFIG_PUSH_SEQ, value: this.pushSeq },
            ],
        });
    }

    /**
     * Commit a pull batch atomically: accepted docs + the new pullSeq
     * land in a single `runWriteTx`. The in-memory `pullSeq` is advanced
     * at the start of `onCommit` (inside the tx boundary) before the
     * caller's `onCommit` fires.
     */
    async commitPullBatch(params: {
        docs: CouchSyncDoc[];
        nextPullSeq: number | string;
        onCommit: () => Promise<void>;
    }): Promise<void> {
        await this.db.runWriteTx({
            docs: params.docs.map((d) => ({ doc: d as CouchSyncDoc })),
            meta: [{ op: "put", key: META_CONFIG_PULL_SEQ, value: params.nextPullSeq }],
            onCommit: async () => {
                this.pullSeq = params.nextPullSeq;
                await params.onCommit();
            },
        });
    }

    /**
     * Advance the pull checkpoint for a batch that produced no accepted
     * docs (empty fetch, every row converged-skip). Persists the in-memory
     * cursor change to disk.
     */
    async saveEmptyPullBatch(nextPullSeq: number | string): Promise<void> {
        this.pullSeq = nextPullSeq;
        await this.save();
    }
}
