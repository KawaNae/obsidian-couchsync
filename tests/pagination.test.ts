/**
 * Tests for the shared pagination helpers (`paginateAllDocs`,
 * `paginateChanges`). These are the load-bearing primitives for
 * Config Pull on slow mobile networks; getting the keyset
 * continuation and "is there more?" termination right is the whole
 * point.
 */

import { describe, it, expect, vi } from "vitest";
import {
    paginateAllDocs,
    paginateChanges,
    DEFAULT_BATCH_SIZE,
} from "../src/db/sync/pagination.ts";
import type {
    ICouchClient,
    AllDocsOpts,
    AllDocsResult,
    AllDocsRow,
    ChangesOpts,
    ChangesResult,
    ChangeRow,
} from "../src/db/interfaces.ts";

/**
 * Minimal fake `ICouchClient` exposing only the methods the
 * pagination helpers touch. `allDocsRows` and `changesRows` are the
 * full corpora; the fake honours `startkey`/`endkey`/`limit` for
 * allDocs and `since`/`limit` for changes the way CouchDB does.
 */
function makeFakeClient(opts: {
    allDocsRows?: AllDocsRow<any>[];
    changesRows?: ChangeRow<any>[];
} = {}): ICouchClient {
    const allDocsCall = vi.fn(async (q: AllDocsOpts): Promise<AllDocsResult<any>> => {
        let rows = (opts.allDocsRows ?? []).slice();
        rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        if (q.startkey !== undefined) rows = rows.filter((r) => r.id >= q.startkey!);
        if (q.endkey !== undefined) rows = rows.filter((r) => r.id <= q.endkey!);
        if (q.limit !== undefined) rows = rows.slice(0, q.limit);
        return { rows, total_rows: opts.allDocsRows?.length };
    });
    const changesCall = vi.fn(async (q: ChangesOpts): Promise<ChangesResult<any>> => {
        let rows = (opts.changesRows ?? []).slice();
        rows.sort((a, b) => Number(a.seq) - Number(b.seq));
        if (q.since !== undefined) rows = rows.filter((r) => Number(r.seq) > Number(q.since));
        if (q.limit !== undefined) rows = rows.slice(0, q.limit);
        const last = rows[rows.length - 1]?.seq ?? q.since ?? 0;
        return { results: rows, last_seq: last };
    });
    return {
        info: vi.fn(),
        getDoc: vi.fn(),
        bulkGet: vi.fn(),
        bulkDocs: vi.fn(),
        allDocs: allDocsCall as any,
        changes: changesCall as any,
        changesLongpoll: vi.fn(),
        ensureDb: vi.fn(),
        destroy: vi.fn(),
    };
}

function row(id: string): AllDocsRow<any> {
    return { id, key: id, value: { rev: "1-x" } };
}
function changeRow(id: string, seq: number): ChangeRow<any> {
    return { id, seq };
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const x of gen) out.push(x);
    return out;
}

describe("paginateAllDocs", () => {
    it("returns nothing for an empty range", async () => {
        const client = makeFakeClient({ allDocsRows: [] });
        const batches = await collect(
            paginateAllDocs(client, { startkey: "a", endkey: "z" }),
        );
        expect(batches).toEqual([]);
    });

    it("yields a single batch when result fits in one page", async () => {
        const rows = [row("a"), row("b"), row("c")];
        const client = makeFakeClient({ allDocsRows: rows });
        const batches = await collect(
            paginateAllDocs(client, { startkey: "a", endkey: "z" }, { batchSize: 10 }),
        );
        expect(batches.length).toBe(1);
        expect(batches[0].map((r) => r.id)).toEqual(["a", "b", "c"]);
    });

    it("yields multiple batches and covers all rows exactly once", async () => {
        const rows = Array.from({ length: 25 }, (_, i) => row(`config:${String(i).padStart(3, "0")}`));
        const client = makeFakeClient({ allDocsRows: rows });
        const batches = await collect(
            paginateAllDocs(client, { startkey: "config:", endkey: "config:￿" }, { batchSize: 10 }),
        );
        const ids = batches.flat().map((r) => r.id);
        expect(ids.length).toBe(25);
        // Each id exactly once, in sorted order.
        expect(new Set(ids).size).toBe(25);
        expect(ids).toEqual([...ids].sort());
    });

    it("uses overfetch (limit=batchSize+1) for continuation detection", async () => {
        const rows = [row("a"), row("b"), row("c"), row("d")];
        const client = makeFakeClient({ allDocsRows: rows });
        await collect(paginateAllDocs(client, { startkey: "a", endkey: "z" }, { batchSize: 2 }));
        const calls = (client.allDocs as any).mock.calls;
        for (const call of calls) {
            expect(call[0].limit).toBe(3); // batchSize + 1
        }
    });

    it("invokes onBatch with cumulative count after each batch", async () => {
        const rows = Array.from({ length: 7 }, (_, i) => row(`x${i}`));
        const client = makeFakeClient({ allDocsRows: rows });
        const seen: number[] = [];
        await collect(
            paginateAllDocs(client, { startkey: "x", endkey: "y" }, {
                batchSize: 3,
                onBatch: (n) => seen.push(n),
            }),
        );
        expect(seen).toEqual([3, 6, 7]);
    });

    it("aborts when signal fires before next batch fetch", async () => {
        const rows = Array.from({ length: 10 }, (_, i) => row(`z${i}`));
        const client = makeFakeClient({ allDocsRows: rows });
        const ctrl = new AbortController();
        const gen = paginateAllDocs(client, { startkey: "z", endkey: "{" }, {
            batchSize: 3,
            signal: ctrl.signal,
        });
        const first = await gen.next();
        expect(first.done).toBe(false);
        ctrl.abort();
        await expect(gen.next()).rejects.toMatchObject({ name: "AbortError" });
    });

    it("DEFAULT_BATCH_SIZE is 100 (mobile-friendly default)", () => {
        expect(DEFAULT_BATCH_SIZE).toBe(100);
    });
});

describe("paginateChanges", () => {
    it("returns nothing for an empty feed", async () => {
        const client = makeFakeClient({ changesRows: [] });
        const batches = await collect(paginateChanges(client, {}));
        expect(batches).toEqual([]);
    });

    it("yields all rows in seq order across batches", async () => {
        const rows = Array.from({ length: 12 }, (_, i) => changeRow(`d${i}`, i + 1));
        const client = makeFakeClient({ changesRows: rows });
        const batches = await collect(
            paginateChanges(client, { since: 0 }, { batchSize: 5 }),
        );
        const ids = batches.flatMap((b) => b.rows.map((r) => r.id));
        expect(ids).toEqual(rows.map((r) => r.id));
    });

    it("returns lastSeq for each batch", async () => {
        const rows = [changeRow("a", 1), changeRow("b", 2), changeRow("c", 3)];
        const client = makeFakeClient({ changesRows: rows });
        const batches = await collect(
            paginateChanges(client, { since: 0 }, { batchSize: 2 }),
        );
        expect(batches.map((b) => b.lastSeq)).toEqual([2, 3]);
    });

    it("aborts when signal fires", async () => {
        const rows = Array.from({ length: 10 }, (_, i) => changeRow(`x${i}`, i + 1));
        const client = makeFakeClient({ changesRows: rows });
        const ctrl = new AbortController();
        const gen = paginateChanges(client, { since: 0 }, {
            batchSize: 2,
            signal: ctrl.signal,
        });
        await gen.next();
        ctrl.abort();
        await expect(gen.next()).rejects.toMatchObject({ name: "AbortError" });
    });
});
