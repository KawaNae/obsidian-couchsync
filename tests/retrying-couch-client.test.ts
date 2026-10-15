/**
 * RetryingCouchClient — transport-level retry for idempotent reads.
 *
 * Wraps a FakeCouchClient whose methods are overridden per-test to inject
 * transport failures. `sleep` is injected so backoff waits are instant and
 * observable.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { RetryingCouchClient } from "../src/db/retrying-couch-client.ts";
import { FakeCouchClient } from "./helpers/fake-couch-client.ts";
import { EncryptionError } from "../src/db/codec-errors.ts";
import { getLogEntries, clearLog } from "../src/ui/log.ts";

function failedToFetch(): Error {
    return new TypeError("Failed to fetch");
}

function timedOut(): Error {
    const e: any = new Error("CouchDB request timed out after 30000ms");
    e.status = 0;
    return e;
}

function httpError(status: number, message = `HTTP ${status}`): Error {
    const e: any = new Error(message);
    e.status = status;
    return e;
}

function abortError(): Error {
    const e: any = new Error("The operation was aborted.");
    e.name = "AbortError";
    return e;
}

/** Returns a function that throws each of `errors` in turn, then resolves `value`. */
function failThen<T>(errors: Error[], value: T) {
    let i = 0;
    return vi.fn(async () => {
        if (i < errors.length) throw errors[i++];
        return value;
    });
}

describe("RetryingCouchClient", () => {
    let inner: FakeCouchClient;
    let sleep: ReturnType<typeof vi.fn>;
    let client: RetryingCouchClient;

    beforeEach(() => {
        clearLog();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        inner = new FakeCouchClient();
        sleep = vi.fn(async () => {});
        client = new RetryingCouchClient(inner, { sleep, maxRetries: 6 });
    });

    describe("transient failures are retried", () => {
        it("retries getAttachment after 'Failed to fetch' and returns the body", async () => {
            const body = new Uint8Array([1, 2, 3]);
            const fn = failThen([failedToFetch()], body);
            inner.getAttachment = fn;

            await expect(client.getAttachment("chunk:x", "c")).resolves.toBe(body);
            expect(fn).toHaveBeenCalledTimes(2);
            expect(sleep).toHaveBeenCalledTimes(1);
        });

        it("retries a status-0 timeout", async () => {
            const fn = failThen([timedOut()], { rows: [] });
            inner.allDocs = fn as any;

            await expect(client.allDocs({})).resolves.toEqual({ rows: [] });
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it("retries a stalled streamed body (body stale)", async () => {
            const stale: any = new Error("CouchDB body stale (no data for 30000ms)");
            stale.status = 0;
            const fn = failThen([stale], { results: [], last_seq: 0 });
            inner.changes = fn as any;

            await expect(client.changes({})).resolves.toEqual({ results: [], last_seq: 0 });
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it("retries a 5xx", async () => {
            const fn = failThen([httpError(503), httpError(500)], { _id: "a" });
            inner.getDoc = fn as any;

            await expect(client.getDoc("a")).resolves.toEqual({ _id: "a" });
            expect(fn).toHaveBeenCalledTimes(3);
        });

        it("retries every idempotent read (info, bulkGet, changes)", async () => {
            const info = failThen([failedToFetch()], { db_name: "x", doc_count: 0, update_seq: 0 });
            const bulkGet = failThen([failedToFetch()], []);
            const changes = failThen([failedToFetch()], { results: [], last_seq: 0 });
            inner.info = info;
            inner.bulkGet = bulkGet as any;
            inner.changes = changes as any;

            await client.info();
            await client.bulkGet(["a"]);
            await client.changes({});
            expect(info).toHaveBeenCalledTimes(2);
            expect(bulkGet).toHaveBeenCalledTimes(2);
            expect(changes).toHaveBeenCalledTimes(2);
        });

        it("paces retries with the Fibonacci backoff table", async () => {
            const fn = failThen(
                [failedToFetch(), failedToFetch(), failedToFetch(), failedToFetch()],
                null,
            );
            inner.getAttachment = fn;

            await client.getAttachment("chunk:x", "c");
            expect(sleep.mock.calls.map((c) => c[0])).toEqual([1_000, 1_000, 2_000, 3_000]);
        });

        it("logs a warn per retry and an info on eventual success", async () => {
            inner.getAttachment = failThen([failedToFetch(), failedToFetch()], null);

            await client.getAttachment("chunk:x", "c");
            const entries = getLogEntries();
            const warns = entries.filter((e) => e.level === "warn");
            expect(warns).toHaveLength(2);
            expect(warns[0].message).toContain("getAttachment(chunk:x/c)");
            expect(warns[0].message).toContain("network");
            expect(warns[0].message).toContain("retry 1/6");
            expect(warns[1].message).toContain("retry 2/6");
            expect(entries.some((e) => e.level === "info" && e.message.includes("after 2 retries"))).toBe(true);
        });

        it("does not log when the first attempt succeeds", async () => {
            await client.info();
            expect(getLogEntries()).toHaveLength(0);
            expect(sleep).not.toHaveBeenCalled();
        });
    });

    describe("non-transient failures rethrow immediately", () => {
        const cases: Array<[string, () => Error]> = [
            ["404", () => httpError(404)],
            ["401", () => httpError(401)],
            ["non-retriable EncryptionError", () => new EncryptionError("downgrade", undefined, false)],
            ["AbortError", abortError],
            ["unknown", () => new Error("something odd")],
        ];
        for (const [name, make] of cases) {
            it(name, async () => {
                const err = make();
                const fn = vi.fn(async () => { throw err; });
                inner.getDoc = fn as any;

                await expect(client.getDoc("a")).rejects.toBe(err);
                expect(fn).toHaveBeenCalledTimes(1);
                expect(sleep).not.toHaveBeenCalled();
            });
        }

        it("preserves the inner client's null (404) result for getAttachment", async () => {
            const fn = vi.fn(async () => null);
            inner.getAttachment = fn;

            await expect(client.getAttachment("chunk:x", "c")).resolves.toBeNull();
            expect(fn).toHaveBeenCalledTimes(1);
        });
    });

    describe("budget and abort", () => {
        it("gives up after maxRetries and throws the original last error", async () => {
            const errors = Array.from({ length: 7 }, () => failedToFetch());
            const fn = vi.fn(async () => { throw errors[fn.mock.calls.length - 1]; });
            inner.getAttachment = fn;

            await expect(client.getAttachment("chunk:x", "c")).rejects.toBe(errors[6]);
            expect(fn).toHaveBeenCalledTimes(7); // 1 attempt + 6 retries
            expect(sleep).toHaveBeenCalledTimes(6);
        });

        it("does not retry when the external signal is already aborted", async () => {
            const ctrl = new AbortController();
            const err = failedToFetch();
            const fn = vi.fn(async () => { ctrl.abort(); throw err; });
            inner.getAttachment = fn;

            await expect(client.getAttachment("chunk:x", "c", ctrl.signal)).rejects.toBe(err);
            expect(fn).toHaveBeenCalledTimes(1);
            expect(sleep).not.toHaveBeenCalled();
        });

        it("abort during the backoff sleep stops retrying (real sleep)", async () => {
            const real = new RetryingCouchClient(inner); // default abortable sleep
            const ctrl = new AbortController();
            const fn = vi.fn(async () => { throw failedToFetch(); });
            inner.getAttachment = fn;

            const p = real.getAttachment("chunk:x", "c", ctrl.signal);
            // Let the first attempt fail and the 1s sleep start, then abort.
            await new Promise((r) => setTimeout(r, 10));
            ctrl.abort();

            await expect(p).rejects.toMatchObject({ name: "AbortError" });
            expect(fn).toHaveBeenCalledTimes(1);
        });
    });

    describe("pass-through", () => {
        it("does not retry writes", async () => {
            const err = failedToFetch();
            const bulkDocs = vi.fn(async () => { throw err; });
            const bulkDocsWithAttachments = vi.fn(async () => { throw err; });
            const ensureDb = vi.fn(async () => { throw err; });
            const destroy = vi.fn(async () => { throw err; });
            inner.bulkDocs = bulkDocs;
            inner.bulkDocsWithAttachments = bulkDocsWithAttachments;
            inner.ensureDb = ensureDb;
            inner.destroy = destroy;

            await expect(client.bulkDocs([{ _id: "a" }])).rejects.toBe(err);
            await expect(client.bulkDocsWithAttachments([])).rejects.toBe(err);
            await expect(client.ensureDb()).rejects.toBe(err);
            await expect(client.destroy()).rejects.toBe(err);
            expect(bulkDocs).toHaveBeenCalledTimes(1);
            expect(bulkDocsWithAttachments).toHaveBeenCalledTimes(1);
            expect(ensureDb).toHaveBeenCalledTimes(1);
            expect(destroy).toHaveBeenCalledTimes(1);
            expect(sleep).not.toHaveBeenCalled();
        });

        it("does not retry changesLongpoll", async () => {
            const err = failedToFetch();
            const fn = vi.fn(async () => { throw err; });
            inner.changesLongpoll = fn as any;

            await expect(client.changesLongpoll({})).rejects.toBe(err);
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it("withTimeout returns a client that still retries", async () => {
            const timed = new FakeCouchClient();
            const fn = failThen([failedToFetch()], null);
            timed.getAttachment = fn;
            inner.withTimeout = vi.fn(() => timed);

            const derived = client.withTimeout(5_000);
            expect(derived).toBeInstanceOf(RetryingCouchClient);
            expect(inner.withTimeout).toHaveBeenCalledWith(5_000);
            await derived.getAttachment("chunk:x", "c");
            expect(fn).toHaveBeenCalledTimes(2);
            expect(sleep).toHaveBeenCalledTimes(1); // options carried over
        });
    });
});
