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
 *
 * `deleted` (Invariant 7 — deletion is an integration event): set when the
 * last integrated doc state for this path was a tombstone. The fingerprint
 * is normalized to `chunks: [], size: 0` on write. Without this flag a
 * deletion erased the baseline entirely, which destroyed the causal anchor
 * the recreate-after-delete path needs (the 2026-06-07 W24 stuck-push bug).
 * A deleted baseline shares the lifetime of the tombstone doc itself —
 * neither is pruned today; a future tombstone GC must issue the matching
 * `vclocks: [{path, op: "delete"}]` in the same sweep. `op: "delete"` is
 * reserved for "no doc exists at all" (no causal information to keep).
 *
 * `mtime` is the disk mtime THIS DEVICE observed at integration — never
 * `FileDoc.mtime`, which is the sender's mtime and meaningless against
 * the local filesystem. An exact `(mtime, size)` stat match is treated as
 * evidence that `chunks` is still a valid fingerprint of the disk
 * content, letting hot paths skip readBinary + re-hash. This trust model
 * is the same one the reconcile fast-path already applies vault-wide via
 * its mtime threshold; consumers needing a stronger guarantee (the
 * destructive-judgment oracle `hasUnpushedChanges`) must hash for real.
 * Entries written before this field carry undefined → cache miss → the
 * next integration (or a reconcile align) stamps it.
 */
export interface LastSynced {
    vclock: VectorClock;
    chunks?: string[];
    size?: number;
    mtime?: number;
    deleted?: true;
}

/** Parse a raw on-disk meta value into a `LastSynced`. Accepts both the
 *  new `{vclock, chunks, size}` shape and the legacy raw `VectorClock`
 *  shape (any object whose keys are device IDs, no `vclock` key). */
export function parseStoredLastSynced(value: unknown): LastSynced {
    if (value && typeof value === "object" && "vclock" in (value as object)) {
        const v = value as {
            vclock: VectorClock; chunks?: string[]; size?: number;
            mtime?: number; deleted?: boolean;
        };
        return {
            vclock: v.vclock, chunks: v.chunks, size: v.size, mtime: v.mtime,
            ...(v.deleted === true ? { deleted: true as const } : {}),
        };
    }
    // Legacy raw VectorClock — treat the whole object as the vclock.
    return { vclock: (value ?? {}) as VectorClock };
}
