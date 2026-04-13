/**
 * Error recovery logic extracted from SyncEngine.
 *
 * Classifies CouchDB/fetch errors, manages the transient→hard escalation
 * timer, and drives the backoff retry schedule. SyncEngine delegates all
 * error handling here and supplies callbacks for state transitions.
 */

import type { SyncState, SyncErrorDetail } from "./reconnect-policy.ts";
import { logDebug, logError } from "../ui/log.ts";

// ── Constants ────────────────────────────────────────────

/** How long to keep a transient error in `reconnecting` state before
 *  escalating to hard `error`. */
const TRANSIENT_ESCALATION_MS = 10_000;

/** Backoff delays used after escalation into hard error state. Capped at
 *  the last entry — a permanently-down server is polled every 30s. */
const ERROR_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000, 20_000, 30_000];

// ── Callbacks supplied by SyncEngine ─────────────────────

export interface ErrorRecoveryHost {
    getState(): SyncState;
    setState(state: SyncState, detail?: SyncErrorDetail): void;
    emitError(message: string): void;
    setAuthError(): void;
    teardown(): void;
    requestReconnect(reason: "retry-backoff"): Promise<void>;
}

// ── ErrorRecovery ────────────────────────────────────────

export class ErrorRecovery {
    private transientErrorTimer: ReturnType<typeof setTimeout> | null = null;
    private errorRetryTimer: ReturnType<typeof setTimeout> | null = null;
    private errorRetryStep = 0;

    constructor(private host: ErrorRecoveryHost) {}

    // ── Public API (called by SyncEngine) ────────────────

    /**
     * Classify a CouchDB/fetch error into a SyncErrorDetail.
     */
    classifyError(err: any): SyncErrorDetail {
        const code: number | undefined = typeof err?.status === "number" ? err.status : undefined;
        const rawMessage: string = (err?.message ?? (err && String(err)) ?? "unknown").toString();

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

    /**
     * Soft error path. Routes through `reconnecting` state and gives
     * TRANSIENT_ESCALATION_MS to recover before promoting to hard error.
     * Auth errors escalate immediately.
     */
    handleTransientError(err: any): void {
        const detail = this.classifyError(err);
        logDebug(
            `transient error: kind=${detail.kind} code=${detail.code ?? "-"} msg=${detail.message}`,
        );

        if (detail.kind === "auth") {
            this.enterHardError(detail);
            return;
        }

        if (this.host.getState() !== "reconnecting") {
            this.host.setState("reconnecting");
        }
        if (this.transientErrorTimer) clearTimeout(this.transientErrorTimer);
        this.transientErrorTimer = setTimeout(() => {
            this.transientErrorTimer = null;
            if (this.host.getState() === "reconnecting") {
                logDebug(`transient escalated to hard error after ${TRANSIENT_ESCALATION_MS}ms`);
                this.enterHardError(detail);
            }
        }, TRANSIENT_ESCALATION_MS);
    }

    /**
     * Hard error path. Fires a one-shot Notice, pins state="error" with
     * the classified detail, and — unless it's an auth latch — kicks off
     * the dedicated backoff retry timer.
     */
    enterHardError(detail: SyncErrorDetail): void {
        this.clearTransientErrorTimer();
        this.host.setState("error", detail);
        this.host.emitError(detail.message);

        if (detail.kind === "auth") {
            this.host.setAuthError();
            this.host.teardown();
            this.stopErrorRetryTimer();
            return;
        }

        this.scheduleErrorRetry();
    }

    /** Clean up everything related to error recovery. */
    reset(): void {
        this.errorRetryStep = 0;
        this.stopErrorRetryTimer();
        this.clearTransientErrorTimer();
    }

    // ── Internal ─────────────────────────────────────────

    private scheduleErrorRetry(): void {
        if (this.errorRetryTimer) clearTimeout(this.errorRetryTimer);
        const idx = Math.min(this.errorRetryStep, ERROR_RETRY_DELAYS_MS.length - 1);
        const delay = ERROR_RETRY_DELAYS_MS[idx];
        logDebug(`error retry scheduled in ${delay}ms (step ${this.errorRetryStep})`);
        this.errorRetryTimer = setTimeout(async () => {
            this.errorRetryTimer = null;
            this.errorRetryStep++;
            try {
                await this.host.requestReconnect("retry-backoff");
            } catch (e: any) {
                logError(`CouchSync: retry reconnect failed: ${e?.message ?? e}`);
            }
            if (this.host.getState() === "error") {
                this.scheduleErrorRetry();
            }
        }, delay);
    }

    private stopErrorRetryTimer(): void {
        if (!this.errorRetryTimer) return;
        clearTimeout(this.errorRetryTimer);
        this.errorRetryTimer = null;
    }

    private clearTransientErrorTimer(): void {
        if (!this.transientErrorTimer) return;
        clearTimeout(this.transientErrorTimer);
        this.transientErrorTimer = null;
    }
}
