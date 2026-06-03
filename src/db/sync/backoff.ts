/**
 * BackoffSchedule — pure backoff step tracker.
 *
 * Knows two things: which delay to hand out next, and how to advance /
 * reset the step index. No timers, no callbacks, no I/O. The retry
 * executor (SyncEngine) owns the `setTimeout`.
 *
 * Reset is intentionally explicit: only `recordSuccess()` winds the step
 * back to 0. State-machine transitions never reach in here — that was
 * the structural root cause of "step stuck at 0" in v0.15.1~v0.19.0.
 */

/** Fibonacci retry cadence (ms). Tuned for mobile: a fast first retry is
 *  critical for data safety — the sooner a resumed device reconnects, the
 *  sooner local edits flush and remote edits land. Starting at 1s (instead
 *  of the old 2s) and growing gently (1,1,2,3,5,8,13,21) keeps the
 *  transient-blip recovery near-instant while still backing off for a
 *  genuinely down server. Capped at 21s by `nextDelay()`'s clamp. */
const DEFAULT_DELAYS_MS: readonly number[] = [
    1_000, 1_000, 2_000, 3_000, 5_000, 8_000, 13_000, 21_000,
];

export class BackoffSchedule {
    private step = 0;

    constructor(private readonly delays: readonly number[] = DEFAULT_DELAYS_MS) {
        if (delays.length === 0) {
            throw new Error("BackoffSchedule requires a non-empty delay table");
        }
    }

    /** Delay (ms) for the current step. Capped at the last table entry. */
    nextDelay(): number {
        const idx = Math.min(this.step, this.delays.length - 1);
        return this.delays[idx];
    }

    /** Advance the step by one. Clamping happens in `nextDelay()`. */
    recordFailure(): void {
        this.step++;
    }

    /** Reset the step to 0. The only path that resets the schedule. */
    recordSuccess(): void {
        this.step = 0;
    }

    get currentStep(): number {
        return this.step;
    }
}
