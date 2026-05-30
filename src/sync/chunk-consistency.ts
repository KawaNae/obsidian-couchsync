/**
 * Chunk consistency analysis — read-only diff of the chunk inventory
 * held by the local DB vs. the remote CouchDB.
 *
 * Chunks are content-addressed (`_id = "chunk:" + xxhash64(content)`)
 * so "same id" implies "same body". The interesting questions are
 * therefore structural, not bitwise:
 *
 *   - which ids live on one side and not the other?
 *   - which ids are referenced by some FileDoc but missing from both
 *     stores (the file is broken)?
 *   - which ids are present but unreferenced (orphan)?
 *
 * The analysis is streaming sort-merge over the chunk id spaces, which
 * keeps the additional memory cost bounded by the size of the reference
 * map — the full chunk sets are never materialised together.
 */

import type { LocalDB } from "../db/local-db.ts";
import type { ICouchClient } from "../db/interfaces.ts";
import type { FileDoc } from "../types.ts";
import { ID_RANGE } from "../types/doc-id.ts";
import { paginateAllDocs } from "../db/sync/pagination.ts";
import { collectFileChunkRefs } from "../db/chunk-refs.ts";
import { compareVC, type VCRelation, type VectorClock } from "./vector-clock.ts";

export interface ChunkRef {
    id: string;
    /** Populated only for `missingReferenced` entries. */
    referencedBy?: string[];
}

/**
 * A diagnosis is only trustworthy when the local and remote FileDoc
 * sets agree: orphan / referenced classification is defined only
 * against a single source of truth. When they disagree, the analyzer
 * returns `needs-convergence` instead of a report and the caller is
 * expected to let normal sync catch up before retrying.
 */
export type ChunkConsistencyResult =
    | { state: "converged"; report: ChunkConsistencyReport }
    | { state: "needs-convergence"; divergence: FileDocDivergence };

export interface FileDocDivergingPair {
    id: string;
    localVC: VectorClock;
    remoteVC: VectorClock;
    /** Relation of local → remote. `equal` never appears here. */
    relation: Exclude<VCRelation, "equal">;
}

export interface FileDocDivergence {
    /** FileDoc ids present only on local (not yet pushed). */
    localOnly: string[];
    /** FileDoc ids present only on remote (not yet pulled). */
    remoteOnly: string[];
    /** Ids present on both sides but with non-equal vclocks. */
    differing: FileDocDivergingPair[];
}

export interface ChunkConsistencyReport {
    generatedAt: number;
    localUpdateSeq: number | string;
    remoteUpdateSeq: number | string;
    /**
     * True when `_update_seq` on either side changed between the start
     * and end of the scan. The report is still useful but may contain
     * transient drift; callers should rerun to confirm.
     */
    snapshotChanged: boolean;

    counts: {
        localChunks: number;
        remoteChunks: number;
        referencedIds: number;
        localOnly: number;
        remoteOnly: number;
        missingReferenced: number;
        orphanLocal: number;
        orphanRemote: number;
    };

    localOnly: string[];
    remoteOnly: string[];
    missingReferenced: ChunkRef[];
    orphanLocal: string[];
    orphanRemote: string[];
}

export type ChunkConsistencyPhase =
    | "scan-local-files"
    | "scan-remote-files"
    | "enumerate-local-chunks"
    | "enumerate-remote-chunks"
    | "merge";

export interface ChunkConsistencyDeps {
    localDb: LocalDB;
    remote: ICouchClient;
    onProgress?: (
        phase: ChunkConsistencyPhase,
        current: number,
        total?: number,
    ) => void;
    signal?: AbortSignal;
    /** Page size for both stores. Default 2000. */
    pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 2000;

export async function analyzeChunkConsistency(
    deps: ChunkConsistencyDeps,
): Promise<ChunkConsistencyResult> {
    const { localDb, remote, onProgress, signal } = deps;
    const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;

    const throwIfAborted = (): void => {
        if (signal?.aborted) {
            throw new DOMException("Aborted", "AbortError");
        }
    };

    throwIfAborted();

    // Snapshot begin markers.
    const localInfoStart = await localDb.info();
    const remoteInfoStart = await remote.info();

    // ── Phase 1: reference set (local ∪ remote FileDocs) ────────────

    onProgress?.("scan-local-files", 0);
    const localFiles = await localDb.allFileDocs();
    onProgress?.("scan-local-files", localFiles.length, localFiles.length);

    throwIfAborted();

    const remoteFiles: FileDoc[] = [];
    onProgress?.("scan-remote-files", 0);
    for await (const fd of pagedRemoteFileDocs(remote, pageSize, signal)) {
        remoteFiles.push(fd);
        onProgress?.("scan-remote-files", remoteFiles.length);
    }

    // Convergence gate: orphan / referenced classification is only
    // well-defined when both sides agree on what every FileDoc's chunks
    // and deleted flag currently are. If they disagree (in-flight push
    // or pull, or a genuine divergence), bail out without enumerating
    // chunks — a lagging device running the diagnosis would otherwise
    // produce a report that can drive a repair into a ping-pong with
    // the up-to-date device. The caller is expected to let sync catch
    // up and retry.
    const divergence = diffFileDocs(localFiles, remoteFiles);
    if (hasDivergence(divergence)) {
        return { state: "needs-convergence", divergence };
    }

    // Past the gate the two sides are identical by id and vclock. Pick
    // either to build the reference map; `referencedBy` paths are the
    // same whichever we choose.
    const referenced = collectFileChunkRefs(localFiles);

    // ── Phase 2 + 3: sort-merge chunk ids ───────────────────────────

    const localIter = pagedLocalChunkIds(localDb, pageSize, throwIfAborted);
    const remoteIter = pagedRemoteChunkIds(remote, pageSize, signal);

    const localOnly: string[] = [];
    const remoteOnly: string[] = [];
    const orphanLocal: string[] = [];
    const orphanRemote: string[] = [];
    const seenReferencedIds = new Set<string>();

    let localCount = 0;
    let remoteCount = 0;
    onProgress?.("merge", 0);

    let a = await localIter.next();
    let b = await remoteIter.next();
    while (!a.done || !b.done) {
        throwIfAborted();
        const aVal = a.done ? undefined : a.value;
        const bVal = b.done ? undefined : b.value;

        if (aVal !== undefined && (bVal === undefined || aVal < bVal)) {
            localCount++;
            classify(aVal, true, false);
            a = await localIter.next();
        } else if (bVal !== undefined && (aVal === undefined || aVal > bVal)) {
            remoteCount++;
            classify(bVal, false, true);
            b = await remoteIter.next();
        } else if (aVal !== undefined && bVal !== undefined) {
            // aVal === bVal
            localCount++;
            remoteCount++;
            classify(aVal, true, true);
            a = await localIter.next();
            b = await remoteIter.next();
        }
        if ((localCount + remoteCount) % 500 === 0) {
            onProgress?.("merge", localCount + remoteCount);
        }
    }
    onProgress?.("merge", localCount + remoteCount);

    function classify(id: string, inLocal: boolean, inRemote: boolean): void {
        const refs = referenced.get(id);
        if (inLocal && !inRemote) localOnly.push(id);
        if (!inLocal && inRemote) remoteOnly.push(id);
        if (!refs) {
            if (inLocal) orphanLocal.push(id);
            if (inRemote) orphanRemote.push(id);
        } else {
            seenReferencedIds.add(id);
        }
    }

    // ── Phase 4: referenced-but-missing ────────────────────────────

    const missingReferenced: ChunkRef[] = [];
    for (const [id, paths] of referenced) {
        if (!seenReferencedIds.has(id)) {
            missingReferenced.push({ id, referencedBy: paths });
        }
    }
    missingReferenced.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

    // ── Snapshot closing markers ──

    const localInfoEnd = await localDb.info();
    const remoteInfoEnd = await remote.info();
    const snapshotChanged =
        localInfoStart.updateSeq !== localInfoEnd.updateSeq ||
        remoteInfoStart.update_seq !== remoteInfoEnd.update_seq;

    const report: ChunkConsistencyReport = {
        generatedAt: Date.now(),
        localUpdateSeq: localInfoEnd.updateSeq,
        remoteUpdateSeq: remoteInfoEnd.update_seq,
        snapshotChanged,
        counts: {
            localChunks: localCount,
            remoteChunks: remoteCount,
            referencedIds: referenced.size,
            localOnly: localOnly.length,
            remoteOnly: remoteOnly.length,
            missingReferenced: missingReferenced.length,
            orphanLocal: orphanLocal.length,
            orphanRemote: orphanRemote.length,
        },
        localOnly,
        remoteOnly,
        missingReferenced,
        orphanLocal,
        orphanRemote,
    };
    return { state: "converged", report };
}

/**
 * The set of chunk ids currently referenced by some live (non-deleted)
 * FileDoc on the remote.
 *
 * Used as a re-validation guard immediately before a destructive repair
 * tombstones "orphan" chunks (#4). A consistency report is a snapshot taken
 * at scan time; between the scan and the (user-initiated, arbitrarily later)
 * repair, another device may have pushed a FileDoc that re-references a chunk
 * the report classified as orphan. Re-deriving the live reference set at the
 * destructive boundary closes that TOCTOU window. Chunks are content-
 * addressed, so the guard only ever errs toward NOT deleting — a chunk that
 * is still genuinely orphaned is reclaimed by the next GC pass.
 */
export async function liveRemoteChunkRefs(
    remote: ICouchClient,
    pageSize: number = DEFAULT_PAGE_SIZE,
    signal?: AbortSignal,
): Promise<Set<string>> {
    const files: FileDoc[] = [];
    for await (const fd of pagedRemoteFileDocs(remote, pageSize, signal)) {
        files.push(fd);
    }
    return new Set(collectFileChunkRefs(files).keys());
}

// ── FileDoc convergence ─────────────────────────────────────────────

/**
 * Compare two FileDoc iterables (typically `allFileDocs` snapshots from
 * local and remote) purely by id and vclock. Divergence means at least
 * one of:
 *
 *   - an id is present on exactly one side (pending push or pull), or
 *   - an id is present on both sides with non-equal vclocks.
 *
 * Deleted FileDocs participate: a deletion on one side but not the
 * other is still divergence — either the tombstone or the live doc
 * needs to propagate before the diagnosis can be trusted.
 */
export function diffFileDocs(
    localFiles: Iterable<FileDoc>,
    remoteFiles: Iterable<FileDoc>,
): FileDocDivergence {
    const localMap = new Map<string, FileDoc>();
    for (const fd of localFiles) localMap.set(fd._id, fd);
    const remoteMap = new Map<string, FileDoc>();
    for (const fd of remoteFiles) remoteMap.set(fd._id, fd);

    const localOnly: string[] = [];
    const remoteOnly: string[] = [];
    const differing: FileDocDivergingPair[] = [];

    for (const [id, lfd] of localMap) {
        const rfd = remoteMap.get(id);
        if (!rfd) {
            localOnly.push(id);
            continue;
        }
        const relation = compareVC(lfd.vclock, rfd.vclock);
        if (relation !== "equal") {
            differing.push({
                id,
                localVC: lfd.vclock,
                remoteVC: rfd.vclock,
                relation,
            });
        }
    }
    for (const id of remoteMap.keys()) {
        if (!localMap.has(id)) remoteOnly.push(id);
    }

    localOnly.sort();
    remoteOnly.sort();
    differing.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    return { localOnly, remoteOnly, differing };
}

export function hasDivergence(d: FileDocDivergence): boolean {
    return (
        d.localOnly.length > 0 ||
        d.remoteOnly.length > 0 ||
        d.differing.length > 0
    );
}

// ── Paging iterators ────────────────────────────────────────────────

async function* pagedRemoteFileDocs(
    remote: ICouchClient,
    pageSize: number,
    signal?: AbortSignal,
): AsyncGenerator<FileDoc> {
    // Delegate paging to the canonical keyset helper, which continues on
    // the raw storage `row.key`. This is the load-bearing detail under
    // encryption: the codec client restores `row.id` to the plaintext
    // path while leaving `row.key` as the on-disk `file:<hmac>` id, so
    // paging stays correct in the remote's actual (hmac) ordering. A
    // hand-rolled `startkey = row.id` loop would jump into the plaintext
    // keyspace and mis-page after the first batch.
    for await (const rows of paginateAllDocs<FileDoc>(
        remote,
        {
            startkey: ID_RANGE.file.startkey,
            endkey: ID_RANGE.file.endkey,
            include_docs: true,
        },
        { batchSize: pageSize, signal },
    )) {
        for (const row of rows) {
            const doc = row.doc;
            if (!doc || (doc as { type?: string }).type !== "file") continue;
            yield doc;
        }
    }
}

async function* pagedLocalChunkIds(
    localDb: LocalDB,
    pageSize: number,
    throwIfAborted: () => void,
): AsyncGenerator<string> {
    let startkey = ID_RANGE.chunk.startkey;
    const endkey = ID_RANGE.chunk.endkey;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        throwIfAborted();
        const ids = await localDb.listIds({ startkey, endkey, limit: pageSize });
        if (ids.length === 0) return;
        for (const id of ids) yield id;
        if (ids.length < pageSize) return;
        startkey = ids[ids.length - 1] + "\x00";
    }
}

async function* pagedRemoteChunkIds(
    remote: ICouchClient,
    pageSize: number,
    signal?: AbortSignal,
): AsyncGenerator<string> {
    // Chunk ids (`chunk:<alg>:<hash>`) are NOT path-encrypted, so they are
    // identical on local and remote and the codec client passes them
    // through untouched — no `include_docs` needed (id/key/rev only). Uses
    // the same canonical keyset paging (continues on `row.key`).
    for await (const rows of paginateAllDocs<unknown>(
        remote,
        {
            startkey: ID_RANGE.chunk.startkey,
            endkey: ID_RANGE.chunk.endkey,
            include_docs: false,
        },
        { batchSize: pageSize, signal },
    )) {
        for (const row of rows) {
            // Filter out tombstones (deleted docs surface with
            // value.deleted=true); they still anchor paging via row.key.
            if (row.value?.deleted) continue;
            yield row.id;
        }
    }
}
