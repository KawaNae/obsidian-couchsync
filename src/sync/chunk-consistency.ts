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
import type { ICouchClient, AllDocsRow } from "../db/interfaces.ts";
import type { FileDoc } from "../types.ts";
import { ID_RANGE } from "../types/doc-id.ts";
import { collectReferencedChunks } from "../db/chunk-refs.ts";

export interface ChunkRef {
    id: string;
    /** Populated only for `missingReferenced` entries. */
    referencedBy?: string[];
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
): Promise<ChunkConsistencyReport> {
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
    for await (const fd of pagedRemoteFileDocs(remote, pageSize, throwIfAborted)) {
        remoteFiles.push(fd);
        onProgress?.("scan-remote-files", remoteFiles.length);
    }

    // A FileDoc may appear on both sides (normal in-sync case). Treat
    // the union as a set keyed by `_id`: local wins only because it was
    // iterated first — for the purposes of the chunks[] field and
    // deleted flag the two copies agree in steady state, and if they
    // diverge the file-level diff is a reconcile concern, not a
    // chunk-integrity concern. Picking one copy also keeps
    // `referencedBy` free of path duplicates in the report.
    const uniqueFiles = new Map<string, FileDoc>();
    for (const fd of localFiles) uniqueFiles.set(fd._id, fd);
    for (const fd of remoteFiles) {
        if (!uniqueFiles.has(fd._id)) uniqueFiles.set(fd._id, fd);
    }
    const referenced = collectReferencedChunks(uniqueFiles.values());

    // ── Phase 2 + 3: sort-merge chunk ids ───────────────────────────

    const localIter = pagedLocalChunkIds(localDb, pageSize, throwIfAborted);
    const remoteIter = pagedRemoteChunkIds(remote, pageSize, throwIfAborted);

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

    return {
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
}

// ── Paging iterators ────────────────────────────────────────────────

async function* pagedRemoteFileDocs(
    remote: ICouchClient,
    pageSize: number,
    throwIfAborted: () => void,
): AsyncGenerator<FileDoc> {
    let startkey = ID_RANGE.file.startkey;
    const endkey = ID_RANGE.file.endkey;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        throwIfAborted();
        const page = await remote.allDocs<FileDoc>({
            startkey,
            endkey,
            include_docs: true,
            limit: pageSize,
        });
        if (page.rows.length === 0) return;
        let lastId = "";
        for (const row of page.rows) {
            lastId = row.id;
            const doc = row.doc;
            if (!doc || (doc as any).type !== "file") continue;
            yield doc;
        }
        if (page.rows.length < pageSize) return;
        startkey = lastId + "\x00";
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
    throwIfAborted: () => void,
): AsyncGenerator<string> {
    let startkey = ID_RANGE.chunk.startkey;
    const endkey = ID_RANGE.chunk.endkey;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        throwIfAborted();
        const page = await remote.allDocs<unknown>({
            startkey,
            endkey,
            // include_docs stays false: CouchDB returns only id/key/rev,
            // a few hundred bytes per row even at 50k chunks.
            limit: pageSize,
        });
        if (page.rows.length === 0) return;
        let lastId = "";
        for (const row of page.rows as AllDocsRow<unknown>[]) {
            // Filter out tombstones (deleted docs surface as rows with
            // value.deleted=true in CouchDB). Their id still contributes
            // to paging order so we advance startkey either way.
            lastId = row.id;
            if (row.value?.deleted) continue;
            yield row.id;
        }
        if (page.rows.length < pageSize) return;
        startkey = lastId + "\x00";
    }
}
