/**
 * Streaming-mode tests for CouchClient.request().
 *
 * v0.20.7 added a chunk-by-chunk body read with a per-chunk stale
 * timer for body-heavy endpoints (allDocs, changes, bulkDocs, bulkGet).
 * The pre-existing wall-clock body timeout used to abort any request
 * whose response took >30s, which on flaky mobile networks killed
 * even successful-but-slow downloads. The streamed path lets
 * arbitrarily long downloads complete as long as bytes keep arriving.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CouchClient } from "../src/db/couch-client.ts";

/** Build a Response whose body is a manually-driven ReadableStream.
 *  Returns the response plus a writer interface to push chunks / close. */
function makeStreamedResponse(initialStatus = 200): {
    response: Response;
    enqueue: (text: string) => void;
    close: () => void;
} {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
        start(c) { controller = c; },
    });
    const enqueue = (text: string) => {
        controller!.enqueue(new TextEncoder().encode(text));
    };
    const close = () => {
        try { controller!.close(); } catch { /* already closed */ }
    };
    const response = new Response(stream, { status: initialStatus });
    return { response, enqueue, close };
}

describe("CouchClient streaming body", () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.useRealTimers();
    });

    it("completes when chunks arrive continuously", async () => {
        const { response, enqueue, close } = makeStreamedResponse();
        globalThis.fetch = vi.fn().mockResolvedValue(response);

        const client = new CouchClient({ baseUrl: "http://test/db" });

        const p = client.allDocs<any>({ startkey: "a", endkey: "z" });

        // Drip-feed the body across multiple chunks.
        enqueue('{"rows":');
        await new Promise((r) => setTimeout(r, 0));
        enqueue('[{"id":"a","key":"a","value":{"rev":"1"}}],');
        await new Promise((r) => setTimeout(r, 0));
        enqueue('"total_rows":1}');
        close();

        const result = await p;
        expect(result.rows.length).toBe(1);
        expect(result.rows[0].id).toBe("a");
    });

    it("aborts with 'body stale' when no chunks arrive for BODY_STALE_MS", async () => {
        const { response, close } = makeStreamedResponse();
        globalThis.fetch = vi.fn().mockResolvedValue(response);

        vi.useFakeTimers();
        const client = new CouchClient({ baseUrl: "http://test/db" });
        const p = client.allDocs<any>({ startkey: "a", endkey: "z" });

        // Let the fetch resolve (headers arrived), then send no chunks.
        await vi.advanceTimersByTimeAsync(0);
        // Stale = 30_000 ms. Advance past it.
        await vi.advanceTimersByTimeAsync(31_000);

        close(); // (after the fact; abort already fired)
        await expect(p).rejects.toMatchObject({ message: /body stale/ });
    });

    it("survives slow trickle past the would-be wall-clock deadline", async () => {
        // 5-second header timeout, 30s body-stale. Send a chunk every 4s
        // for 50s — under wall-clock 30s body would fail; with stale timer,
        // succeeds.
        const { response, enqueue, close } = makeStreamedResponse();
        globalThis.fetch = vi.fn().mockResolvedValue(response);

        vi.useFakeTimers();
        const client = new CouchClient({ baseUrl: "http://test/db", timeoutMs: 5_000 });
        const p = client.allDocs<any>({ startkey: "a", endkey: "z" });

        // Headers arrived (synthetic, fetch already resolved).
        await vi.advanceTimersByTimeAsync(0);

        // Build the JSON in fragments. None of them alone is a closing
        // brace, so the parser would fail mid-stream — but the stale
        // timer only cares about chunk arrival.
        enqueue('{"rows":[');
        for (let i = 0; i < 12; i++) {
            await vi.advanceTimersByTimeAsync(4_000); // < 30s stale window
            enqueue(i === 0 ? '{"id":"x"}' : ',{"id":"x"}');
        }
        enqueue('],"total_rows":12}');
        close();
        await vi.advanceTimersByTimeAsync(0);

        const result = await p;
        expect(result.rows.length).toBe(12);
    });

    it("aborts immediately when external signal is already aborted", async () => {
        const ctrl = new AbortController();
        ctrl.abort();
        const client = new CouchClient({ baseUrl: "http://test/db" });
        await expect(
            client.allDocs<any>({ startkey: "a", endkey: "z" }, ctrl.signal),
        ).rejects.toMatchObject({ name: "AbortError" });
    });

    it("non-streamed endpoints (info) keep working", async () => {
        // info() is NOT streamed (small response). Sanity-check the
        // non-streamed branch isn't broken by the streaming refactor.
        globalThis.fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ db_name: "x", doc_count: 1, update_seq: 5 }), {
                status: 200,
            }),
        );

        const client = new CouchClient({ baseUrl: "http://test/db" });
        const info = await client.info();
        expect(info.db_name).toBe("x");
    });
});
