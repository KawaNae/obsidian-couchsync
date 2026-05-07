import type { VectorClock } from "./vector-clock.ts";

/**
 * The last known integration point for a path.
 *
 * `vclock` records the causality at integration; `chunks` + `size` record
 * the *content* at integration. Together they let the reconciler decide
 * whether a "remote-pending" file is pure stale (vault matches the last
 * integration baseline → safe to apply remote) or a divergent local edit
 * (vault drifted → must be routed to conflict orchestrator).
 *
 * Legacy entries written before the chunks/size extension carry only
 * `vclock`; the consumers (compareFileToDoc, reconciler divergent check)
 * treat undefined chunks/size as "skip the divergent-edit guard for
 * this path until the next push/pull rewrites it in the full shape".
 */
export interface LastSynced {
    vclock: VectorClock;
    chunks?: string[];
    size?: number;
}

/** Parse a raw on-disk meta value into a `LastSynced`. Accepts both the
 *  new `{vclock, chunks, size}` shape and the legacy raw `VectorClock`
 *  shape (any object whose keys are device IDs, no `vclock` key). */
export function parseStoredLastSynced(value: unknown): LastSynced {
    if (value && typeof value === "object" && "vclock" in (value as object)) {
        const v = value as { vclock: VectorClock; chunks?: string[]; size?: number };
        return { vclock: v.vclock, chunks: v.chunks, size: v.size };
    }
    // Legacy raw VectorClock — treat the whole object as the vclock.
    return { vclock: (value ?? {}) as VectorClock };
}
