/**
 * SyncEngine — PouchDB-free sync loop using CouchClient HTTP + ILocalStore.
 *
 * Replaces Replicator with the same public API but swaps PouchDB's
 * `db.sync()` / `db.replicate.from()` with:
 *   - CouchClient.changes() + bulkGet() for catchup pull
 *   - CouchClient.changesLongpoll() loop for live pull
 *   - localDb.changes() poll + CouchClient.bulkDocs() for push
 *   - CouchClient.info() for health probes
 *
 * Phase 3 of the PouchDB removal plan. Consumers (main.ts, setup.ts,
 * settings-tab, etc.) can swap Replicator → SyncEngine with minimal
 * wiring changes — all method signatures and event callbacks are identical.
 */

import type { CouchSyncDoc } from "../types.ts";
import { isReplicatedDocId } from "../types/doc-id.ts";
import type { LocalDB } from "./local-db.ts";
import type { CouchSyncSettings } from "../settings.ts";
import type { ICouchClient, ChangesResult } from "./interfaces.ts";
import * as remoteCouch from "./remote-couch.ts";
import { CouchClient, makeCouchClient } from "./couch-client.ts";
import {
    decideReconnect,
    type ReconnectReason,
    type SyncState,
    type SyncErrorDetail,
    type SyncErrorKind,
} from "./reconnect-policy.ts";
import { logVerbose, logNotice } from "../ui/log.ts";

// ── Re-exports (same as Replicator) ──────────────────────

export type {
    SyncState,
    ReconnectReason,
    SyncErrorDetail,
    SyncErrorKind,
} from "./reconnect-policy.ts";
export type SyncPhase = "idle" | "pulling" | "applying" | "live";

export type OnChangeHandler = (doc: CouchSyncDoc) => void;
export type OnStateChangeHandler = (state: SyncState) => void;
export type OnErrorHandler = (message: string) => void;

// ── Constants ────────────────────────────────────────────

const HEALTH_CHECK_INTERVAL = 30000; // 30s
const CATCHUP_IDLE_TIMEOUT_MS = 60000; // abort catchup after 60s of no progress
const PROBE_TIMEOUT_MS = 5000; // fresh-HTTP probe in checkHealth()

/** Build identifier, logged at start(). Lets us verify on mobile that a
 *  deployed plugin update actually reached the device. */
const BUILD_TAG = "sync-engine-v0.12.0";

/** How long to keep a transient error in `reconnecting` state before
 *  escalating to hard `error`. */
const TRANSIENT_ESCALATION_MS = 10_000;

/** Backoff delays used after escalation into hard error state. Capped at
 *  the last entry — a permanently-down server is polled every 30s. */
const ERROR_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000, 20_000, 30_000];

/** How often to check for local changes to push. */
const PUSH_POLL_INTERVAL_MS = 2000;

/** Batch size for catchup pull changes requests. */
const CATCHUP_BATCH_SIZE = 200;

// ── Checkpoint keys ──────────────────────────────────────

const META_REMOTE_SEQ = "_sync/remote-seq";
const META_PUSH_SEQ = "_sync/push-seq";

// ── SyncEngine ───────────────────────────────────────────

export class SyncEngine {
    // ── State ─────────────────────────────────────────────

    private state: SyncState = "disconnected";
    private phase: SyncPhase = "idle";
    private lastHealthyAt = 0;
    private lastErrorDetail: SyncErrorDetail | null = null;
    private lastRestartTime = 0;

    // ── Event handlers ────────────────────────────────────

    private onChangeHandlers: OnChangeHandler[] = [];
    private onStateChangeHandlers: OnStateChangeHandler[] = [];
    private onErrorHandlers: OnErrorHandler[] = [];
    private onPausedHandlers: (() => void)[] = [];
    private onReconnectHandlers: (() => void)[] = [];
    private idleCallbacks: (() => void)[] = [];
    private hasBeenIdle = false;

    // ── Session management ────────────────────────────────

    /** Incremented on every teardown so async loops can detect mid-flight
     *  session replacement. */
    private syncEpoch = 0;

    /** Dedup for concurrent bringUpSession() calls. */
    private bringUpPromise: Promise<void> | null = null;

    /** The CouchClient for the current session. */
    private client: ICouchClient | null = null;

    /** Whether any session is actively running (pull/push loops alive). */
    private running = false;

    // ── Error handling ────────────────────────────────────

    /** Latched on 401/403 to stop retry storms. Cleared only on explicit
     *  start() call (user has presumably fixed credentials). */
    private authError = false;

    /** Armed on transient live-sync errors. If nothing recovers within
     *  TRANSIENT_ESCALATION_MS, the transient state is promoted to hard error. */
    private transientErrorTimer: ReturnType<typeof setTimeout> | null = null;

    /** Schedules the next backoff retry while in hard-error state. */
    private errorRetryTimer: ReturnType<typeof setTimeout> | null = null;

    /** Index into ERROR_RETRY_DELAYS_MS. */
    private errorRetryStep = 0;

    // ── Timers & env listeners ────────────────────────────

    private healthTimer: ReturnType<typeof setInterval> | null = null;
    private envListenersAttached = false;
    private boundOnOffline = () => this.handleOffline();
    private boundOnOnline = () => this.handleOnline();
    private boundOnVisibility = () =>
        this.handleVisibilityChange(document.visibilityState === "visible");
    private backgroundedAt = 0;

    // ── Probe single-flight ───────────────────────────────

    private probePromise: Promise<boolean> | null = null;
    /** Set by handlePaused-equivalent (longpoll returns), consumed by
     *  doProbe on success. */
    private pausedPending = false;

    /** Latch so we emit at most one warning Notice per `denied` storm. */
    private deniedWarningEmitted = false;

    // ── Checkpoints ───────────────────────────────────────

    /** Last remote _changes seq consumed. */
    private remoteSeq: number | string = 0;
    /** Last local seq that was pushed to remote. */
    private lastPushedSeq: number | string = 0;

    // ── Constructor ───────────────────────────────────────

    constructor(
        private localDb: LocalDB,
        private getSettings: () => CouchSyncSettings,
        private isMobile: boolean = false,
    ) {}

    // ── Public API: State ─────────────────────────────────

    getState(): SyncState {
        return this.state;
    }

    getPhase(): SyncPhase {
        return this.phase;
    }

    /** Timestamp (ms) of the most recent proof the session was healthy,
     *  or 0 if never. Used by the status bar for "X ago" display. */
    getLastHealthyAt(): number {
        return this.lastHealthyAt;
    }

    /** Detail of the current hard error, or null if not in error state.
     *  Status bar uses this to format labels like `Error (401)`. */
    getLastErrorDetail(): SyncErrorDetail | null {
        return this.lastErrorDetail;
    }

    /**
     * True while credentials are known to be rejected by the server. All
     * network-facing code paths should check this before issuing requests
     * to avoid tripping CouchDB's brute-force lockout.
     */
    isAuthBlocked(): boolean {
        return this.authError;
    }

    /**
     * Latch the auth-blocked flag from outside (e.g. from Settings tab
     * fetches that get 401/403). Emits the error so existing onError
     * consumers see it, and pins state to "error".
     */
    markAuthError(status: number, reason?: string): void {
        if (this.authError) return;
        this.enterHardError({
            kind: "auth",
            code: status,
            message:
                `Authentication failed (${status})${reason ? ": " + reason : ""}. ` +
                `Update credentials in the Connection tab.`,
        });
    }

    /** Clear the auth-blocked flag. Call after a successful Test button. */
    clearAuthError(): void {
        this.authError = false;
    }

    // ── Public API: Event handlers ────────────────────────

    onChange(handler: OnChangeHandler): void {
        this.onChangeHandlers.push(handler);
    }

    onStateChange(handler: OnStateChangeHandler): void {
        this.onStateChangeHandlers.push(handler);
    }

    onError(handler: OnErrorHandler): void {
        this.onErrorHandlers.push(handler);
    }

    onPaused(handler: () => void): void {
        this.onPausedHandlers.push(handler);
    }

    onReconnect(handler: () => void): void {
        this.onReconnectHandlers.push(handler);
    }

    /** Register callback to fire once initial sync reaches idle state. */
    onceIdle(callback: () => void): void {
        if (this.hasBeenIdle) {
            callback();
            return;
        }
        this.idleCallbacks.push(callback);
    }

    // ── Public API: Lifecycle ─────────────────────────────

    /**
     * Public lifecycle entry. Attaches env listeners and the health timer
     * once per user-driven lifecycle, then kicks off a session.
     */
    async start(): Promise<void> {
        if (this.running) return;
        logVerbose(`sync-engine start (build=${BUILD_TAG})`);
        // An explicit start() call means the user is trying again — assume
        // they've fixed their credentials.
        this.authError = false;
        this.attachEnvListeners();
        this.startHealthTimer();
        await this.bringUpSession();
    }

    stop(): void {
        this.detachEnvListeners();
        this.stopHealthTimer();
        this.resetErrorRecovery();
        this.teardown();
        this.setState("disconnected");
    }

    /**
     * Single entry point for every reconnect request. Funnels all
     * triggers through the policy gateway (decideReconnect) so the auth
     * latch, cool-down, and state-specific guards are always applied.
     */
    async requestReconnect(reason: ReconnectReason): Promise<void> {
        const decision = decideReconnect({
            state: this.state,
            reason,
            authError: this.authError,
            coolDownActive: Date.now() - this.lastRestartTime < 5000,
        });

        logVerbose(`reconnect: reason=${reason} state=${this.state} → ${decision}`);

        if (decision === "skip") return;

        if (decision === "verify-then-restart") {
            this.setState("reconnecting");
            if (!(await this.verifyReachable())) return;
        } else {
            this.setState("reconnecting");
        }

        logNotice(`Reconnect (${reason}): restarting`);
        await this.restart();
    }

    // ── Public API: One-shot operations ───────────────────

    /**
     * One-shot push of the entire vault local DB to the vault remote.
     * Used by SetupService.init() and similar bootstrap flows.
     */
    async pushToRemote(onProgress?: (docId: string, count: number) => void): Promise<number> {
        const client = this.makeVaultClient();
        return remoteCouch.pushAll(this.localDb, client, onProgress);
    }

    /** One-shot pull of the entire vault remote → local. */
    async pullFromRemote(
        onProgress?: (docId: string, count: number) => void,
    ): Promise<{ written: number; docs: CouchSyncDoc[] }> {
        const client = this.makeVaultClient();
        return remoteCouch.pullAll(this.localDb, client, onProgress);
    }

    /** Destroy the vault remote database (auto-recreated on next push). */
    async destroyRemote(): Promise<void> {
        const client = this.makeVaultClient();
        await remoteCouch.destroyRemote(client);
    }

    /** Test connection with explicit credentials (for unsaved draft values). */
    async testConnectionWith(
        uri: string, user: string, pass: string, db: string,
    ): Promise<string | null> {
        try {
            const client = makeCouchClient(uri, db, user, pass);
            await client.info();
            return null;
        } catch (e: any) {
            return e.message || "Connection failed";
        }
    }

    /** Test connection using saved settings. Reuses the live client when
     *  available so we don't allocate a fresh one on every health probe. */
    async testConnection(): Promise<string | null> {
        if (this.client) {
            try {
                await this.client.info();
                return null;
            } catch (e: any) {
                return e.message || "Connection failed";
            }
        }
        const s = this.getSettings();
        return this.testConnectionWith(
            s.couchdbUri, s.couchdbUser, s.couchdbPassword, s.couchdbDbName,
        );
    }

    // ── Internal: State management ────────────────────────

    private setState(state: SyncState, errorDetail?: SyncErrorDetail): void {
        // Always allow re-emit for error state so a kind change reaches UI.
        if (this.state === state && state !== "error") return;

        const wasError = this.state === "error";
        this.state = state;

        if (state === "error") {
            this.lastErrorDetail = errorDetail ?? null;
        } else {
            this.lastErrorDetail = null;
            if (wasError && (state === "syncing" || state === "connected")) {
                this.resetErrorRecovery();
            }
            if (state !== "reconnecting") {
                this.clearTransientErrorTimer();
            }
        }

        for (const handler of this.onStateChangeHandlers) {
            handler(state);
        }
    }

    private emitError(message: string): void {
        for (const handler of this.onErrorHandlers) {
            handler(message);
        }
    }

    // ── Internal: Session lifecycle ───────────────────────

    /**
     * Session-internal cleanup: cancel running loops, drop session-scoped
     * state. Does NOT touch env listeners or health timer — those survive
     * restart() and are owned by start/stop.
     */
    private teardown(): void {
        this.syncEpoch++;
        this.bringUpPromise = null;
        this.running = false;
        this.client = null;
        this.hasBeenIdle = false;
        this.idleCallbacks = [];
        this.phase = "idle";
        this.deniedWarningEmitted = false;
        this.pausedPending = false;
        this.probePromise = null;
        // lastHealthyAt and lastErrorDetail intentionally NOT reset.
    }

    private async restart(): Promise<void> {
        this.lastRestartTime = Date.now();
        this.teardown();
        await this.bringUpSession();
    }

    /** Dedup wrapper for concurrent bringUpSession calls. */
    private bringUpSession(): Promise<void> {
        if (this.bringUpPromise) return this.bringUpPromise;
        if (this.running) return Promise.resolve();
        if (this.authError) return Promise.resolve();
        const p = this.doBringUpSession().finally(() => {
            if (this.bringUpPromise === p) this.bringUpPromise = null;
        });
        this.bringUpPromise = p;
        return p;
    }

    private async doBringUpSession(): Promise<void> {
        const myEpoch = this.syncEpoch;
        const client = this.makeVaultClient();
        this.setState("reconnecting");

        // Load checkpoints from meta store.
        try {
            await this.loadCheckpoints();
        } catch (e) {
            logVerbose(`checkpoint load error: ${e}`);
            // Start from 0 if meta is unavailable.
        }

        // Catchup pull: drain all pending remote changes before going live.
        try {
            await this.catchupPull(client, myEpoch);
        } catch (e: any) {
            if (this.syncEpoch !== myEpoch) return;
            this.enterHardError(this.classifyError(e));
            return;
        }

        // Teardown happened during catchup — discard this session.
        if (this.syncEpoch !== myEpoch) return;

        // Catchup proved the session is in a known-good state.
        this.lastHealthyAt = Date.now();
        this.client = client;
        this.running = true;
        this.startLiveSync(myEpoch);
    }

    // ── Internal: Catchup pull ────────────────────────────

    /**
     * One-shot pull using CouchClient.changes() in batches until all
     * pending remote changes are consumed. Uses an idle-based timeout:
     * if 60s pass with no progress, the catchup is aborted.
     */
    private async catchupPull(
        client: ICouchClient,
        epoch: number,
    ): Promise<void> {
        logVerbose("catchup: starting HTTP changes pull");
        this.phase = "pulling";

        let lastProgressAt = Date.now();

        while (true) {
            if (this.syncEpoch !== epoch) return;

            // Check idle timeout.
            if (Date.now() - lastProgressAt > CATCHUP_IDLE_TIMEOUT_MS) {
                logNotice("Catchup timed out (no progress for 60s)");
                throw new Error("Catchup timed out");
            }

            const result = await client.changes<CouchSyncDoc>({
                since: this.remoteSeq,
                include_docs: true,
                limit: CATCHUP_BATCH_SIZE,
            });

            if (this.syncEpoch !== epoch) return;

            if (result.results.length > 0) {
                lastProgressAt = Date.now();
                await this.writePulledDocs(result);
                logVerbose(
                    `catchup: batch ${result.results.length} docs, seq=${result.last_seq}`,
                );
            } else {
                // No more changes — catchup complete.
                logNotice(
                    `Catchup complete: seq=${result.last_seq}`,
                );
                // Update seq even on empty result (last_seq may advance).
                this.remoteSeq = result.last_seq;
                await this.saveCheckpoints();
                break;
            }
        }

        this.phase = "idle";
    }

    // ── Internal: Live sync loops ─────────────────────────

    /**
     * Start the pull and push loops running concurrently in the background.
     * Both loops check syncEpoch to self-terminate on teardown.
     */
    private startLiveSync(epoch: number): void {
        this.setState("syncing");
        this.phase = "live";

        // Fire and forget — loops self-terminate via epoch check.
        this.pullLoop(epoch).catch((e) =>
            console.error("CouchSync: pullLoop unexpected exit:", e),
        );
        this.pushLoop(epoch).catch((e) =>
            console.error("CouchSync: pushLoop unexpected exit:", e),
        );
    }

    /**
     * Long-poll pull loop. Each iteration issues a longpoll _changes
     * request, writes received docs to local, fires onChange, and probes
     * health. On empty longpoll return (timeout), fires paused + probe.
     */
    private async pullLoop(epoch: number): Promise<void> {
        while (this.syncEpoch === epoch) {
            try {
                const result = await this.client!.changesLongpoll<CouchSyncDoc>({
                    since: this.remoteSeq,
                    include_docs: true,
                });

                if (this.syncEpoch !== epoch) return;

                if (result.results.length > 0) {
                    this.phase = "pulling";
                    await this.writePulledDocs(result);
                    this.phase = "live";

                    // Probe health on activity.
                    void this.probeHealth();
                }

                // Longpoll returned (with or without changes) — treat as
                // "paused" equivalent: we're caught up for now.
                await this.handlePaused();
            } catch (e: any) {
                if (this.syncEpoch !== epoch) return;

                // Treat pull errors as transient — the loop will retry.
                this.handleTransientError(e);

                // Brief delay before retry to avoid tight error loops.
                await this.delay(2000, epoch);
            }
        }
    }

    /**
     * Poll-based push loop. Checks for local changes since lastPushedSeq
     * and pushes them to the remote via bulkDocs.
     */
    private async pushLoop(epoch: number): Promise<void> {
        while (this.syncEpoch === epoch) {
            try {
                const localChanges = await this.localDb.changes(
                    this.lastPushedSeq,
                    { include_docs: true },
                );

                if (this.syncEpoch !== epoch) return;

                // Filter to only replicated docs.
                const toPush = localChanges.results.filter(
                    (r) => r.doc && isReplicatedDocId(r.id) && !r.deleted,
                );

                if (toPush.length > 0 && this.client) {
                    const docs = toPush.map((r) => r.doc!);
                    await this.pushDocs(docs);
                }

                // Always advance the push checkpoint (even if no docs
                // matched the filter — pulled docs bump the local seq
                // and we must skip past them).
                this.lastPushedSeq = localChanges.last_seq;
                await this.saveCheckpoints();
            } catch (e: any) {
                if (this.syncEpoch !== epoch) return;
                // Push errors are logged but don't escalate — the next
                // cycle will retry.
                logVerbose(`push error: ${e?.message ?? e}`);
            }

            await this.delay(PUSH_POLL_INTERVAL_MS, epoch);
        }
    }

    // ── Internal: Doc I/O ─────────────────────────────────

    /**
     * Write pulled docs to local store and fire onChange handlers.
     * Strips remote _rev before writing (local store manages its own).
     * Updates remoteSeq and lastPushedSeq checkpoints.
     */
    private async writePulledDocs(
        result: ChangesResult<CouchSyncDoc>,
    ): Promise<void> {
        const docs: CouchSyncDoc[] = [];
        for (const row of result.results) {
            if (row.doc && !row.deleted) {
                // Strip remote _rev — local store manages its own versioning.
                const { _rev, ...rest } = row.doc as any;
                docs.push(rest as CouchSyncDoc);
            }
        }

        if (docs.length > 0) {
            this.phase = "applying";
            await this.localDb.bulkPut(docs);
            this.phase = "live";

            // Fire onChange for each pulled doc.
            for (const row of result.results) {
                if (row.doc && !row.deleted) {
                    const typed = row.doc as CouchSyncDoc;
                    for (const handler of this.onChangeHandlers) {
                        try {
                            handler(typed);
                        } catch (e) {
                            console.error("CouchSync: onChange handler error:", e);
                        }
                    }
                }
            }
        }

        // Update checkpoints.
        this.remoteSeq = result.last_seq;

        // Advance lastPushedSeq past the docs we just wrote locally, so
        // the push loop doesn't re-push them.
        try {
            const info = await this.localDb.info();
            this.lastPushedSeq = info.updateSeq;
        } catch {
            // Non-fatal: push loop will just see these and skip them
            // on next cycle (they already exist on remote).
        }

        await this.saveCheckpoints();
    }

    /**
     * Push docs to remote. Fetches current remote revs and threads them
     * onto the docs before bulkDocs, same approach as remote-couch.ts
     * pushDocs().
     */
    private async pushDocs(docs: CouchSyncDoc[]): Promise<void> {
        if (!this.client || docs.length === 0) return;

        // Strip local _rev, prepare docs for remote.
        const prepared: any[] = docs.map((d) => {
            const { _rev, ...rest } = d as any;
            return rest;
        });

        // Fetch current remote revisions for threading.
        const remoteResult = await this.client.allDocs<CouchSyncDoc>({
            keys: prepared.map((d) => d._id),
        });
        const remoteRevMap = new Map<string, string>();
        for (const row of remoteResult.rows) {
            if (row.value?.rev && !row.value?.deleted) {
                remoteRevMap.set(row.id, row.value.rev);
            }
        }
        for (const doc of prepared) {
            const remoteRev = remoteRevMap.get(doc._id);
            if (remoteRev) doc._rev = remoteRev;
        }

        const results = await this.client.bulkDocs(prepared);

        // Log denied docs (permission rejection per-doc).
        for (const res of results) {
            if (res.error === "forbidden") {
                logVerbose(`denied: push rejected for ${res.id}: ${res.reason}`);
                if (!this.deniedWarningEmitted) {
                    this.deniedWarningEmitted = true;
                    this.emitError(
                        "Some documents were denied — check CouchDB _security permissions.",
                    );
                }
            }
            // 409 conflicts are expected — the doc was updated on the
            // remote between our rev fetch and the push. Will be resolved
            // on next pull cycle.
            if (res.error === "conflict") {
                logVerbose(`push conflict for ${res.id} — will resolve on next pull`);
            }
        }
    }

    // ── Internal: Checkpoints ─────────────────────────────

    private async loadCheckpoints(): Promise<void> {
        const meta = this.localDb.getMetaStore();
        const remoteSeq = await meta.getMeta<number | string>(META_REMOTE_SEQ);
        const pushSeq = await meta.getMeta<number | string>(META_PUSH_SEQ);
        if (remoteSeq !== null) this.remoteSeq = remoteSeq;
        if (pushSeq !== null) this.lastPushedSeq = pushSeq;
        logVerbose(`checkpoints loaded: remoteSeq=${this.remoteSeq} pushSeq=${this.lastPushedSeq}`);
    }

    private async saveCheckpoints(): Promise<void> {
        try {
            const meta = this.localDb.getMetaStore();
            await meta.putMeta(META_REMOTE_SEQ, this.remoteSeq);
            await meta.putMeta(META_PUSH_SEQ, this.lastPushedSeq);
        } catch (e) {
            logVerbose(`checkpoint save error: ${e}`);
        }
    }

    // ── Internal: Error handling ──────────────────────────

    /**
     * Classify a CouchDB/fetch error into a SyncErrorDetail. Consistent
     * labelling across all error paths.
     */
    private classifyError(err: any): SyncErrorDetail {
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
     * Soft error path. We route through `reconnecting` state and give
     * TRANSIENT_ESCALATION_MS to recover before promoting to hard error.
     * Auth errors are exempt — they escalate immediately.
     */
    private handleTransientError(err: any): void {
        const detail = this.classifyError(err);
        logVerbose(
            `transient error: kind=${detail.kind} code=${detail.code ?? "-"} msg=${detail.message}`,
        );

        if (detail.kind === "auth") {
            this.enterHardError(detail);
            return;
        }

        if (this.state !== "reconnecting") {
            this.setState("reconnecting");
        }
        if (this.transientErrorTimer) clearTimeout(this.transientErrorTimer);
        this.transientErrorTimer = setTimeout(() => {
            this.transientErrorTimer = null;
            if (this.state === "reconnecting") {
                logVerbose(`transient escalated to hard error after ${TRANSIENT_ESCALATION_MS}ms`);
                this.enterHardError(detail);
            }
        }, TRANSIENT_ESCALATION_MS);
    }

    /**
     * Hard error path. Fires a one-shot Notice, pins state="error" with
     * the classified detail, and — unless it's an auth latch — kicks off
     * the dedicated backoff retry timer.
     */
    private enterHardError(detail: SyncErrorDetail): void {
        this.clearTransientErrorTimer();
        this.setState("error", detail);
        this.emitError(detail.message);

        if (detail.kind === "auth") {
            this.authError = true;
            this.teardown();
            this.stopErrorRetryTimer();
            return;
        }

        this.scheduleErrorRetry();
    }

    private scheduleErrorRetry(): void {
        if (this.errorRetryTimer) clearTimeout(this.errorRetryTimer);
        const idx = Math.min(this.errorRetryStep, ERROR_RETRY_DELAYS_MS.length - 1);
        const delay = ERROR_RETRY_DELAYS_MS[idx];
        logVerbose(`error retry scheduled in ${delay}ms (step ${this.errorRetryStep})`);
        this.errorRetryTimer = setTimeout(async () => {
            this.errorRetryTimer = null;
            this.errorRetryStep++;
            try {
                await this.requestReconnect("retry-backoff");
            } catch (e) {
                console.error("CouchSync: retry reconnect failed:", e);
            }
            if (this.state === "error") {
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

    /** Clean up everything related to error recovery. */
    private resetErrorRecovery(): void {
        this.errorRetryStep = 0;
        this.stopErrorRetryTimer();
        this.clearTransientErrorTimer();
    }

    // ── Internal: Health probing ──────────────────────────

    private async checkHealth(): Promise<void> {
        if (this.authError) return;

        if (this.state === "reconnecting" || this.state === "error") return;

        if (this.state === "disconnected") {
            try {
                await this.requestReconnect("periodic-tick");
            } catch (e) {
                console.error("CouchSync: Health check error:", e);
            }
            return;
        }

        // Connected / syncing: issue a fresh HTTP probe.
        await this.probeHealth();
    }

    /**
     * Single-flight fresh HTTP probe against the remote. Concurrent
     * callers share the same in-flight Promise.
     */
    private probeHealth(): Promise<boolean> {
        if (!this.client) return Promise.resolve(false);
        if (this.probePromise) return this.probePromise;
        this.probePromise = this.doProbe();
        return this.probePromise;
    }

    private async doProbe(): Promise<boolean> {
        const sessionEpoch = this.syncEpoch;
        const client = this.client!;
        try {
            await Promise.race([
                client.info(),
                new Promise((_, reject) =>
                    setTimeout(
                        () => reject(new Error("probe timed out")),
                        PROBE_TIMEOUT_MS,
                    ),
                ),
            ]);
            if (this.syncEpoch !== sessionEpoch) return false;
            this.lastHealthyAt = Date.now();
            logVerbose(`health: probe ok state=${this.state}`);

            if (this.state === "reconnecting" || this.state === "disconnected") {
                this.setState("syncing");
            }
            if (this.state === "syncing" && this.pausedPending) {
                this.setState("connected");
                this.firePausedCallbacks();
            }
            return true;
        } catch (e: any) {
            if (this.syncEpoch !== sessionEpoch) return false;
            logVerbose(`health: probe failed ${e?.message ?? e}`);
            this.pausedPending = false;
            this.enterHardError(this.classifyError(e));
            return false;
        } finally {
            this.probePromise = null;
        }
    }

    // ── Internal: Paused handling ─────────────────────────

    /**
     * Called when the pull longpoll returns (with or without changes).
     * Equivalent to PouchDB's `paused` event — signals we're caught up.
     */
    private async handlePaused(): Promise<void> {
        this.pausedPending = true;

        const ok = await this.probeHealth();
        if (!ok) return;

        // If doProbe already consumed pausedPending, callbacks are fired.
        // But if we shared an already-in-flight probe that started before
        // pausedPending was set, handle here.
        if (this.pausedPending) {
            if (this.state === "syncing") {
                this.setState("connected");
            }
            this.firePausedCallbacks();
        }
    }

    private firePausedCallbacks(): void {
        this.pausedPending = false;
        if (!this.hasBeenIdle) {
            this.hasBeenIdle = true;
            for (const cb of this.idleCallbacks) cb();
            this.idleCallbacks = [];
        }
        for (const handler of this.onPausedHandlers) {
            try { handler(); } catch (e) {
                console.error("CouchSync: onPaused handler error:", e);
            }
        }
    }

    // ── Internal: Environment listeners ───────────────────

    private attachEnvListeners(): void {
        if (this.envListenersAttached) return;
        window.addEventListener("offline", this.boundOnOffline);
        window.addEventListener("online", this.boundOnOnline);
        document.addEventListener("visibilitychange", this.boundOnVisibility);
        this.envListenersAttached = true;
    }

    private detachEnvListeners(): void {
        if (!this.envListenersAttached) return;
        window.removeEventListener("offline", this.boundOnOffline);
        window.removeEventListener("online", this.boundOnOnline);
        document.removeEventListener("visibilitychange", this.boundOnVisibility);
        this.envListenersAttached = false;
    }

    private startHealthTimer(): void {
        if (this.healthTimer) return;
        this.healthTimer = setInterval(() => this.checkHealth(), HEALTH_CHECK_INTERVAL);
    }

    private stopHealthTimer(): void {
        if (!this.healthTimer) return;
        clearInterval(this.healthTimer);
        this.healthTimer = null;
    }

    private handleVisibilityChange(visible: boolean): void {
        if (!visible) {
            this.backgroundedAt = Date.now();
            return;
        }
        const hiddenMs = this.backgroundedAt
            ? Date.now() - this.backgroundedAt
            : 0;
        this.backgroundedAt = 0;
        const reason: ReconnectReason =
            this.isMobile || hiddenMs >= 30_000
                ? "app-resume"
                : "app-foreground";
        void this.requestReconnect(reason);
    }

    private handleOffline(): void {
        if (this.state === "connected" || this.state === "syncing") {
            this.setState("disconnected");
            this.emitError("Network offline");
        }
    }

    private handleOnline(): void {
        void this.requestReconnect("network-online");
        if (this.state === "disconnected" || this.state === "error") {
            for (const handler of this.onReconnectHandlers) {
                try {
                    handler();
                } catch (e) {
                    console.error("CouchSync: onReconnect handler error:", e);
                }
            }
        }
    }

    // ── Internal: Verify reachability ─────────────────────

    /** Verify the server can be reached. On failure, transitions to hard
     *  error and returns false. */
    private async verifyReachable(): Promise<boolean> {
        const err = await this.testConnection();
        if (err) {
            const detail = this.classifyError({ message: err });
            if (detail.kind === "unknown") {
                detail.kind = "network";
                detail.message = `Server unreachable: ${err}`;
            }
            if (this.state !== "error") {
                this.enterHardError(detail);
            }
            return false;
        }
        return true;
    }

    // ── Internal: Helpers ─────────────────────────────────

    /** Build a CouchClient for the vault database. */
    private makeVaultClient(): CouchClient {
        const s = this.getSettings();
        return makeCouchClient(
            s.couchdbUri, s.couchdbDbName, s.couchdbUser, s.couchdbPassword,
        );
    }

    /** Epoch-aware delay. Resolves immediately if epoch has changed. */
    private delay(ms: number, epoch: number): Promise<void> {
        return new Promise((resolve) => {
            if (this.syncEpoch !== epoch) {
                resolve();
                return;
            }
            setTimeout(resolve, ms);
        });
    }
}
