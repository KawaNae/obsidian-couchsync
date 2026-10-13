/**
 * ConfigCheckpoints — the pull cursor of the config DB.
 *
 * `pullSeq` is the last remote `_changes` cursor ConfigPullWriter consumed,
 * persisted under `_sync/config-pull-seq` in the ConfigLocalDB meta store.
 * A store without it starts from 0 (a full catch-up).
 *
 * Push has no cursor: what it sends is the disk's difference from the base
 * (`config-reconcile.ts`), and the config DB is written only after the
 * server accepted a doc, so nothing unsent waits in the store.
 *
 * The atomic boundary lives with the writers: a pull batch lands its docs
 * and the new pull-seq in a single `runWriteTx`, and `pullSeq` is advanced
 * inside `onCommit` so callers always observe a consistent cursor.
 */

import type { ConfigLocalDB } from "../config-local-db.ts";
import { logDebug } from "../../ui/log.ts";

export const META_CONFIG_PULL_SEQ = "_sync/config-pull-seq";

export class ConfigCheckpoints {
    private pullSeq: number | string = 0;

    constructor(private db: ConfigLocalDB) {}

    getPullSeq(): number | string { return this.pullSeq; }
    setPullSeq(s: number | string): void { this.pullSeq = s; }

    async load(): Promise<void> {
        const pull = await this.db.getMeta<number | string>(META_CONFIG_PULL_SEQ);
        // Authoritative reload: load() reflects disk truth, so an ABSENT
        // checkpoint resets the in-memory cursor to 0 rather than keeping a
        // stale value. This matters when the same long-lived instance is
        // reloaded after a config Create destroyed the DB (invalidateCheckpoints
        // → load). Symmetric with vault-side Checkpoints (`remote ?? 0`).
        this.pullSeq = pull ?? 0;
        logDebug(`config-checkpoints loaded: pullSeq=${this.pullSeq}`);
    }

    async save(): Promise<void> {
        await this.db.runWriteTx({
            meta: [{ op: "put", key: META_CONFIG_PULL_SEQ, value: this.pullSeq }],
        });
    }

    /**
     * Advance the pull checkpoint for a batch that produced no docs (empty
     * fetch, a seq-regression reset). Persists the in-memory cursor change.
     */
    async saveEmptyPullBatch(nextPullSeq: number | string): Promise<void> {
        // No-op guard, symmetric to the vault-side Checkpoints. Sound
        // because every `pullSeq` mutation is disk-coupled: load() reads
        // disk, and both commit paths (the tx below, the pull-writer's
        // batch tx) assign it inside onCommit of a tx that persists the
        // same value — memory == disk always holds here.
        if (nextPullSeq === this.pullSeq) return;
        await this.db.runWriteTx({
            meta: [{ op: "put", key: META_CONFIG_PULL_SEQ, value: nextPullSeq }],
            onCommit: () => { this.pullSeq = nextPullSeq; },
        });
    }
}
