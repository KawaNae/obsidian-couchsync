/**
 * describe-error.ts — the one place a failure becomes a sentence for the
 * user.
 *
 * Every one-shot operation (Init, Clone, Verify, the config ops, …) reports
 * its failure through `ProgressNotice.fail(err)`, which asks this module for
 * the text; the Create confirm dialog asks it too. The order is fixed:
 *
 *   1. a cancellation (`AbortError`) is not a failure — the caller says
 *      "cancelled" instead;
 *   2. a domain error that carries its own user-facing sentence
 *      (`userMessage`, see `classifyError`) is shown as is — it already
 *      names the cause and the fix;
 *   3. anything else is classified by `classifyError` (the same classifier
 *      the sync engine and the retry layers use) and gets a cause plus what
 *      to do about it. The raw message follows in parentheses, so the log
 *      still shows what the transport actually said.
 *
 * Pure: no I/O, no logging.
 */
import { classifyError } from "../db/sync/errors.ts";

export interface ErrorDescription {
    /** The sentence to show. For a cancellation: the error's own note on
     *  what the cancel left behind (its `userMessage`), or "". */
    text: string;
    /** The operation was cancelled (by the user or by shutting down). */
    cancelled: boolean;
}

/** The error's own message, as thrown. */
export function rawErrorMessage(err: unknown): string {
    const e: any = err;
    if (typeof e?.message === "string") return e.message;
    return String(err);
}

function ownUserMessage(err: unknown): string | null {
    const m = (err as any)?.userMessage;
    return typeof m === "string" && m !== "" ? m : null;
}

export function describeError(err: unknown): ErrorDescription {
    if ((err as any)?.name === "AbortError") {
        return { text: ownUserMessage(err) ?? "", cancelled: true };
    }
    const own = ownUserMessage(err);
    if (own !== null) return { text: own, cancelled: false };

    const raw = rawErrorMessage(err);
    const withRaw = (text: string): string => (raw ? `${text} (${raw})` : text);
    const d = classifyError(err);
    switch (d.kind) {
        case "network":
            return {
                text: withRaw("The server could not be reached — check the network " +
                    "connection and the server URI in the CouchDB tab."),
                cancelled: false,
            };
        case "timeout":
            return {
                text: withRaw("The server did not respond in time — check the network " +
                    "connection, then try again."),
                cancelled: false,
            };
        case "aborted":
            return {
                text: withRaw("The request was interrupted (for example, the app was " +
                    "suspended) — try again."),
                cancelled: false,
            };
        case "auth":
            return {
                text: withRaw(`The server rejected the credentials (${d.code}) — fix the ` +
                    "user name and password in the CouchDB tab, then press Test."),
                cancelled: false,
            };
        case "server":
            return {
                text: withRaw(`The server returned an error (${d.code}) — check the ` +
                    "CouchDB server, then try again."),
                cancelled: false,
            };
        case "not-found":
            return {
                text: withRaw("The database was not found on the server (404) — check " +
                    "the database name; it may have been deleted."),
                cancelled: false,
            };
        default:
            // schema-mismatch / encryption-paused / unknown: the message is
            // all there is to say (domain errors with a sentence of their
            // own were handled above).
            return { text: d.message || raw, cancelled: false };
    }
}

/**
 * An error whose message is already written for the user — a failure the
 * code detects itself rather than one thrown by the transport (e.g. "repair
 * aborted, the vault is not converged"). `describeError` shows it verbatim
 * instead of classifying its words.
 */
export class UserFacingError extends Error {
    readonly userMessage: string;
    constructor(message: string) {
        super(message);
        this.name = "UserFacingError";
        this.userMessage = message;
    }
}
