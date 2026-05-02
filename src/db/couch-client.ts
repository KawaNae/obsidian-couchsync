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

/** Per-chunk stale threshold for streamed body reads. While bytes are
 *  arriving, the request can take arbitrarily long; only sustained
 *  silence aborts. Matches LONGPOLL_STALE_MS by design — same idea,
 *  different endpoint. Re-used by `SyncEngine` to derive its symmetric
 *  pull-transport grace window: as long as a chunk arrived within this
 *  threshold, the per-chunk stale timer would not have fired, so the
 *  pull is by definition still alive. */
export const BODY_STALE_MS = 30_000;

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
    private readonly auth: { user: string; password: string } | null;

    /** Wall-clock timestamp of the most recent chunk arrival on a
     *  *pull-side* streamed read (`changes`, `changesLongpoll`,
     *  `bulkGet`). Pure observability for `SyncEngine`'s stall detector
     *  — read via `getLastPullBodyChunkAt()`. NOT updated by push
     *  (`bulkDocs`) or by `info` / `allDocs` since their progress is
     *  unrelated to the consumer-side seq lag the detector cares about.
     *  `null` until the first pull-side chunk arrives. */
    private lastPullBodyChunkAt: number | null = null;

    constructor(opts: CouchClientOpts) {
        // Normalise: strip trailing slash so path concatenation is clean.
        this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
        this.headers = {
            "Content-Type": "application/json",
            Accept: "application/json",
        };
        this.auth = opts.auth ?? null;
        if (this.auth?.user) {
            const cred = btoa(`${this.auth.user}:${this.auth.password}`);
            this.headers["Authorization"] = `Basic ${cred}`;
        }
        this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }

    /**
     * Derive a sibling client with the same baseUrl/auth but a different
     * per-request timeout. Used by ConfigOperation to run a short-timeout
     * reachability probe (`info()`) before committing to a 30s allDocs.
     */
    withTimeout(ms: number): CouchClient {
        return new CouchClient({
            baseUrl: this.baseUrl,
            auth: this.auth,
            timeoutMs: ms,
        });
    }

    // ── Core HTTP helper ──────────────────────────────────

    /**
     * Per-request options. `streamed: true` switches the body read to a
     * chunk loop with per-chunk stale-timer instead of a single
     * wall-clock body timeout — survivable on slow mobile networks
     * where a multi-MB JSON response can take minutes but bytes are
     * always flowing. Used for `_all_docs`, `_changes(feed=normal)`,
     * `_bulk_docs`, `_bulk_get` — endpoints that return potentially
     * large JSON bodies.
     */
    private async request<T>(
        path: string,
        init: RequestInit = {},
        opts: {
            abortMs?: number;
            externalSignal?: AbortSignal;
            streamed?: boolean;
            /** Invoked synchronously after each chunk arrives during a
             *  streamed read. Used by pull-side endpoints to stamp
             *  `lastPullBodyChunkAt`; non-pull endpoints (push, allDocs,
             *  info) leave this unset so their activity does not
             *  pollute the pull-stall signal. */
            onChunk?: () => void;
        } = {},
    ): Promise<T> {
        const { abortMs, externalSignal, streamed = false, onChunk } = opts;

        // Short-circuit: if caller's signal is already aborted we never
        // touch the network — matches how native fetch() behaves.
        if (externalSignal?.aborted) throw makeAbortError();

        const url = `${this.baseUrl}${path}`;
        const controller = new AbortController();
        const headerTimeout = abortMs ?? this.timeoutMs;

        // Three reasons the internal controller might abort, in priority
        // order: external cancel > stale-body > header/wall-clock timeout.
        // We track which one fired so the rejection maps cleanly back to
        // the right caller-visible outcome.
        let externalAborted = false;
        let staleFired = false;

        // Phase 1: header-arrival timer. Fires if `fetch()` itself never
        // resolves (server unreachable, TLS handshake stuck, ...).
        let headerTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
            controller.abort();
        }, headerTimeout);

        // Phase 2 (streamed only): per-chunk stale timer. Reset each time
        // a chunk arrives, fires only after BODY_STALE_MS of total silence.
        let staleTimer: ReturnType<typeof setTimeout> | null = null;
        const armStaleTimer = () => {
            if (staleTimer) clearTimeout(staleTimer);
            staleTimer = setTimeout(() => {
                staleFired = true;
                controller.abort();
            }, BODY_STALE_MS);
        };

        const onExternalAbort = () => {
            externalAborted = true;
            controller.abort();
        };
        externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

        try {
            const res = await fetch(url, {
                ...init,
                headers: { ...this.headers, ...((init.headers as Record<string, string>) ?? {}) },
                signal: controller.signal,
            });

            // Headers arrived; the wall-clock header timer's job is done.
            if (headerTimer) { clearTimeout(headerTimer); headerTimer = null; }

            if (!res.ok) {
                const body = await res.text().catch(() => "");
                const err: any = new Error(
                    `CouchDB ${res.status}: ${body || res.statusText}`,
                );
                err.status = res.status;
                throw err;
            }

            if (!streamed) {
                // Non-streamed path: re-arm a single body timeout so an
                // unresponsive body read still aborts. Preserves the old
                // wall-clock semantics for endpoints we know are small.
                const bodyTimer = setTimeout(() => controller.abort(), headerTimeout);
                try {
                    return (await res.json()) as T;
                } finally {
                    clearTimeout(bodyTimer);
                }
            }

            // Streamed path: read body chunk-by-chunk, resetting the
            // stale-timer each chunk. As long as bytes are arriving the
            // request can take indefinitely long. Total silence for
            // BODY_STALE_MS is what aborts.
            const reader = res.body!.getReader();
            const chunks: Uint8Array[] = [];
            let totalLen = 0;

            armStaleTimer();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                totalLen += value.length;
                armStaleTimer();
                onChunk?.();
            }
            if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }

            const merged = new Uint8Array(totalLen);
            let offset = 0;
            for (const chunk of chunks) {
                merged.set(chunk, offset);
                offset += chunk.length;
            }
            const text = new TextDecoder().decode(merged);
            return JSON.parse(text) as T;
        } catch (e: any) {
            if (e?.name === "AbortError") {
                if (externalAborted) throw makeAbortError();
                if (staleFired) {
                    const err: any = new Error(
                        `CouchDB body stale (no data for ${BODY_STALE_MS}ms)`,
                    );
                    err.status = 0;
                    throw err;
                }
                const err: any = new Error(`CouchDB request timed out after ${headerTimeout}ms`);
                err.status = 0;
                throw err;
            }
            throw e;
        } finally {
            if (headerTimer) clearTimeout(headerTimer);
            if (staleTimer) clearTimeout(staleTimer);
            externalSignal?.removeEventListener("abort", onExternalAbort);
        }
    }

    // ── ICouchClient implementation ───────────────────────

    /**
     * Wall-clock timestamp of the most recent pull-side streamed-read
     * chunk arrival. Used by `SyncEngine.checkHealth()` to suppress
     * false-positive stall detection while a slow `_changes`/`_bulk_get`
     * is actively receiving bytes (e.g. a multi-MB catchup over a
     * throttled link). Returns `null` until the first pull-side chunk
     * arrives. Push (`bulkDocs`) and probe (`info`, `allDocs`) traffic
     * deliberately does not update this stamp — they would otherwise
     * mask a genuine pull-side stall.
     */
    getLastPullBodyChunkAt(): number | null {
        return this.lastPullBodyChunkAt;
    }

    async info(signal?: AbortSignal): Promise<DbInfo> {
        return this.request<DbInfo>("", {}, { externalSignal: signal });
    }

    async getDoc<T>(
        id: string,
        opts?: { conflicts?: boolean },
        signal?: AbortSignal,
    ): Promise<T | null> {
        const qs = opts?.conflicts ? "?conflicts=true" : "";
        try {
            return await this.request<T>(
                `/${encodeURIComponent(id)}${qs}`,
                {},
                { externalSignal: signal },
            );
        } catch (e: any) {
            if (e?.status === 404) return null;
            throw e;
        }
    }

    async bulkGet<T>(ids: string[], signal?: AbortSignal): Promise<T[]> {
        if (ids.length === 0) return [];

        const results: T[] = [];
        // Batch to avoid huge POST bodies.
        for (let i = 0; i < ids.length; i += BULK_BATCH_SIZE) {
            const batch = ids.slice(i, i + BULK_BATCH_SIZE);
            const body = { docs: batch.map((id) => ({ id })) };
            const res = await this.request<{ results: any[] }>(
                "/_bulk_get",
                { method: "POST", body: JSON.stringify(body) },
                {
                    externalSignal: signal,
                    streamed: true,
                    onChunk: () => { this.lastPullBodyChunkAt = Date.now(); },
                },
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

    async bulkDocs(docs: any[], signal?: AbortSignal): Promise<BulkDocsResult[]> {
        if (docs.length === 0) return [];
        if (signal?.aborted) throw makeAbortError();

        const allResults: BulkDocsResult[] = [];
        for (let i = 0; i < docs.length; i += BULK_BATCH_SIZE) {
            const batch = docs.slice(i, i + BULK_BATCH_SIZE);
            const res = await this.request<BulkDocsResult[]>(
                "/_bulk_docs",
                { method: "POST", body: JSON.stringify({ docs: batch }) },
                { externalSignal: signal, streamed: true },
            );
            allResults.push(...res);
        }
        return allResults;
    }

    async allDocs<T>(opts: AllDocsOpts, signal?: AbortSignal): Promise<AllDocsResult<T>> {
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
            return this.request<AllDocsResult<T>>(
                path,
                { method: "POST", body: JSON.stringify({ keys: opts.keys }) },
                { externalSignal: signal, streamed: true },
            );
        }

        const qs = params.toString();
        return this.request<AllDocsResult<T>>(
            `/_all_docs${qs ? "?" + qs : ""}`,
            {},
            { externalSignal: signal, streamed: true },
        );
    }

    async changes<T>(opts: ChangesOpts, signal?: AbortSignal): Promise<ChangesResult<T>> {
        const params = new URLSearchParams();
        params.set("feed", "normal");
        if (opts.since !== undefined) params.set("since", String(opts.since));
        if (opts.limit !== undefined) params.set("limit", String(opts.limit));
        if (opts.include_docs) params.set("include_docs", "true");

        return this.request<ChangesResult<T>>(
            `/_changes?${params.toString()}`,
            {},
            {
                externalSignal: signal,
                streamed: true,
                onChunk: () => { this.lastPullBodyChunkAt = Date.now(); },
            },
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
    async changesLongpoll<T>(opts: ChangesOpts, externalSignal?: AbortSignal): Promise<ChangesResult<T>> {
        if (externalSignal?.aborted) throw makeAbortError();

        const params = new URLSearchParams();
        params.set("feed", "longpoll");
        params.set("heartbeat", String(LONGPOLL_HEARTBEAT_MS));
        if (opts.since !== undefined) params.set("since", String(opts.since));
        if (opts.limit !== undefined) params.set("limit", String(opts.limit));
        if (opts.include_docs) params.set("include_docs", "true");

        const url = `${this.baseUrl}/_changes?${params.toString()}`;
        const controller = new AbortController();

        // Three possible abort sources — track which one fired so we can
        // map back to the right caller-visible outcome.
        let maxWaitFired = false;
        let externalAborted = false;

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

        const onExternalAbort = () => {
            externalAborted = true;
            controller.abort();
        };
        externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

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
                // Pull-side transport heartbeat for SyncEngine's stall
                // detector. Heartbeat `\n` chunks count too — they prove
                // the longpoll's TCP path is alive even when no docs are
                // arriving. See `getLastPullBodyChunkAt()`.
                this.lastPullBodyChunkAt = Date.now();
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
                // Priority: external (user cancel) > maxWait > stale.
                // An externally-aborted longpoll is a session teardown,
                // not a timeout — propagate AbortError so the pipeline
                // exits via the cancel path, not the transient-retry path.
                if (externalAborted) throw makeAbortError();
                if (maxWaitFired) {
                    return {
                        results: [],
                        last_seq: opts.since ?? 0,
                    } as ChangesResult<T>;
                }
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
            externalSignal?.removeEventListener("abort", onExternalAbort);
        }
    }

    async ensureDb(signal?: AbortSignal): Promise<void> {
        try {
            await this.request<any>("", { method: "PUT" }, { externalSignal: signal });
        } catch (e: any) {
            if (e?.status === 412) return; // DB already exists
            throw e;
        }
    }

    async destroy(signal?: AbortSignal): Promise<void> {
        await this.request<any>("", { method: "DELETE" }, { externalSignal: signal });
    }
}

function makeAbortError(): Error {
    const e: any = new Error("The operation was aborted.");
    e.name = "AbortError";
    return e;
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
