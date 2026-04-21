/**
 * Chunk drift repair — the write-side counterpart of
 * `analyzeChunkConsistency`. Closes the gap left by normal sync when
 * chunks end up on only one side, in both directions of membership
 * (present ↔ absent) and both directions of reference (referenced ↔
 * unreferenced), giving four quadrants of drift to settle:
 *
 *   referenced × localOnly     → push to remote
 *   referenced × remoteOnly    → pull to local
 *   unreferenced × localOnly   → delete from local
 *   unreferenced × remoteOnly  → delete from remote (tombstone)
 *
 * Chunks are content-addressed (`chunk:` + xxhash64), so "same id"
 * implies "same body". Copy operations are safe under concurrent
 * sync; delete operations target chunks no live FileDoc references, so
 * they cannot break a file that is currently in use.
 *
 * Two-sided orphans (present on both sides, unreferenced everywhere)
 * stay with the regular GC (`src/db/chunk-gc.ts`); they are eventually
 * consistent without repair intervention. The one-sided deletion paths
 * exist because the current GC physically removes documents and does
 * not emit tombstones — so a one-sided orphan has no other path off
 * the remote.
 */

import type { ChunkConsistencyReport } from "./chunk-consistency.ts";
import type { LocalDB } from "../db/local-db.ts";
import type { ICouchClient } from "../db/interfaces.ts";
import {
    pushDocs,
    pullDocs,
    deleteRemoteDocs,
} from "../db/remote-couch.ts";

export interface ChunkRepairPlan {
    /** referenced chunks present only locally — push to remote */
    toPush: string[];
    /** referenced chunks present only remotely — pull to local */
    toPull: string[];
    /** unreferenced chunks present only locally — delete locally */
    toDeleteLocal: string[];
    /** unreferenced chunks present only remotely — tombstone on remote */
    toDeleteRemote: string[];
}

export type ChunkRepairDirection =
    | "push"
    | "pull"
    | "delete-local"
    | "delete-remote";

export interface ChunkRepairDeps {
    localDb: LocalDB;
    remote: ICouchClient;
    onProgress?: (
        phase: ChunkRepairDirection,
        current: number,
        total: number,
    ) => void;
    signal?: AbortSignal;
}

export interface ChunkRepairFailure {
    id: string;
    direction: ChunkRepairDirection;
    reason: string;
}

export interface ChunkRepairResult {
    pushed: number;
    pulled: number;
    deletedLocal: number;
    deletedRemote: number;
    failed: ChunkRepairFailure[];
    elapsedMs: number;
}

export function planFromReport(
    report: ChunkConsistencyReport,
): ChunkRepairPlan {
    const orphanLocal = new Set(report.orphanLocal);
    const orphanRemote = new Set(report.orphanRemote);
    return {
        toPush: report.localOnly.filter((id) => !orphanLocal.has(id)),
        toPull: report.remoteOnly.filter((id) => !orphanRemote.has(id)),
        toDeleteLocal: report.localOnly.filter((id) => orphanLocal.has(id)),
        toDeleteRemote: report.remoteOnly.filter((id) =>
            orphanRemote.has(id),
        ),
    };
}

export function planIsEmpty(plan: ChunkRepairPlan): boolean {
    return (
        plan.toPush.length === 0 &&
        plan.toPull.length === 0 &&
        plan.toDeleteLocal.length === 0 &&
        plan.toDeleteRemote.length === 0
    );
}

export async function repairChunkDrift(
    plan: ChunkRepairPlan,
    deps: ChunkRepairDeps,
): Promise<ChunkRepairResult> {
    const started = performance.now();
    const failed: ChunkRepairFailure[] = [];

    const pushed = await runPhase(
        "push",
        plan.toPush,
        failed,
        (onIndividual) =>
            pushDocs(deps.localDb, deps.remote, plan.toPush, (id, count) => {
                onIndividual(id);
                deps.onProgress?.("push", count, plan.toPush.length);
            }),
    );

    const pulled = await runPhase(
        "pull",
        plan.toPull,
        failed,
        (onIndividual) =>
            pullDocs(deps.localDb, deps.remote, plan.toPull, (id, count) => {
                onIndividual(id);
                deps.onProgress?.("pull", count, plan.toPull.length);
            }),
    );

    const deletedLocal = await runPhase(
        "delete-local",
        plan.toDeleteLocal,
        failed,
        async (onIndividual) => {
            await deps.localDb.runWriteTx({ deletes: plan.toDeleteLocal });
            let count = 0;
            for (const id of plan.toDeleteLocal) {
                onIndividual(id);
                count++;
                deps.onProgress?.(
                    "delete-local",
                    count,
                    plan.toDeleteLocal.length,
                );
            }
            return count;
        },
    );

    const deletedRemote = await runPhase(
        "delete-remote",
        plan.toDeleteRemote,
        failed,
        (onIndividual) =>
            deleteRemoteDocs(
                deps.remote,
                plan.toDeleteRemote,
                (id, count) => {
                    onIndividual(id);
                    deps.onProgress?.(
                        "delete-remote",
                        count,
                        plan.toDeleteRemote.length,
                    );
                },
            ),
    );

    return {
        pushed,
        pulled,
        deletedLocal,
        deletedRemote,
        failed,
        elapsedMs: performance.now() - started,
    };
}

async function runPhase(
    direction: ChunkRepairDirection,
    ids: string[],
    failed: ChunkRepairFailure[],
    run: (onIndividual: (id: string) => void) => Promise<number>,
): Promise<number> {
    if (ids.length === 0) return 0;
    const succeeded = new Set<string>();
    try {
        return await run((id) => succeeded.add(id));
    } catch (e: any) {
        const reason = e?.message ?? String(e);
        for (const id of ids) {
            if (!succeeded.has(id)) {
                failed.push({ id, direction, reason });
            }
        }
        return succeeded.size;
    }
}
