/**
 * PushBackfill — one-time recovery sweep for docs the push cursor skipped.
 *
 * Until 2026-06-07, `DexieStore.changes()` derived `last_seq` from
 * `_update_seq` read in a separate transaction from the row query. A write
 * committing in that gap produced a cursor that covered a row that was
 * never enumerated; `commitPushCycle` then advanced past it permanently.
 * For live docs the next edit re-enumerates them, but a skipped tombstone
 * never gets another vault event: the deletion silently stops propagating
 * (2026-06-03 incident — search1.jpeg deleted on melchior, resurrected on
 * every other device). The cursor fix (max of enumerated row seqs) makes
 * the race structurally impossible going forward; this sweep repairs the
 * damage already sitting in fleets.
 *
 * Mechanism: diff the local and remote FileDoc sets (the same primitives
 * the chunk-consistency report uses) and enqueue every id where local is
 * causally ahead — `localOnly` plus `differing` with local `dominates` —
 * into the persistent unpushed-set. The next push cycle's existing
 * classify→push machinery does the actual pushing (tombstone-vs-alive
 * deleted differences are already treated as real changes there), so the
 * sweep introduces no new push path.
 *
 * Runs once per device (meta flag, set only after a successful sweep) at
 * session startup after catchup, and unconditionally from the manual
 * "Verify consistency and repair" command.
 */

import type { LocalDB } from "../local-db.ts";
import type { ICouchClient } from "../interfaces.ts";
import type { MetaWrite } from "./../write-transaction.ts";
import type { FileDoc } from "../../types.ts";
import { diffFileDocs, pagedRemoteFileDocs } from "../../sync/chunk-consistency.ts";
import { loadAllUnpushed, unpushedKey, type UnpushedEntry } from "./unpushed-ids.ts";
import { logDebug, logInfo } from "../../ui/log.ts";

export const PUSH_BACKFILL_FLAG_KEY = "_sync/repair/push-backfill-v1";

const REMOTE_PAGE_SIZE = 500;

export interface PushBackfillResult {
    /** Ids newly enqueued into the unpushed-set this sweep. */
    enqueued: number;
    /** True when the one-time flag short-circuited the sweep. */
    skippedByFlag: boolean;
}

export async function runPushBackfill(deps: {
    localDb: LocalDB;
    remote: ICouchClient;
    signal?: AbortSignal;
    /** Manual command path: re-sweep even when the one-time flag is set. */
    force?: boolean;
}): Promise<PushBackfillResult> {
    const { localDb, remote, signal, force } = deps;

    if (!force) {
        const flag = await localDb.getMeta(PUSH_BACKFILL_FLAG_KEY);
        if (flag) return { enqueued: 0, skippedByFlag: true };
    }

    const localFiles = await localDb.allFileDocs();
    const remoteFiles: FileDoc[] = [];
    for await (const fd of pagedRemoteFileDocs(remote, REMOTE_PAGE_SIZE, signal)) {
        remoteFiles.push(fd);
    }

    const div = diffFileDocs(localFiles, remoteFiles);
    const targets = [
        ...div.localOnly,
        ...div.differing
            .filter((d) => d.relation === "dominates")
            .map((d) => d.id),
    ];

    // Don't clobber entries already in the set — their `attempts` counter
    // drives the race-stale → divergent escalation and must keep counting.
    const existing = new Set((await loadAllUnpushed(localDb)).map((r) => r.id));
    const fresh = targets.filter((id) => !existing.has(id));

    const meta: MetaWrite[] = fresh.map((id) => ({
        op: "put",
        key: unpushedKey(id),
        value: {
            reason: "race-stale",
            attempts: 0,
            addedAt: Date.now(),
        } satisfies UnpushedEntry,
    }));
    // Flag commits atomically WITH the enqueue: a crash before this tx
    // leaves the flag unset, so the next session re-sweeps (idempotent —
    // re-enqueueing the same ids is harmless).
    meta.push({ op: "put", key: PUSH_BACKFILL_FLAG_KEY, value: { completedAt: Date.now() } });
    await localDb.runWriteTx({ meta });

    if (fresh.length > 0) {
        logInfo(`Push backfill: ${fresh.length} doc(s) re-enqueued for push`);
    } else {
        logDebug("Push backfill: no cursor-skipped docs found");
    }
    return { enqueued: fresh.length, skippedByFlag: false };
}
