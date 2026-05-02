/**
 * EchoTracker — pull-echo suppression for the push pipeline.
 *
 * After the pull-writer commits pulled docs to localDb, those writes
 * surface in the push loop's local-changes feed. We compare each local
 * change's seq to the seq captured at pull-write time: any change with
 * seq <= recorded is the pull echo and must not be pushed back; seq >
 * recorded is a genuine post-pull user edit.
 *
 * Push-echo suppression used to live here too, as a session-scoped
 * `recentlyPushed` Map. That structure had a R1b-class race: a session
 * teardown between push completion and the next pull longpoll dropped
 * the in-memory marks, so the new session's catchup re-delivered the
 * self-pushed docs and the resolver hit `equal vclock → keep-local`.
 * The replacement is data-level: pull-writer compares local vs remote
 * vclock and skips on `equal` directly. No echo bookkeeping needed.
 *
 * The TTL is a safety net for pullWritten: if a doc somehow escapes the
 * ordinary consumption path (remote rewrite, network glitch), the entry
 * expires instead of leaking forever.
 */

interface PullWriteRecord {
    /** localDb updateSeq immediately after bulkPut. */
    seq: number;
    /** Date.now() at insertion — used for TTL-based cleanup. */
    addedAt: number;
}

export class EchoTracker {
    /** TTL for pull-echo records — matches pre-refactor PULL_WRITTEN_TTL_MS. */
    static readonly DEFAULT_TTL_MS = 60_000;

    private pullWritten = new Map<string, PullWriteRecord>();

    constructor(private readonly ttlMs: number = EchoTracker.DEFAULT_TTL_MS) {}

    /** Record that pull wrote these doc IDs at the given localDb seq. */
    recordPullWrites(ids: string[], seq: number): void {
        const now = Date.now();
        for (const id of ids) {
            this.pullWritten.set(id, { seq, addedAt: now });
        }
    }

    /**
     * Should a local change be suppressed as a pull echo? Returns true
     * when the change's seq does not exceed the recorded pull seq.
     */
    isPullEcho(id: string, changeSeq: number): boolean {
        const record = this.pullWritten.get(id);
        if (!record) return false;
        return changeSeq <= record.seq;
    }

    /**
     * Clean up after a push loop iteration: the push loop saw these IDs
     * (so their pull-echo decision is already made), and any TTL-expired
     * pull-echo entries should go.
     */
    sweepPullWritten(seenIds: Iterable<string>): void {
        for (const id of seenIds) {
            this.pullWritten.delete(id);
        }
        const now = Date.now();
        for (const [id, rec] of this.pullWritten) {
            if (now - rec.addedAt > this.ttlMs) {
                this.pullWritten.delete(id);
            }
        }
    }

    /** Drop everything — called on session teardown. */
    clear(): void {
        this.pullWritten.clear();
    }

    /** @internal test helper */
    sizePullWritten(): number { return this.pullWritten.size; }
}
