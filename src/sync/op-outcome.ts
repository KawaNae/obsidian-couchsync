/**
 * op-outcome.ts — how the one-shot operations and checks on one sync
 * target ended, kept for the settings tab's status line.
 *
 * A binding (the vault's or a config DB's) owns one ledger. The ledger
 * keeps two slots: the last user operation (Init, Push, Join, …) and the
 * last check (a read-only probe the plugin runs by itself). They are kept
 * apart because a check only reads: its success says nothing about whether
 * a write that failed would now go through.
 *
 * Rules:
 *
 *   - In its slot, an outcome replaces the recorded one only when it
 *     started no earlier — an overtaken result is older news.
 *   - A failed operation is cleared only by a later operation that
 *     succeeds.
 *   - A failed check is cleared by a later check that succeeds, or by a
 *     later operation that succeeds: every operation reached the server and
 *     read what the check reads.
 *   - Every outcome names the target it was evaluated against
 *     (`against`, a fingerprint the binding chooses). `view` only returns
 *     outcomes about the target given, so a result about another DB, root
 *     or server never describes the current one.
 *
 * In memory only: after a reload the outcomes are unknown until the next
 * operation or check.
 */

export interface OpOutcome<Op extends string> {
    op: Op;
    /** When the operation or check started (ms since epoch). */
    at: number;
    /** Fingerprint of the target it was evaluated against, or null when
     *  there was none (e.g. a config device not joined). */
    against: string | null;
    /** What it threw, or null on success. */
    error: unknown | null;
}

export interface OutcomeView<Op extends string> {
    lastOp: OpOutcome<Op> | null;
    lastCheck: OpOutcome<Op> | null;
}

export class OutcomeLedger<Op extends string> {
    private lastOp: OpOutcome<Op> | null = null;
    private lastCheck: OpOutcome<Op> | null = null;

    /** @param isCheck which outcomes go into the check slot. */
    constructor(private readonly isCheck: (op: Op) => boolean) {}

    record(o: OpOutcome<Op>): void {
        if (this.isCheck(o.op)) {
            if (this.lastCheck && o.at < this.lastCheck.at) return;
            this.lastCheck = o;
            return;
        }
        if (this.lastOp && o.at < this.lastOp.at) return;
        this.lastOp = o;
        if (o.error === null && this.lastCheck?.error && this.lastCheck.at <= o.at) {
            this.lastCheck = null;
        }
    }

    /** The recorded outcomes evaluated against `against`. */
    view(against: string | null): OutcomeView<Op> {
        const current = (o: OpOutcome<Op> | null) => (o && o.against === against ? o : null);
        return { lastOp: current(this.lastOp), lastCheck: current(this.lastCheck) };
    }
}
