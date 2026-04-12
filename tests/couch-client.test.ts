/**
 * Tests for CouchClient — the fetch-based ICouchClient implementation.
 *
 * Uses vi.fn() to mock global fetch so no real HTTP is needed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CouchClient, makeCouchClient } from "../src/db/couch-client.ts";

function jsonResponse(body: any, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function errorResponse(status: number, body = ""): Response {
    return new Response(body, { status, statusText: `Error ${status}` });
}

describe("CouchClient", () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        fetchMock = vi.fn();
        globalThis.fetch = fetchMock as any;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    function client(opts?: Partial<ConstructorParameters<typeof CouchClient>[0]>) {
        return new CouchClient({
            baseUrl: "https://couch.example/mydb",
            auth: { user: "admin", password: "secret" },
            ...opts,
        });
    }

    describe("info()", () => {
        it("returns database info", async () => {
            const dbInfo = { db_name: "mydb", doc_count: 42, update_seq: "100-abc" };
            fetchMock.mockResolvedValueOnce(jsonResponse(dbInfo));

            const result = await client().info();
            expect(result).toEqual(dbInfo);

            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toBe("https://couch.example/mydb");
            expect(init.headers.Authorization).toMatch(/^Basic /);
        });

        it("throws with status on HTTP error", async () => {
            fetchMock.mockResolvedValueOnce(errorResponse(401, "Unauthorized"));

            const err: any = await client().info().catch((e) => e);
            expect(err.status).toBe(401);
            expect(err.message).toContain("401");
        });
    });

    describe("getDoc()", () => {
        it("returns document", async () => {
            const doc = { _id: "test", _rev: "1-abc", type: "file" };
            fetchMock.mockResolvedValueOnce(jsonResponse(doc));

            const result = await client().getDoc("test");
            expect(result).toEqual(doc);

            const [url] = fetchMock.mock.calls[0];
            expect(url).toBe("https://couch.example/mydb/test");
        });

        it("returns null for 404", async () => {
            fetchMock.mockResolvedValueOnce(errorResponse(404));

            const result = await client().getDoc("missing");
            expect(result).toBeNull();
        });

        it("adds conflicts param", async () => {
            fetchMock.mockResolvedValueOnce(jsonResponse({ _id: "t" }));

            await client().getDoc("t", { conflicts: true });
            const [url] = fetchMock.mock.calls[0];
            expect(url).toContain("?conflicts=true");
        });
    });

    describe("bulkGet()", () => {
        it("returns docs from bulk get", async () => {
            const response = {
                results: [
                    { id: "a", docs: [{ ok: { _id: "a", type: "file" } }] },
                    { id: "b", docs: [{ ok: { _id: "b", type: "file" } }] },
                ],
            };
            fetchMock.mockResolvedValueOnce(jsonResponse(response));

            const result = await client().bulkGet(["a", "b"]);
            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({ _id: "a", type: "file" });
        });

        it("returns empty array for empty input", async () => {
            const result = await client().bulkGet([]);
            expect(result).toEqual([]);
            expect(fetchMock).not.toHaveBeenCalled();
        });
    });

    describe("bulkDocs()", () => {
        it("posts docs and returns results", async () => {
            const results = [
                { ok: true, id: "a", rev: "2-new" },
                { ok: true, id: "b", rev: "2-new" },
            ];
            fetchMock.mockResolvedValueOnce(jsonResponse(results));

            const result = await client().bulkDocs([
                { _id: "a", type: "file" },
                { _id: "b", type: "file" },
            ]);
            expect(result).toEqual(results);

            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toBe("https://couch.example/mydb/_bulk_docs");
            expect(init.method).toBe("POST");
        });

        it("returns empty array for empty input", async () => {
            const result = await client().bulkDocs([]);
            expect(result).toEqual([]);
        });
    });

    describe("allDocs()", () => {
        it("uses query params for range queries", async () => {
            fetchMock.mockResolvedValueOnce(jsonResponse({ rows: [] }));

            await client().allDocs({
                startkey: "file:",
                endkey: "file:\ufff0",
                include_docs: true,
            });

            const [url] = fetchMock.mock.calls[0];
            expect(url).toContain("startkey=");
            expect(url).toContain("endkey=");
            expect(url).toContain("include_docs=true");
        });

        it("uses POST for keys queries", async () => {
            fetchMock.mockResolvedValueOnce(jsonResponse({ rows: [] }));

            await client().allDocs({ keys: ["a", "b"] });

            const [, init] = fetchMock.mock.calls[0];
            expect(init.method).toBe("POST");
            const body = JSON.parse(init.body);
            expect(body.keys).toEqual(["a", "b"]);
        });
    });

    describe("changes()", () => {
        it("fetches changes feed", async () => {
            const changesResult = {
                results: [{ id: "a", seq: "1-abc" }],
                last_seq: "1-abc",
            };
            fetchMock.mockResolvedValueOnce(jsonResponse(changesResult));

            const result = await client().changes({ since: 0, include_docs: true });
            expect(result.results).toHaveLength(1);

            const [url] = fetchMock.mock.calls[0];
            expect(url).toContain("feed=normal");
            expect(url).toContain("since=0");
            expect(url).toContain("include_docs=true");
        });
    });

    describe("changesLongpoll()", () => {
        it("uses longpoll feed with timeout", async () => {
            fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], last_seq: "0" }));

            await client().changesLongpoll({ since: "5-abc" });

            const [url] = fetchMock.mock.calls[0];
            expect(url).toContain("feed=longpoll");
            expect(url).toContain("timeout=60000");
        });
    });

    describe("destroy()", () => {
        it("sends DELETE request", async () => {
            fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

            await client().destroy();

            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toBe("https://couch.example/mydb");
            expect(init.method).toBe("DELETE");
        });
    });

    describe("auth", () => {
        it("sends Basic auth header", async () => {
            fetchMock.mockResolvedValueOnce(jsonResponse({}));

            await client().info();

            const [, init] = fetchMock.mock.calls[0];
            const expected = `Basic ${btoa("admin:secret")}`;
            expect(init.headers.Authorization).toBe(expected);
        });

        it("omits auth header when no credentials", async () => {
            fetchMock.mockResolvedValueOnce(jsonResponse({}));

            await client({ auth: null }).info();

            const [, init] = fetchMock.mock.calls[0];
            expect(init.headers.Authorization).toBeUndefined();
        });
    });
});

describe("makeCouchClient()", () => {
    it("constructs a client with correct URL", async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(
            new Response(JSON.stringify({ db_name: "vault" }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            }),
        );
        const originalFetch = globalThis.fetch;
        globalThis.fetch = fetchMock as any;

        try {
            const client = makeCouchClient(
                "https://couch.example.com/",
                "vault",
                "admin",
                "pass",
            );
            await client.info();

            const [url] = fetchMock.mock.calls[0];
            expect(url).toBe("https://couch.example.com/vault");
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
