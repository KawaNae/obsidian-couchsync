/**
 * ICouchClient decorator that retries idempotent reads across transient
 * transport failures (a dropped socket, a request timeout, a 5xx).
 *
 * ## Why a transport-level retry, and why only here
 *
 * A retry must happen at a unit that is idempotent and cheap to re-run.
 * Live sync already has one — the session + checkpoint, owned by
 * SyncEngine and paced by `BackoffSchedule`. Vault one-shot ops (Clone,
 * repair, chunk consistency) did not: their only retry unit was the whole
 * op, so one failed chunk GET out of thousands aborted a Clone, and the
 * re-run destroyed the local DB and started over. The individual read
 * request is the correct unit for those ops, so this decorator is applied
 * to the one-shot data client only (`VaultRemoteOps.makeDataClient`).
 * The live sync client deliberately does NOT get it: the session already
 * owns retry, and a second layer would delay error surfacing by up to
 * ~20s and skew stall detection.
 *
 * ## Placement
 *
 * Innermost, directly over the network client:
 *
 *   CompressingCouchClient
 *     └─ EncryptingCouchClient
 *          └─ RetryingCouchClient
 *               └─ CouchClient ← network
 *
 * Only the HTTP transport is retried. Codec failures (EncryptionError,
 * gunzip errors) are not transport issues and must not be re-fetched, and
 * the decode layers run exactly once, on the successful response.
 *
 * ## What is retried
 *
 * Idempotent reads only: `info`, `getDoc`, `bulkGet`, `allDocs`,
 * `changes`, `getAttachment`. Writes (`bulkDocs`,
 * `bulkDocsWithAttachments`, `ensureDb`, `destroy`) pass through — a
 * re-send after an unknown outcome yields 409s / duplicate revs.
 * `changesLongpoll` is live-sync only and passes through too.
 *
 * A failure is retried iff `classifyError` maps it to network / timeout /
 * server. Everything else (auth, not-found, schema-mismatch, aborted, …)
 * rethrows immediately. An aborted external `signal` is never retried and
 * also cuts a pending backoff sleep short. After `maxRetries` the ORIGINAL
 * last error is thrown, so upper layers behave exactly as without retry.
 */

import type {
    ICouchClient,
    DbInfo,
    AllDocsOpts,
    AllDocsResult,
    BulkDocsResult,
    ChangesOpts,
    ChangesResult,
    DocWithAttachments,
} from "./interfaces.ts";
import { BackoffSchedule } from "./sync/backoff.ts";
import { classifyError } from "./sync/errors.ts";
import { logInfo, logWarn } from "../ui/log.ts";

/** Default retry budget. With the Fibonacci table (1,1,2,3,5,8s) six
 *  retries wait ≈20s in total — long enough to ride out a Wi-Fi / VPN
 *  blip, short enough that a genuinely down server still fails promptly. */
const DEFAULT_MAX_RETRIES = 6;

export interface RetryingCouchClientOpts {
    /** Retries after the first attempt. Default {@link DEFAULT_MAX_RETRIES}. */
    maxRetries?: number;
    /** Abortable delay. Injectable so tests run without real timers. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const TRANSIENT_KINDS = new Set(["network", "timeout", "server"]);

function makeAbortError(): Error {
    const e: any = new Error("The operation was aborted.");
    e.name = "AbortError";
    return e;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(makeAbortError());
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(makeAbortError());
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

export class RetryingCouchClient implements ICouchClient {
    private readonly maxRetries: number;
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

    constructor(
        private readonly inner: ICouchClient,
        private readonly opts: RetryingCouchClientOpts = {},
    ) {
        this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
        this.sleep = opts.sleep ?? abortableSleep;
    }

    /** Run `fn` with transient-failure retry. `label` names the call in logs. */
    private async retry<T>(
        label: string,
        signal: AbortSignal | undefined,
        fn: () => Promise<T>,
    ): Promise<T> {
        // Fresh schedule per call: one call's failures never slow another.
        const backoff = new BackoffSchedule();
        let attempt = 0;
        for (;;) {
            try {
                const result = await fn();
                if (attempt > 0) {
                    logInfo(`CouchSync: ${label} succeeded after ${attempt} retr${attempt === 1 ? "y" : "ies"}`);
                }
                return result;
            } catch (e) {
                if (signal?.aborted) throw e;
                const detail = classifyError(e);
                if (!TRANSIENT_KINDS.has(detail.kind)) throw e;
                if (attempt >= this.maxRetries) throw e;
                attempt++;
                const delay = backoff.nextDelay();
                backoff.recordFailure();
                logWarn(
                    `CouchSync: ${label} failed (${detail.kind}: ${detail.message}); ` +
                        `retry ${attempt}/${this.maxRetries} in ${delay}ms`,
                );
                await this.sleep(delay, signal);
            }
        }
    }

    // ── Idempotent reads: retried ────────────────────────

    info(signal?: AbortSignal): Promise<DbInfo> {
        return this.retry("info", signal, () => this.inner.info(signal));
    }

    getDoc<T>(
        id: string,
        opts?: { conflicts?: boolean },
        signal?: AbortSignal,
    ): Promise<T | null> {
        return this.retry(`getDoc(${id})`, signal, () => this.inner.getDoc<T>(id, opts, signal));
    }

    bulkGet<T>(ids: string[], signal?: AbortSignal): Promise<T[]> {
        return this.retry(`bulkGet(${ids.length})`, signal, () => this.inner.bulkGet<T>(ids, signal));
    }

    allDocs<T>(opts: AllDocsOpts, signal?: AbortSignal): Promise<AllDocsResult<T>> {
        return this.retry("allDocs", signal, () => this.inner.allDocs<T>(opts, signal));
    }

    changes<T>(opts: ChangesOpts, signal?: AbortSignal): Promise<ChangesResult<T>> {
        return this.retry("changes", signal, () => this.inner.changes<T>(opts, signal));
    }

    getAttachment(
        docId: string,
        name: string,
        signal?: AbortSignal,
    ): Promise<Uint8Array | null> {
        // 404 → null is handled by the inner client and never reaches here.
        return this.retry(
            `getAttachment(${docId}/${name})`,
            signal,
            () => this.inner.getAttachment(docId, name, signal),
        );
    }

    // ── Writes / live-only: pass through ─────────────────

    bulkDocs(docs: any[], signal?: AbortSignal): Promise<BulkDocsResult[]> {
        return this.inner.bulkDocs(docs, signal);
    }

    bulkDocsWithAttachments(
        items: DocWithAttachments[],
        signal?: AbortSignal,
    ): Promise<BulkDocsResult[]> {
        return this.inner.bulkDocsWithAttachments(items, signal);
    }

    changesLongpoll<T>(opts: ChangesOpts, signal?: AbortSignal): Promise<ChangesResult<T>> {
        return this.inner.changesLongpoll<T>(opts, signal);
    }

    ensureDb(signal?: AbortSignal): Promise<void> {
        return this.inner.ensureDb(signal);
    }

    destroy(signal?: AbortSignal): Promise<void> {
        return this.inner.destroy(signal);
    }

    withTimeout(ms: number): ICouchClient {
        return new RetryingCouchClient(this.inner.withTimeout(ms), this.opts);
    }

    getLastPullBodyChunkAt(): number | null {
        return this.inner.getLastPullBodyChunkAt();
    }
}
