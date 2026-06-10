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
import { EncryptionError } from "../codec-errors.ts";

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

    // Terminal doc-shape mismatch (SchemaVersionMismatchError). Retrying a
    // pull this build can't decode never succeeds, so it must NOT enter the
    // backoff/retry loop — map to a terminal kind the engine halts on. The
    // `userMessage`, when present, is the migration instruction to surface.
    if (e?.nonRetriable === true) {
        return {
            kind: "schema-mismatch",
            message: typeof e?.userMessage === "string" ? e.userMessage : rawMessage,
        };
    }

    // Encryption-agreement pause (#1c): the supervised preCatchupCheck found
    // a user-actionable encryption state (server downgrade, cross-device
    // mismatch, pre-v2 legacy meta, or wrong passphrase) and set
    // connectionState back to "tested". Terminal — retrying loops against
    // the same remote — so map to a kind the engine halts on and the host
    // surfaces once.
    if (e?.encryptionPaused === true) {
        return { kind: "encryption-paused", message: rawMessage };
    }

    // A non-retriable EncryptionError is a policy/security violation — a
    // cipherVersion downgrade-gate breach or an encBody id/path HMAC mismatch.
    // Like a schema mismatch, retrying never succeeds, so it maps to the same
    // terminal kind the engine halts on rather than the backoff loop. A
    // retriable EncryptionError (decrypt failure) falls through to "unknown"
    // and stays transient. (#enc-1)
    if (err instanceof EncryptionError && err.retriable === false) {
        return { kind: "schema-mismatch", message: rawMessage };
    }

    // AbortError — the request was cancelled, NOT proven unreachable. This
    // fires both when our OWN verify timeout aborts (server genuinely slow)
    // AND when a mobile background-suspend froze the in-flight request and
    // the OS tore it down on resume. The two are indistinguishable here, so
    // this stays a neutral "aborted" kind; verifyReachable disambiguates via
    // elapsed wall-clock (suspend ⇒ elapsed ≫ timeout) before deciding
    // whether to enter a hard error. Mislabeling it "Server unreachable"
    // was the source of the spurious resume notifications. (#6)
    if (e?.name === "AbortError" || /operation was aborted|\baborted\b/i.test(rawMessage)) {
        return { kind: "aborted", code, message: rawMessage };
    }

    if (code === 401 || code === 403) {
        return {
            kind: "auth",
            code,
            message: `Authentication failed (${code}). Check your CouchDB credentials.`,
        };
    }
    if (code === 404) {
        return {
            kind: "not-found",
            code,
            message: "Database not found (404). It may have been recreated by another device.",
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
    if (/network|fetch|econn|enotfound|getaddrinfo|failed to fetch|load failed|dns|unreachable|offline/i.test(rawMessage)) {
        return { kind: "network", code, message: rawMessage };
    }
    return { kind: "unknown", code, message: rawMessage };
}
