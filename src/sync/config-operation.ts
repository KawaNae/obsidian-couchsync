/**
 * ConfigOperation — lifecycle wrapper for one-shot Config Sync work.
 *
 * Why this exists: ConfigSync used to issue HTTP fetches with no
 * AbortSignal, no reachability check, and no visibility gating. On iPad
 * with poor network, every Config Pull spent 30s on a stuck TCP/TLS
 * establish before timing out. The vault sync side never had this
 * problem because its session-client reuses a long-lived longpoll
 * connection and is gated by SyncEngine's reconnect controller.
 *
 * ConfigOperation gives Config Sync a session-equivalent epoch:
 *   - Owns a single AbortController; cancel() aborts every in-flight
 *     fetch and unblocks waitVisible() immediately.
 *   - Runs a short-timeout `info()` reachability probe before the body,
 *     so an unreachable server fails fast instead of waiting 30s on the
 *     first allDocs.
 *   - Optionally awaits VisibilityGate.waitVisible() before starting,
 *     so hidden→visible-driven transient fetch failures don't trip the
 *     body.
 *   - Optionally notifies a ReconnectBridge on transient errors, so a
 *     config failure can drag the vault session into verify-then-restart
 *     when the vault itself is unhealthy.
 *
 * The class is intentionally one-shot — Config Sync ops are user-
 * triggered (button clicks), not driven by a live loop. The supervisor
 * for live loops is SyncSession; this is its one-shot cousin.
 */

import type { AuthGate } from "../db/sync/auth-gate.ts";
import type { VisibilityGate } from "../db/visibility-gate.ts";
import type { ICouchClient } from "../db/interfaces.ts";
import { classifyError } from "../db/sync/errors.ts";
import type { ReconnectBridge } from "./reconnect-bridge.ts";
import { ConfigNotReadyError, configNotReady } from "./config-errors.ts";

/**
 * Per-request timeouts, kept centralised so they can be tuned per
 * iPad observation. The reachability probe is deliberately short
 * (15s, matching SyncEngine's app-resume verifyTimeoutMs) so the
 * user sees a real "server unreachable" message in roughly the same
 * window as the rest of the plugin.
 */
export const CONFIG_TIMEOUTS = {
    reachability: 15_000,
    allDocs: 30_000,
    bulkDocs: 60_000,
    bulkGet: 60_000,
} as const;

export interface ConfigOpContext {
    /** The probe-and-body client (full timeout). Use this for allDocs/bulk. */
    client: ICouchClient;
    /** Cancellation signal — propagate into every fetch / waitable. */
    signal: AbortSignal;
}

export interface ConfigOperationDeps {
    auth: AuthGate;
    visibility: VisibilityGate;
    reconnectBridge: ReconnectBridge;
    /**
     * Build a fresh RAW CouchClient for this op (no codec layers). ConfigSync
     * provides this so the operation doesn't have to know about settings
     * shape. Returning null means "config sync is not configured" → op is
     * rejected.
     */
    makeClient: () => ICouchClient | null;
    /**
     * Turn the probed raw client into the client the body runs on. Sync ops
     * run the binding's preflight here (it reads `config:meta` on the raw
     * client and unlocks the key) and return the codec-wrapped client;
     * Create and Join omit it and work on the raw client. A throw is a
     * precondition failure and is reported like any other.
     */
    prepare?: (raw: ICouchClient, signal: AbortSignal) => Promise<ICouchClient>;
    /** The probe's 404 is fine for this op (Create re-creates the DB).
     *  Otherwise a 404 is reported as `db-missing`. */
    allowMissingDb?: boolean;
    /** Config DB name, for the `db-missing` message. */
    dbName?: string;
}

export class ConfigOperationError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message);
        this.name = "ConfigOperationError";
    }
}

/**
 * Single-use operation. Construct, run() once, discard. Concurrent runs
 * are not supported — ConfigSync is responsible for serialising callers.
 */
export class ConfigOperation {
    private readonly controller = new AbortController();
    private settled = false;

    constructor(private readonly deps: ConfigOperationDeps) {}

    /** External cancel — aborts every fetch and unblocks waitVisible. */
    cancel(): void {
        if (this.settled) return;
        this.controller.abort();
    }

    get signal(): AbortSignal {
        return this.controller.signal;
    }

    /**
     * Execute `body(ctx)` inside the operation epoch. Steps, in order:
     *   1. Auth gate check.
     *   2. Visibility wait (hidden → visible).
     *   3. Build the raw client.
     *   4. Reachability probe via withTimeout(15s).info() (404 → db-missing
     *      unless `allowMissingDb`).
     *   5. `prepare` (preflight + codec wrap) when given.
     *   6. Run body with the full-timeout client and signal.
     *
     * On any thrown error, runs error classification and notifies the
     * appropriate gate / bridge before rethrowing.
     */
    async run<T>(body: (ctx: ConfigOpContext) => Promise<T>): Promise<T> {
        if (this.settled) {
            throw new ConfigOperationError("ConfigOperation already settled");
        }
        try {
            return await this.runInner(body);
        } catch (e) {
            this.handleError(e);
            throw e;
        } finally {
            this.settled = true;
        }
    }

    private async runInner<T>(body: (ctx: ConfigOpContext) => Promise<T>): Promise<T> {
        if (this.controller.signal.aborted) throw makeAbortError();

        // 1. Auth latch.
        if (this.deps.auth.isBlocked()) {
            throw new Error("Auth blocked — fix credentials in Vault Sync first");
        }

        // 2. Visibility — wait until visible, or until cancelled. Never
        //    throws by contract; we re-check the signal afterwards.
        await this.deps.visibility.waitVisible(this.controller.signal);
        if (this.controller.signal.aborted) throw makeAbortError();

        // 3. Build client. A null return means config sync isn't configured.
        const client = this.deps.makeClient();
        if (client === null) {
            throw new ConfigNotReadyError(
                "not-configured",
                "Config sync not configured (couchdbConfigDbName is empty)",
            );
        }

        // 4. Reachability probe with a short timeout. Bypasses the 30s
        //    DEFAULT_TIMEOUT, so an unreachable server surfaces in ~15s
        //    instead of every allDocs/bulk call eating its own 30s.
        const probeClient = client.withTimeout(CONFIG_TIMEOUTS.reachability);
        try {
            await probeClient.info(this.controller.signal);
        } catch (e) {
            const missing = !this.controller.signal.aborted
                && classifyError(e).kind === "not-found";
            if (!missing) throw e;
            if (!this.deps.allowMissingDb) {
                throw configNotReady("db-missing", { db: this.deps.dbName });
            }
        }

        // 5. Preflight + codec wrap.
        const bodyClient = this.deps.prepare
            ? await this.deps.prepare(client, this.controller.signal)
            : client;
        if (this.controller.signal.aborted) throw makeAbortError();

        // 6. Body. Full-timeout client; the body owns the timeout budget.
        return body({ client: bodyClient, signal: this.controller.signal });
    }

    private handleError(err: unknown): void {
        // External cancel — surfaced to caller as AbortError, no telemetry.
        if (this.controller.signal.aborted) return;
        // A precondition failure (e.g. `key-missing` from the client build)
        // says nothing about server health — never drag the vault session
        // into a reconnect over it.
        if (err instanceof ConfigNotReadyError) return;

        const detail = classifyError(err);
        if (detail.kind === "auth" && typeof detail.code === "number") {
            this.deps.auth.raise(detail.code, detail.message);
            return;
        }
        // Transient or terminal — let the bridge decide whether to drag
        // the vault session into a verify-then-restart. schema-mismatch
        // (non-retriable EncryptionError / cipherVersion floor breach) is
        // terminal on the config side; the vault session must still be
        // notified so it can halt rather than loop against the same error.
        if (detail.kind === "network" || detail.kind === "timeout"
            || detail.kind === "server" || detail.kind === "schema-mismatch") {
            this.deps.reconnectBridge.notifyTransient(err);
        }
    }
}

function makeAbortError(): Error {
    const e: any = new Error("The operation was aborted.");
    e.name = "AbortError";
    return e;
}
