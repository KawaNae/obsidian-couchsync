/**
 * Vector Clock — causal ordering primitive.
 *
 * Each device maintains a monotonically increasing counter. A document's
 * vclock is a map of deviceId → counter. Two clocks compare by taking the
 * per-key max over the union of keys (missing keys are 0) and asking:
 *
 *   - every a[k] >= b[k] AND at least one >  → a dominates b
 *   - symmetric                               → a dominated by b
 *   - every a[k] == b[k]                      → equal
 *   - mixed (some greater, some less)         → concurrent (true conflict)
 *
 * Only `concurrent` requires human resolution; dominated writes are safely
 * superseded by their dominator. Physical timestamps are never consulted.
 */

export type VectorClock = Record<string, number>;

export type VCRelation = "equal" | "dominates" | "dominated" | "concurrent";

export function compareVC(a: VectorClock, b: VectorClock): VCRelation {
    let anyGreater = false;
    let anyLess = false;
    const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
        const av = a[k] ?? 0;
        const bv = b[k] ?? 0;
        if (av > bv) anyGreater = true;
        else if (av < bv) anyLess = true;
    }
    if (anyGreater && anyLess) return "concurrent";
    if (anyGreater) return "dominates";
    if (anyLess) return "dominated";
    return "equal";
}

export function mergeVC(a: VectorClock, b: VectorClock): VectorClock {
    const out: VectorClock = {};
    const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
        out[k] = Math.max(a[k] ?? 0, b[k] ?? 0);
    }
    return out;
}

export function incrementVC(
    base: VectorClock | undefined,
    deviceId: string,
): VectorClock {
    const out: VectorClock = { ...(base ?? {}) };
    out[deviceId] = (out[deviceId] ?? 0) + 1;
    return out;
}

/**
 * Given a list of clocks (typically all conflicting revisions of a doc),
 * return the one that dominates or equals every other. Returns null if
 * any pair is concurrent — that requires manual resolution.
 */
export function findDominator<T extends { vclock?: VectorClock } | VectorClock>(
    items: T[],
): T | null {
    if (items.length === 0) return null;
    if (items.length === 1) return items[0];

    const vcOf = (x: T): VectorClock =>
        (x as { vclock?: VectorClock }).vclock ?? (x as VectorClock);

    for (const candidate of items) {
        const cvc = vcOf(candidate);
        let dominatesAll = true;
        for (const other of items) {
            if (other === candidate) continue;
            const ovc = vcOf(other);
            const rel = compareVC(cvc, ovc);
            if (rel === "dominated" || rel === "concurrent") {
                dominatesAll = false;
                break;
            }
        }
        if (dominatesAll) return candidate;
    }
    return null;
}

/**
 * The device whose counter is highest in the clock — used to answer
 * "who made the most recent write?" without consulting wall-clock time.
 * Returns null for an empty clock. Ties are broken by insertion order
 * (i.e. whichever key iterates first).
 */
export function latestDevice(vc: VectorClock): string | null {
    let best: string | null = null;
    let bestCount = -1;
    for (const [device, count] of Object.entries(vc)) {
        if (count > bestCount) {
            best = device;
            bestCount = count;
        }
    }
    return best;
}
