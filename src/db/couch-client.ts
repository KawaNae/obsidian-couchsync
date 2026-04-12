/**
 * Fetch-based CouchDB HTTP client implementing ICouchClient.
 *
 * Phase 2 of PouchDB removal: replaces the implicit remote-PouchDB
 * instances that callers used to construct via `new PouchDB(remoteUrl)`.
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

/** Longpoll timeout sent to CouchDB; the client-side abort is slightly
 *  longer to account for network latency. */
const LONGPOLL_FEED_TIMEOUT_MS = 60_000;
const LONGPOLL_ABORT_MS = LONGPOLL_FEED_TIMEOUT_MS + 10_000;

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

    async changesLongpoll<T>(opts: ChangesOpts): Promise<ChangesResult<T>> {
        const params = new URLSearchParams();
        params.set("feed", "longpoll");
        params.set("timeout", String(LONGPOLL_FEED_TIMEOUT_MS));
        if (opts.since !== undefined) params.set("since", String(opts.since));
        if (opts.limit !== undefined) params.set("limit", String(opts.limit));
        if (opts.include_docs) params.set("include_docs", "true");

        return this.request<ChangesResult<T>>(
            `/_changes?${params.toString()}`,
            {},
            LONGPOLL_ABORT_MS,
        );
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
