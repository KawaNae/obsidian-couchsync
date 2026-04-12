/**
 * Fetch-based CouchDB HTTP client implementing ICouchClient.
 *
 * All CouchDB interaction goes through standard HTTP endpoints using
 * the browser `fetch` API.
 *
 * Authentication: HTTP Basic Auth via the `Authorization` header.
 * Timeouts: per-request via `AbortController` + `setTimeout`.
 */

import type {
    ICouchClient,
    DbInfo,
    AllDocsOpts,
    AllDocsResult,
    AllDocsRow,
    BulkDocsResult,
    ChangesOpts,
    ChangesResult,
    ChangeRow,
} from "./interfaces.ts";

/** Default per-request timeout (ms). Longpoll has its own. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Heartbeat interval (ms) sent to CouchDB for longpoll. CouchDB sends
 *  a `\n` every heartbeat interval to keep the connection alive through
 *  HTTP/2 proxies and intermediaries. Overrides CouchDB's `timeout`. */
const LONGPOLL_HEARTBEAT_MS = 10_000;

/** Client-side stale threshold: abort if no data (not even a heartbeat
 *  `\n`) arrives within this window. 3× heartbeat interval = 3 missed
 *  heartbeats before we consider the connection dead. */
const LONGPOLL_STALE_MS = LONGPOLL_HEARTBEAT_MS * 3;

/** Client-side maximum wait (ms) for a longpoll request. When heartbeat
 *  is enabled CouchDB never returns an empty response — it keeps sending
 *  `\n` forever. This wall-clock timer aborts the request and returns a
 *  synthetic empty result so the caller's loop can iterate (e.g. call
 *  handlePaused, transition state, then re-enter longpoll). */
const LONGPOLL_MAX_WAIT_MS = 60_000;

/** Maximum docs per `_bulk_docs` POST. Keeps memory and network
 *  pressure bounded on large push/pull operations. */
const BULK_BATCH_SIZE = 100;

export interface CouchClientOpts {
    /** Base URL including database path, e.g. `https://couch.example/mydb` */
    baseUrl: string;
    /** Omit or null for anonymous access. */
    auth?: { user: string; password: string } | null;
    /** Override the default per-request timeout (ms). */
    timeoutMs?: number;
}

/**
 * Lightweight CouchDB HTTP client. Stateless — no connection pool,
 * no local caching. Construct, use, discard.
 */
export class CouchClient implements ICouchClient {
    private readonly baseUrl: string;
    private readonly headers: Record<string, string>;
    private readonly timeoutMs: number;

    constructor(opts: CouchClientOpts) {
        // Normalise: strip trailing slash so path concatenation is clean.
        this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
        this.headers = {
            "Content-Type": "application/json",
            Accept: "application/json",
        };
        if (opts.auth?.user) {
            const cred = btoa(`${opts.auth.user}:${opts.auth.password}`);
            this.headers["Authorization"] = `Basic ${cred}`;
        }
        this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }

    // ── Core HTTP helper ──────────────────────────────────

    private async request<T>(
        path: string,
        init: RequestInit = {},
        abortMs?: number,
    ): Promise<T> {
        const url = `${this.baseUrl}${path}`;
        const controller = new AbortController();
        const timeout = abortMs ?? this.timeoutMs;
        const timer = setTimeout(() => controller.abort(), timeout);

        try {
            const res = await fetch(url, {
                ...init,
                headers: { ...this.headers, ...((init.headers as Record<string, string>) ?? {}) },
                signal: controller.signal,
            });

            if (!res.ok) {
                const body = await res.text().catch(() => "");
                const err: any = new Error(
                    `CouchDB ${res.status}: ${body || res.statusText}`,
                );
                err.status = res.status;
                throw err;
            }

            return (await res.json()) as T;
        } catch (e: any) {
            if (e?.name === "AbortError") {
                const err: any = new Error(`CouchDB request timed out after ${timeout}ms`);
                err.status = 0;
                throw err;
            }
            throw e;
        } finally {
            clearTimeout(timer);
        }
    }

    // ── ICouchClient implementation ───────────────────────

    async info(): Promise<DbInfo> {
        return this.request<DbInfo>("");
    }

    async getDoc<T>(
        id: string,
        opts?: { conflicts?: boolean },
    ): Promise<T | null> {
        const qs = opts?.conflicts ? "?conflicts=true" : "";
        try {
            return await this.request<T>(
                `/${encodeURIComponent(id)}${qs}`,
            );
        } catch (e: any) {
            if (e?.status === 404) return null;
            throw e;
        }
    }

    async bulkGet<T>(ids: string[]): Promise<T[]> {
        if (ids.length === 0) return [];

        const results: T[] = [];
        // Batch to avoid huge POST bodies.
        for (let i = 0; i < ids.length; i += BULK_BATCH_SIZE) {
            const batch = ids.slice(i, i + BULK_BATCH_SIZE);
            const body = { docs: batch.map((id) => ({ id })) };
            const res = await this.request<{ results: any[] }>(
                "/_bulk_get",
                { method: "POST", body: JSON.stringify(body) },
            );
            for (const item of res.results) {
                const docResult = item.docs?.[0];
                if (docResult?.ok) {
                    results.push(docResult.ok as T);
                }
                // Skip errors (deleted docs, missing docs)
            }
        }
        return results;
    }

    async bulkDocs(docs: any[]): Promise<BulkDocsResult[]> {
        if (docs.length === 0) return [];

        const allResults: BulkDocsResult[] = [];
        for (let i = 0; i < docs.length; i += BULK_BATCH_SIZE) {
            const batch = docs.slice(i, i + BULK_BATCH_SIZE);
            const res = await this.request<BulkDocsResult[]>(
                "/_bulk_docs",
                { method: "POST", body: JSON.stringify({ docs: batch }) },
            );
            allResults.push(...res);
        }
        return allResults;
    }

    async allDocs<T>(opts: AllDocsOpts): Promise<AllDocsResult<T>> {
        // Build query params for GET-style options.
        const params = new URLSearchParams();
        if (opts.startkey !== undefined) params.set("startkey", JSON.stringify(opts.startkey));
        if (opts.endkey !== undefined) params.set("endkey", JSON.stringify(opts.endkey));
        if (opts.include_docs) params.set("include_docs", "true");
        if (opts.conflicts) params.set("conflicts", "true");
        if (opts.limit !== undefined) params.set("limit", String(opts.limit));

        // If `keys` is provided, POST to _all_docs with a body.
        if (opts.keys && opts.keys.length > 0) {
            const qs = params.toString();
            const path = `/_all_docs${qs ? "?" + qs : ""}`;
            return this.request<AllDocsResult<T>>(path, {
                method: "POST",
                body: JSON.stringify({ keys: opts.keys }),
            });
        }

        const qs = params.toString();
        return this.request<AllDocsResult<T>>(
            `/_all_docs${qs ? "?" + qs : ""}`,
        );
    }

    async changes<T>(opts: ChangesOpts): Promise<ChangesResult<T>> {
        const params = new URLSearchParams();
        params.set("feed", "normal");
        if (opts.since !== undefined) params.set("since", String(opts.since));
        if (opts.limit !== undefined) params.set("limit", String(opts.limit));
        if (opts.include_docs) params.set("include_docs", "true");

        return this.request<ChangesResult<T>>(
            `/_changes?${params.toString()}`,
        );
    }

    /**
     * Longpoll `_changes` with streaming body read.
     *
     * CouchDB sends `heartbeat` newlines to keep the connection alive
     * through HTTP/2 proxies. The standard `request()` helper uses a
     * wall-clock `AbortController` timer which fires regardless of
     * whether heartbeat data is arriving — fundamentally incompatible
     * with streaming responses. Instead, we read the body via
     * `ReadableStream` and **reset the abort timer on every chunk**,
     * so the connection is only aborted when the server truly goes
     * silent (3 missed heartbeats = 30s of no data at all).
     */
    async changesLongpoll<T>(opts: ChangesOpts): Promise<ChangesResult<T>> {
        const params = new URLSearchParams();
        params.set("feed", "longpoll");
        params.set("heartbeat", String(LONGPOLL_HEARTBEAT_MS));
        if (opts.since !== undefined) params.set("since", String(opts.since));
        if (opts.limit !== undefined) params.set("limit", String(opts.limit));
        if (opts.include_docs) params.set("include_docs", "true");

        const url = `${this.baseUrl}/_changes?${params.toString()}`;
        const controller = new AbortController();

        // Flag to distinguish which timer caused the abort.
        let maxWaitFired = false;

        // Stale timer: resets on every chunk (heartbeat or data).
        // 3 missed heartbeats = connection is dead → throw.
        let staleTimer = setTimeout(() => controller.abort(), LONGPOLL_STALE_MS);
        const resetStaleTimer = () => {
            clearTimeout(staleTimer);
            staleTimer = setTimeout(() => controller.abort(), LONGPOLL_STALE_MS);
        };

        // Max-wait timer: wall-clock, never resets. When heartbeat is
        // enabled CouchDB never returns empty results — this timer
        // ensures the caller's loop iterates periodically.
        const maxWaitTimer = setTimeout(() => {
            maxWaitFired = true;
            controller.abort();
        }, LONGPOLL_MAX_WAIT_MS);

        try {
            const res = await fetch(url, {
                headers: this.headers,
                signal: controller.signal,
            });

            if (!res.ok) {
                const body = await res.text().catch(() => "");
                const err: any = new Error(
                    `CouchDB ${res.status}: ${body || res.statusText}`,
                );
                err.status = res.status;
                throw err;
            }

            // Stream the body chunk by chunk. Each chunk (heartbeat \n
            // or partial JSON) resets the stale timer.
            const reader = res.body!.getReader();
            const chunks: Uint8Array[] = [];
            let totalLen = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                totalLen += value.length;
                resetStaleTimer();
            }

            clearTimeout(staleTimer);
            clearTimeout(maxWaitTimer);

            // Concatenate chunks and parse. Leading \n from heartbeats
            // are trimmed — JSON.parse tolerates leading whitespace.
            const merged = new Uint8Array(totalLen);
            let offset = 0;
            for (const chunk of chunks) {
                merged.set(chunk, offset);
                offset += chunk.length;
            }
            const text = new TextDecoder().decode(merged);
            return JSON.parse(text.trim()) as ChangesResult<T>;
        } catch (e: any) {
            if (e?.name === "AbortError") {
                if (maxWaitFired) {
                    // Max-wait expired with no changes — return empty
                    // result so the caller can proceed (handlePaused, etc.)
                    return {
                        results: [],
                        last_seq: opts.since ?? 0,
                    } as ChangesResult<T>;
                }
                // Stale: no data at all (not even heartbeats) → throw.
                const err: any = new Error(
                    `CouchDB longpoll stale (no data for ${LONGPOLL_STALE_MS}ms)`,
                );
                err.status = 0;
                throw err;
            }
            throw e;
        } finally {
            clearTimeout(staleTimer);
            clearTimeout(maxWaitTimer);
        }
    }

    async ensureDb(): Promise<void> {
        try {
            await this.request<any>("", { method: "PUT" });
        } catch (e: any) {
            if (e?.status === 412) return; // DB already exists
            throw e;
        }
    }

    async destroy(): Promise<void> {
        await this.request<any>("", { method: "DELETE" });
    }
}

// ── Factory helper ────────────────────────────────────────

/**
 * Build a CouchClient from user-facing settings. Constructs the full
 * database URL from the base URI + database name, embedding auth
 * when credentials are provided.
 */
export function makeCouchClient(
    baseUri: string,
    dbName: string,
    user?: string,
    password?: string,
): CouchClient {
    const url = new URL(baseUri);
    url.pathname = url.pathname.replace(/\/+$/, "") + "/" + dbName;
    // Strip user/pass from URL — we use the Authorization header instead.
    url.username = "";
    url.password = "";
    return new CouchClient({
        baseUrl: url.toString(),
        auth: user ? { user, password: password ?? "" } : null,
    });
}
