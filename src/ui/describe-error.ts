/**
 * describe-error.ts — the one place a failure becomes a sentence for the
 * user.
 *
 * Every one-shot operation (Init, Clone, Verify, the config ops, …) reports
 * its failure through `ProgressNotice.fail(err)`, which asks this module for
 * the text; the Create confirm dialog asks it too. An operation that did not
 * succeed ended in one of three ways (`ErrorOutcome`), told apart in a fixed
 * order:
 *
 *   1. a cancellation (`AbortError`): the user stopped it — the caller says
 *      "cancelled";
 *   2. a refusal (`BusyError`): another operation runs, so this one was not
 *      started — the caller says "not started". Nothing went wrong, and the
 *      same request goes through once the other operation ends;
 *   3. a failure: the operation started and did not succeed. A domain error
 *      that carries its own user-facing sentence (`userMessage`, see
 *      `classifyError`) is shown as is — it already names the cause and the
 *      fix. Anything else is classified by `classifyError` (the same
 *      classifier the sync engine and the retry layers use) and gets a
 *      cause plus what to do about it. The raw message follows in
 *      parentheses, so the log still shows what the transport actually said.
 *
 * Pure: no I/O, no logging.
 */
import { classifyError } from "../db/sync/errors.ts";

/** How an operation that did not succeed ended:
 *  - `failed`: it started and went wrong;
 *  - `cancelled`: it was stopped (by the user or by shutting down);
 *  - `refused`: it was not started, because another operation runs. */
export type ErrorOutcome = "failed" | "cancelled" | "refused";

export interface ErrorDescription {
    /** The sentence to show. For a cancellation: the error's own note on
     *  what the cancel left behind (its `userMessage`), or "". For a
     *  refusal: what runs and keeps the operation from starting. */
    text: string;
    outcome: ErrorOutcome;
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
        return { text: ownUserMessage(err) ?? "", outcome: "cancelled" };
    }
    if (err instanceof BusyError) return { text: err.userMessage, outcome: "refused" };
    return { text: failureText(err), outcome: "failed" };
}

function failureText(err: unknown): string {
    const own = ownUserMessage(err);
    if (own !== null) return own;

    const raw = rawErrorMessage(err);
    const withRaw = (text: string): string => (raw ? `${text} (${raw})` : text);
    const d = classifyError(err);
    switch (d.kind) {
        case "network":
            return withRaw("The server could not be reached — check the network " +
                "connection and the server URI in the CouchDB tab.");
        case "timeout":
            return withRaw("The server did not respond in time — check the network " +
                "connection, then try again.");
        case "aborted":
            return withRaw("The request was interrupted (for example, the app was " +
                "suspended) — try again.");
        case "auth":
            return withRaw(`The server rejected the credentials (${d.code}) — fix the ` +
                "user name and password in the CouchDB tab, then press Test.");
        case "server":
            return withRaw(`The server returned an error (${d.code}) — check the ` +
                "CouchDB server, then try again.");
        case "not-found":
            return withRaw("The database was not found on the server (404) — check " +
                "the database name; it may have been deleted.");
        default:
            // schema-mismatch / encryption-paused / unknown: the message is
            // all there is to say (domain errors with a sentence of their
            // own were handled above).
            return d.message || raw;
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

/**
 * The operation was not started because another one runs that it cannot run
 * beside: an operation of the same lock (a second config op, a second Init
 * or Clone), an operation the `ReloadGuard` keeps apart from it, or a change
 * of the setup an operation reads. Nothing was attempted, so it is neither
 * a failure nor recorded as an outcome; the message names what runs, and the
 * same request goes through once it ends.
 */
export class BusyError extends UserFacingError {
    constructor(message: string) {
        super(message);
        this.name = "BusyError";
    }
}

/** Why something cannot start or change now: the operation `label` runs.
 *  Every owner of an operation lock words its blocker with this, so a
 *  refusal names what runs the same way on every side. */
export function runningBlocker(label: string): string {
    return `${label} is running — wait for it to finish.`;
}

/** The note of a cancellation that stopped before anything was changed. */
export const NOTHING_CHANGED = "Nothing was changed.";

/**
 * A cancellation (`AbortError`). `note`, when given, says what the cancel
 * left behind; the notice shows it after "<label> cancelled — ", so it is
 * a sentence of its own, capitalized like the text after "failed — " and
 * "not started — ".
 */
export function cancellation(note?: string): Error {
    const e: any = new Error("The operation was aborted.");
    e.name = "AbortError";
    if (note) e.userMessage = note;
    return e;
}
