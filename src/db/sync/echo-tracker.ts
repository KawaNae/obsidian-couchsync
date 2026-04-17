/**
 * EchoTracker — unifies the two echo-suppression concepts that used to
 * live in SyncEngine as separate structures:
 *
 *   1. Pull-echo suppression (`pullWrittenIds`, seq-indexed Map).
 *      After writing pulled docs to localDB, the push loop must not
 *      send those same docs back to the server. We compare the local
 *      change's seq to the seq captured at pull-write time: any change
 *      with seq <= recorded is the pull echo; seq > recorded is a
 *      genuine post-pull user edit that must be pushed.
 *
 *   2. Push-echo suppression (`recentlyPushedIds`, Set).
 *      After pushing a doc, it comes back via the _changes feed. Mark
 *      it as "we just pushed this" so the pull writer skips logging it.
 *      These are consumed on first pull-return.
 *
 * Both apply a TTL as a safety net: if a doc somehow escapes the
 * ordinary consumption path (remote rewrite, network glitch), the
 * entry expires instead of leaking forever.
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
    /**
     * Push echoes carry an insertion timestamp so the TTL sweep can
     * expire stragglers (prior implementation was a bare Set that could
     * leak a doc forever if its pull echo never arrived).
     */
    private recentlyPushed = new Map<string, number>();

    constructor(private readonly ttlMs: number = EchoTracker.DEFAULT_TTL_MS) {}

    // ── Pull-echo API ────────────────────────────────────────

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

    // ── Push-echo API ────────────────────────────────────────

    /** Mark that we just successfully pushed this doc. */
    recordPushEcho(id: string): void {
        this.recentlyPushed.set(id, Date.now());
    }

    /**
     * Consume the push-echo mark. Returns true if the doc was marked
     * (and clears the mark) — caller should skip pull-logging for it.
     * Also sweeps stale entries so a stuck mark can't live forever.
     */
    consumePushEcho(id: string): boolean {
        const hit = this.recentlyPushed.delete(id);
        const now = Date.now();
        for (const [k, addedAt] of this.recentlyPushed) {
            if (now - addedAt > this.ttlMs) {
                this.recentlyPushed.delete(k);
            }
        }
        return hit;
    }

    // ── Lifecycle ────────────────────────────────────────────

    /** Drop everything — called on session teardown. */
    clear(): void {
        this.pullWritten.clear();
        this.recentlyPushed.clear();
    }

    // ── Introspection (tests) ────────────────────────────────

    /** @internal test helper */
    sizePullWritten(): number { return this.pullWritten.size; }
    /** @internal test helper */
    sizeRecentlyPushed(): number { return this.recentlyPushed.size; }
}
