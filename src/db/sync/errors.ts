/**
 * errors.ts — pure error classification.
 *
 * Takes an arbitrary fetch/CouchDB/runtime exception and maps it onto a
 * `SyncErrorDetail` that the state machine, status bar, and retry
 * scheduler can consume without sniffing the error's shape themselves.
 *
 * No I/O, no side effects. The single entry point SyncEngine / pipelines
 * call when an error needs to be classified.
 */

import type { SyncErrorDetail, SyncErrorKind } from "../reconnect-policy.ts";

export type { SyncErrorDetail, SyncErrorKind };

/**
 * Classify an error thrown by the CouchDB client, fetch, or local code.
 *
 * Priority: HTTP status first (401/403/5xx are unambiguous), then message
 * heuristics (timeout / network patterns), then "unknown". HTTP code wins
 * over text because a 401 with a timeout-sounding message is still auth.
 */
export function classifyError(err: unknown): SyncErrorDetail {
    const e: any = err;
    const code: number | undefined = typeof e?.status === "number" ? e.status : undefined;
    const rawMessage: string = (e?.message ?? (e && String(e)) ?? "unknown").toString();

    if (code === 401 || code === 403) {
        return {
            kind: "auth",
            code,
            message: `Authentication failed (${code}). Check your CouchDB credentials.`,
        };
    }
    if (typeof code === "number" && code >= 500) {
        return {
            kind: "server",
            code,
            message: `Server error (${code}): ${rawMessage}`,
        };
    }
    if (/timed?[\s_-]?out|timeout/i.test(rawMessage)) {
        return { kind: "timeout", code, message: rawMessage };
    }
    if (/network|fetch|econn|enotfound|getaddrinfo|failed to fetch|dns|unreachable|offline/i.test(rawMessage)) {
        return { kind: "network", code, message: rawMessage };
    }
    return { kind: "unknown", code, message: rawMessage };
}
