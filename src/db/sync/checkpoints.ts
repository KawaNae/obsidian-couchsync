/**
 * Checkpoints — persistent sync progress markers.
 *
 * Survives across sessions: session N consumes/advances, session N+1
 * reads the final state. SyncEngine owns the instance; it loads once
 * at startup and passes the ref to each SyncSession.
 *
 * The atomic storage boundary is maintained: meta lives in the docs
 * store (same `runWriteTx` boundary as pulled docs), so a pull batch
 * commits both accepted docs and the new remoteSeq together.
 */

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
        const docsStore = this.localDb.getStore();
        let remote = await docsStore.getMeta<number | string>(META_REMOTE_SEQ);
        let push = await docsStore.getMeta<number | string>(META_PUSH_SEQ);

        if (remote === null && push === null) {
            // Legacy: migrate from metaStore (pre-v0.13 location).
            const legacy = this.localDb.getMetaStore();
            const legacyRemote = await legacy.getMeta<number | string>(META_REMOTE_SEQ);
            const legacyPush = await legacy.getMeta<number | string>(META_PUSH_SEQ);
            if (legacyRemote !== null || legacyPush !== null) {
                const meta: Array<{ op: "put"; key: string; value: unknown }> = [];
                if (legacyRemote !== null) meta.push({ op: "put", key: META_REMOTE_SEQ, value: legacyRemote });
                if (legacyPush !== null) meta.push({ op: "put", key: META_PUSH_SEQ, value: legacyPush });
                await docsStore.runWriteTx({ meta });
                await legacy.runWriteTx({
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
        await this.localDb.getStore().runWriteTx({
            meta: [
                { op: "put", key: META_REMOTE_SEQ, value: this.remoteSeq },
                { op: "put", key: META_PUSH_SEQ, value: this.lastPushedSeq },
            ],
        });
    }
}
