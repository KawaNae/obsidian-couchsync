import PouchDB from "pouchdb-browser/lib/index.js";
import type { CouchSyncDoc } from "../types.ts";
import type { LocalDB } from "./local-db.ts";
import type { CouchSyncSettings } from "../settings.ts";
import * as remoteCouch from "./remote-couch.ts";
import {
    decideReconnect,
    type ReconnectReason,
    type SyncState,
    type SyncErrorDetail,
    type SyncErrorKind,
} from "./reconnect-policy.ts";
import { logVerbose, logNotice } from "../ui/log.ts";

// Re-export so existing imports of `SyncState` from "./replicator" keep
// working. The canonical home is `reconnect-policy.ts` because it's the
// only module that needs to be importable from node tests.
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

const HEALTH_CHECK_INTERVAL = 30000; // 30s
const CATCHUP_IDLE_TIMEOUT_MS = 60000; // abort catchup after 60s of no progress
const PROBE_TIMEOUT_MS = 5000; // fresh-HTTP probe in checkHealth()

/** Build identifier, logged at start(). Lets us verify on mobile that a
 *  deployed plugin update actually reached the device (Obsidian Sync can
 *  lag or silently fail). Bump when shipping behavioral changes. */
const BUILD_TAG = "probe-gated-transitions-v0.11.3";

/** How long to keep a transient error in `reconnecting` state before
 *  escalating to hard `error`. PouchDB's `retry:true` normally recovers
 *  well within this window, so most transient hiccups stay invisible. */
const TRANSIENT_ESCALATION_MS = 10_000;

/** Backoff delays used after escalation into hard error state. Capped at
 *  the last entry — a permanently-down server is polled every 30s. */
const ERROR_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000, 20_000, 30_000];

export class Replicator {
    private sync: PouchDB.Replication.Sync<CouchSyncDoc> | null = null;
    private state: SyncState = "disconnected";
    private onChangeHandlers: OnChangeHandler[] = [];
    private onStateChangeHandlers: OnStateChangeHandler[] = [];
    private onErrorHandlers: OnErrorHandler[] = [];
    private healthTimer: ReturnType<typeof setInterval> | null = null;
    private boundOnOffline = () => this.handleOffline();
    private boundOnOnline = () => this.handleOnline();
    private boundOnVisibility = () =>
        this.handleVisibilityChange(document.visibilityState === "visible");
    private backgroundedAt = 0;
    private lastRestartTime = 0;
    /** Wall-clock time of the most recent proof the session is healthy.
     *  Updated from two sources only: catchup completion, and a successful
     *  `remoteDb.info()` probe in `checkHealth()`. Both are fresh HTTP
     *  round-trips, so asymmetric network faults (e.g. Tailscale down
     *  mid-session) can't spoof health via stale PouchDB events. Status
     *  bar displays this as "X ago"; survives teardown so disconnected/
     *  error states can still show "(last seen X ago)". */
    private lastHealthyAt = 0;
    /** Dedup for concurrent bringUpSession() calls — any parallel invoker
     *  awaits the same in-flight Promise instead of spawning a second
     *  catchup. Cleared on teardown so a subsequent start() after stop()
     *  kicks off a fresh session. */
    private bringUpPromise: Promise<void> | null = null;
    /** Live handle on the running catchup replication so teardown() can
     *  cancel it. Cleared when the replication settles. */
    private activeCatchup: PouchDB.Replication.Replication<CouchSyncDoc> | null = null;
    /** Guards against double-attach of env listeners across restarts. */
    private envListenersAttached = false;

    /** Detail of the current hard error, if state === "error". Null otherwise.
     *  Exposed via getLastErrorDetail() so the status bar can render
     *  `Error (401)` / `Error (timeout)` labels without needing the
     *  ephemeral Notice. */
    private lastErrorDetail: SyncErrorDetail | null = null;

    /** Armed on transient live-sync errors. If nothing recovers within
     *  TRANSIENT_ESCALATION_MS, the transient state is promoted to a
     *  hard error. Cleared on any successful state transition. */
    private transientErrorTimer: ReturnType<typeof setTimeout> | null = null;

    /** Schedules the next backoff retry while in hard-error state.
     *  Replaces `checkHealth`'s error-state polling — one source of
     *  truth for retry cadence. */
    private errorRetryTimer: ReturnType<typeof setTimeout> | null = null;

    /** Single-flight Promise for `probeHealth()`. Rapid-fire change events
     *  (e.g. multi-file save) share one in-flight round-trip via the same
     *  Promise. `handlePaused` awaits this to gate callbacks on probe
     *  completion. */
    private probePromise: Promise<boolean> | null = null;

    /** Set by `handlePaused(no err)`, consumed by `doProbe` on success.
     *  When true, a successful probe promotes syncing → connected and
     *  fires idle/paused callbacks. */
    private pausedPending = false;

    /** Index into ERROR_RETRY_DELAYS_MS. Incremented on each retry,
     *  reset on successful transition to syncing/connected. */
    private errorRetryStep = 0;

    /** Latch so we emit at most one warning Notice per `denied` storm.
     *  Reset on teardown/stop so a fresh session can warn again. */
    private deniedWarningEmitted = false;
    /**
     * Latched on 401/403 to stop retry storms. Cleared only when the user
     * explicitly starts sync again (which implies they've updated
     * credentials). Health checks, reconnect handlers, and paused-event
     * restarts all no-op while this is true.
     */
    private authError = false;
    private remoteDb: PouchDB.Database<CouchSyncDoc> | null = null;
    private idleCallbacks: (() => void)[] = [];
    private hasBeenIdle = false;
    private phase: SyncPhase = "idle";
    private onReconnectHandlers: (() => void)[] = [];
    private onPausedHandlers: (() => void)[] = [];
    /** Incremented on every teardown so async handlers (handlePaused)
     *  can detect their sync session was replaced mid-flight. */
    private syncEpoch = 0;

    constructor(
        private localDb: LocalDB,
        private getSettings: () => CouchSyncSettings,
        private isMobile: boolean = false,
    ) {}

    getState(): SyncState {
        return this.state;
    }

    onChange(handler: OnChangeHandler): void {
        this.onChangeHandlers.push(handler);
    }

    onStateChange(handler: OnStateChangeHandler): void {
        this.onStateChangeHandlers.push(handler);
    }

    onError(handler: OnErrorHandler): void {
        this.onErrorHandlers.push(handler);
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
     * network-facing code paths (sync, settings-tab fetches, suggestion
     * lookups) should check this before issuing requests to avoid tripping
     * CouchDB's brute-force lockout with a burst of 401s.
     */
    isAuthBlocked(): boolean {
        return this.authError;
    }

    /**
     * Latch the auth-blocked flag from outside the replicator (e.g. from
     * Settings tab fetches that get 401/403). Emits the error so existing
     * onError consumers see it, and pins state to "error".
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

    /** Register callback for network reconnection (called instead of direct restart) */
    onReconnect(handler: () => void): void {
        this.onReconnectHandlers.push(handler);
    }

    /** Register callback for sync paused (all batches transferred, caught up) */
    onPaused(handler: () => void): void {
        this.onPausedHandlers.push(handler);
    }

    /** Register callback to fire once initial sync reaches idle state */
    onceIdle(callback: () => void): void {
        if (this.hasBeenIdle) {
            callback();
            return;
        }
        this.idleCallbacks.push(callback);
    }

    private setState(state: SyncState, errorDetail?: SyncErrorDetail): void {
        // Always allow re-emit for error state so a kind change (e.g.
        // network → timeout on subsequent retries) reaches the UI.
        if (this.state === state && state !== "error") return;

        const wasError = this.state === "error";
        this.state = state;

        if (state === "error") {
            this.lastErrorDetail = errorDetail ?? null;
        } else {
            this.lastErrorDetail = null;
            // Recovering out of error: cancel any running backoff retry
            // and reset the step so the next failure starts fresh at 2s.
            if (wasError && (state === "syncing" || state === "connected")) {
                this.resetErrorRecovery();
            }
            // Any non-error state cancels a pending transient escalation:
            // if we reach syncing/connected the sync is healthy, and if
            // we explicitly move to disconnected/reconnecting the caller
            // already decided what to do.
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

    private getRemoteUrl(): string {
        const settings = this.getSettings();
        const url = new URL(settings.couchdbUri);
        url.pathname = url.pathname.replace(/\/$/, "") + "/" + settings.couchdbDbName;
        if (settings.couchdbUser) {
            url.username = settings.couchdbUser;
            url.password = settings.couchdbPassword;
        }
        return url.toString();
    }

    /**
     * Session-internal cleanup: cancel the running sync + catchup, close
     * remote DB, drop session-scoped state. Does NOT touch env listeners
     * or the health timer — those are owned by the user-driven lifecycle
     * (start/stop) so they survive restart() and span catchup too.
     *
     * Does NOT emit a state change — the caller decides.
     */
    private teardown(): void {
        this.syncEpoch++;
        // Invalidate dedup so a future start() spawns a fresh catchup
        // instead of awaiting the (now being torn down) one.
        this.bringUpPromise = null;
        if (this.activeCatchup) {
            try { this.activeCatchup.cancel(); } catch { /* ignore */ }
            this.activeCatchup = null;
        }
        if (this.sync) {
            // Remove listeners BEFORE cancel — cancel() triggers a
            // `complete` event asynchronously. Without this, the stale
            // handler would fire setState("disconnected") and override
            // the reconnecting/syncing state set by restart().
            (this.sync as any).removeAllListeners();
            this.sync.cancel();
            this.sync = null;
        }
        if (this.remoteDb) {
            this.remoteDb.close();
            this.remoteDb = null;
        }
        this.hasBeenIdle = false;
        this.idleCallbacks = [];
        this.phase = "idle";
        this.deniedWarningEmitted = false;
        this.pausedPending = false;
        this.probePromise = null;
        // lastHealthyAt intentionally NOT reset: the status bar should
        // keep showing "(last seen X ago)" in disconnected/error states
        // until a fresh session produces a newer timestamp.
        // lastErrorDetail likewise survives — the caller (stop/restart)
        // chooses what state to transition to and whether to clear it.
    }

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

    /**
     * Classify a PouchDB/fetch error into a SyncErrorDetail. Lifted out of
     * the individual error sites so all paths get consistent labels.
     *
     * Priority:
     *   1. HTTP status (most reliable signal): 401/403 → auth, 5xx → server
     *   2. Message substring for timeout / network idioms
     *   3. Fallback: unknown
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
     * Soft error path. PouchDB's `retry:true` is already working on it
     * behind the scenes; we keep the UI honest by staying in
     * `reconnecting`, and give it TRANSIENT_ESCALATION_MS to recover
     * before emitting a user-visible error.
     *
     * If a subsequent change/active/paused(ok) event arrives first, the
     * state transition to syncing/connected will clear the timer and the
     * whole blip is invisible.
     *
     * Auth errors are exempt — they never self-recover, so they escalate
     * immediately.
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
            // If PouchDB has already recovered, state is syncing/connected
            // and this escalation is a no-op.
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
            // Latch: no auto-retry. User must fix credentials and
            // explicitly call start() again.
            this.authError = true;
            if (this.sync) {
                (this.sync as any).removeAllListeners();
                this.sync.cancel();
                this.sync = null;
            }
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
            // Funnel through the gateway so the auth latch etc. still apply.
            try {
                await this.requestReconnect("retry-backoff");
            } catch (e) {
                console.error("CouchSync: retry reconnect failed:", e);
            }
            // Self-chain: if the retry didn't recover us, schedule the
            // next backoff step. Successful recovery calls
            // resetErrorRecovery() via setState() and leaves state !==
            // "error", so we naturally stop here.
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

    /** Clean up everything related to error recovery. Called on
     *  successful transition out of error, on teardown, and on stop. */
    private resetErrorRecovery(): void {
        this.errorRetryStep = 0;
        this.stopErrorRetryTimer();
        this.clearTransientErrorTimer();
    }

    /**
     * Restart sync session (preserves PouchDB checkpoint).
     *
     * Goes through bringUpSession() so the new live sync is gated on a
     * one-shot catchup pull completing. env listeners and health timer
     * survive the restart (owned by start/stop, not teardown), so catchup
     * itself is observable — if the app backgrounds or the health tick
     * fires mid-catchup, those paths still run.
     */
    private async restart(): Promise<void> {
        this.lastRestartTime = Date.now();
        this.teardown();
        await this.bringUpSession();
    }

    /**
     * Single entry point for every reconnect request. Funnels:
     *
     *   - window.online                       → "network-online"
     *   - mobile/desktop visibilitychange     → "app-foreground"
     *   - 30s health check timer (dead state) → "periodic-tick"
     *   - 30s health check timer (stalled)    → "stalled"
     *   - Command Palette / Maintenance btn   → "manual"
     *
     * The policy decision is delegated to `decideReconnect()` (a pure
     * function in reconnect-policy.ts that's unit-tested separately).
     * This method only:
     *   1. Reads current Replicator state
     *   2. Calls the policy
     *   3. Acts on the returned decision (skip / restart / verify-then-restart)
     *
     * That makes adding a new trigger trivial: just call this method
     * with a fresh `ReconnectReason`. No risk of bypassing the auth
     * latch, the cool-down, or any state-specific guard.
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

        // verify-then-restart keeps the pre-flight ping so a transient error
        // doesn't tear down a still-recovering retry:true session. The real
        // safety net is the catchup pull inside bringUpSession(), which
        // definitively verifies the new session has pulled pending changes.
        if (decision === "verify-then-restart") {
            this.setState("reconnecting");
            if (!(await this.verifyReachable())) return;
        } else {
            this.setState("reconnecting");
        }

        logNotice(`Reconnect (${reason}): restarting`);
        await this.restart();
    }

    /**
     * Public lifecycle entry. Attaches env listeners and the health timer
     * once per user-driven lifecycle, then kicks off a session.
     *
     * The session pipeline — prepareRemoteDb → setState("reconnecting") →
     * catchupPull (await) → startLiveSync → setState("syncing"/"connected") —
     * is also used by restart(). The catchup pull is the key to avoiding
     * "false connected" state: the subsequent live sync's `paused` event
     * is only trusted after catchup has drained pending remote changes.
     */
    async start(): Promise<void> {
        if (this.sync) return;
        logVerbose(`replicator start (build=${BUILD_TAG})`);
        // An explicit start() call means the user is trying again — assume
        // they've fixed their credentials and allow retries from here on.
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
     * Dedup wrapper. Concurrent callers (e.g. start() from onload while
     * a periodic-tick reconnect is also in flight) share the same
     * in-flight Promise instead of spawning a second catchup.
     */
    private bringUpSession(): Promise<void> {
        if (this.bringUpPromise) return this.bringUpPromise;
        if (this.sync) return Promise.resolve();
        if (this.authError) return Promise.resolve();
        const p = this.doBringUpSession().finally(() => {
            // Only clear if still ours — teardown() may have already
            // null'd this to invalidate dedup for a new start() cycle.
            if (this.bringUpPromise === p) this.bringUpPromise = null;
        });
        this.bringUpPromise = p;
        return p;
    }

    private async doBringUpSession(): Promise<void> {
        const myEpoch = this.syncEpoch;
        const remoteDb = this.prepareRemoteDb();
        this.setState("reconnecting");

        try {
            await this.catchupPull(remoteDb);
        } catch (e: any) {
            remoteDb.close();
            // Cancellation via teardown() shows up as an error — that's
            // not a user-visible failure, the new session (if any) will
            // set its own state.
            if (this.syncEpoch !== myEpoch) return;
            // catchup is a one-shot: the internal idle timeout has already
            // given it 60s. Escalate straight to hard error, no transient
            // soft path.
            this.enterHardError(this.classifyError(e));
            return;
        }

        // Another teardown happened during catchup — discard this session.
        if (this.syncEpoch !== myEpoch) {
            remoteDb.close();
            return;
        }

        // Catchup just proved the session is in a known-good state.
        this.lastHealthyAt = Date.now();
        this.remoteDb = remoteDb;
        this.startLiveSync();
    }

    private prepareRemoteDb(): PouchDB.Database<CouchSyncDoc> {
        const remoteUrl = this.getRemoteUrl();
        return new PouchDB<CouchSyncDoc>(remoteUrl, {
            skip_setup: true,
        });
    }

    /**
     * One-shot pull replication with an idle-based timeout.
     *
     * PouchDB's `replicate.from()` fires a `change` event per batch; we
     * use that as a progress signal. If 60s pass with no progress, we
     * cancel the replication and reject — preventing the "stuck in
     * Reconnecting..." state when a mobile socket silently dies mid-catchup.
     *
     * Absolute timeout would incorrectly abort a large first-sync pulling
     * thousands of docs over a slow network. Idle-based tolerates slow but
     * progressing transfers.
     *
     * The active replication handle is stored in `activeCatchup` so
     * `teardown()` can cancel it from the outside.
     */
    private catchupPull(remoteDb: PouchDB.Database<CouchSyncDoc>): Promise<void> {
        const db = this.localDb.getDb();
        logVerbose("catchup: starting one-shot pull");
        return new Promise<void>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | null = null;
            let settled = false;
            const rep = db.replicate.from(remoteDb, {
                batch_size: 50,
                batches_limit: 5,
            });
            this.activeCatchup = rep as any;

            const finish = (fn: () => void) => {
                if (settled) return;
                settled = true;
                if (timer) { clearTimeout(timer); timer = null; }
                if (this.activeCatchup === (rep as any)) this.activeCatchup = null;
                fn();
            };
            const armTimer = () => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => {
                    finish(() => {
                        logNotice("Catchup timed out (no progress for 60s)");
                        try { rep.cancel(); } catch { /* ignore */ }
                        reject(new Error("Catchup timed out"));
                    });
                }, CATCHUP_IDLE_TIMEOUT_MS);
            };

            rep.on("change", () => armTimer());
            rep.on("complete", (info: any) => finish(() => {
                logNotice(
                    `Catchup complete: docs_read=${info?.docs_read ?? 0} last_seq=${info?.last_seq ?? "?"}`,
                );
                resolve();
            }));
            rep.on("error", (err: any) => finish(() => reject(err)));

            armTimer();
        });
    }

    private startLiveSync(): void {
        if (!this.remoteDb) return;
        const db = this.localDb.getDb();
        this.sync = db.sync(this.remoteDb, {
            live: true,
            retry: true,
            batch_size: 50,
            batches_limit: 5,
            timeout: 30000,
            heartbeat: 10000,
            back_off_function: (delay: number) => {
                if (delay === 0) return 1000;
                return Math.min(delay * 2, 60000);
            },
        } as any); // PouchDB types don't include timeout/heartbeat/back_off_function

        this.sync.on("change", (info) => {
            void this.probeHealth();

            if (info.direction === "pull" && info.change?.docs) {
                for (const doc of info.change.docs) {
                    const typed = doc as unknown as CouchSyncDoc;
                    for (const handler of this.onChangeHandlers) {
                        try {
                            handler(typed);
                        } catch (e) {
                            console.error("CouchSync: onChange handler error:", e);
                        }
                    }
                }
            }
        });

        // PouchDB's event emitter doesn't await listeners; wrap async work in
        // a non-async callback so rejections surface as logged errors instead
        // of unhandled promise warnings.
        this.sync.on("paused", (err) => {
            this.handlePaused(err).catch((e) =>
                console.error("CouchSync: paused handler error:", e),
            );
        });

        this.sync.on("active", () => {
            this.setState("syncing");
            void this.probeHealth();
        });

        this.sync.on("denied", (err) => {
            // `denied` is a per-doc permission rejection. The replication
            // session continues processing other docs, so promoting this
            // to state=error would lie about the overall session health.
            // Log always; emit a one-shot warning Notice so the user
            // knows to check their _security doc.
            logVerbose(`denied: ${(err as any)?.message ?? String(err)}`);
            if (!this.deniedWarningEmitted) {
                this.deniedWarningEmitted = true;
                this.emitError(
                    "Some documents were denied — check CouchDB _security permissions.",
                );
            }
        });

        this.sync.on("error", (err) => {
            logVerbose(`sync error: ${(err as any)?.message ?? String(err)}`);
            // Non-auth sync errors are almost always transient — PouchDB's
            // retry:true machinery is already reconnecting behind the
            // scenes. Route through the soft path; auth gets escalated
            // immediately via classifyError.
            this.handleTransientError(err);
        });

        // Note: no `complete` handler. `live:true + retry:true` sync
        // never completes on its own, and teardown() already removes all
        // listeners before cancel(), so the event can't reach us anyway.

        this.setState("syncing");
    }

    /**
     * One-shot push of the entire vault local DB to the vault remote.
     * Used by SetupService.init() and similar bootstrap flows. Generic
     * push/pull/list helpers live in `remote-couch` and are called
     * directly by ConfigSync against its own remote.
     */
    async pushToRemote(onProgress?: (docId: string, count: number) => void): Promise<number> {
        const remoteUrl = this.getRemoteUrl();
        const remoteDb = new PouchDB<CouchSyncDoc>(remoteUrl, {});
        try {
            return await remoteCouch.pushAll(this.localDb.getDb(), remoteDb, onProgress);
        } finally {
            await remoteDb.close();
        }
    }

    /** One-shot pull of the entire vault remote → local. */
    async pullFromRemote(
        onProgress?: (docId: string, count: number) => void,
    ): Promise<{ written: number; docs: CouchSyncDoc[] }> {
        const remoteUrl = this.getRemoteUrl();
        const remoteDb = new PouchDB<CouchSyncDoc>(remoteUrl, {});
        try {
            return await remoteCouch.pullAll(this.localDb.getDb(), remoteDb, onProgress);
        } finally {
            await remoteDb.close();
        }
    }

    /** Destroy the vault remote database (auto-recreated on next push). */
    async destroyRemote(): Promise<void> {
        const remoteUrl = this.getRemoteUrl();
        const remoteDb = new PouchDB<CouchSyncDoc>(remoteUrl, {});
        await remoteCouch.destroyRemote(remoteDb);
    }

    /** Test connection with explicit credentials (for unsaved draft values) */
    async testConnectionWith(
        uri: string, user: string, pass: string, db: string
    ): Promise<string | null> {
        try {
            const url = new URL(uri);
            url.pathname = url.pathname.replace(/\/$/, "") + "/" + db;
            if (user) { url.username = user; url.password = pass; }
            const remoteDb = new PouchDB(url.toString(), {});
            await remoteDb.info();
            await remoteDb.close();
            return null;
        } catch (e: any) {
            return e.message || "Connection failed";
        }
    }

    /** Test connection using saved settings. Reuses the live remote DB
     *  instance when available so we don't allocate a fresh PouchDB on every
     *  health probe. */
    async testConnection(): Promise<string | null> {
        if (this.remoteDb) {
            try {
                await this.remoteDb.info();
                return null;
            } catch (e: any) {
                return e.message || "Connection failed";
            }
        }
        const s = this.getSettings();
        return this.testConnectionWith(s.couchdbUri, s.couchdbUser, s.couchdbPassword, s.couchdbDbName);
    }

    private async checkHealth(): Promise<void> {
        if (this.authError) return;

        // Reconnecting: a restart is already in flight, don't interfere.
        // Error: the dedicated backoff retry timer is the single source
        // of truth for retry cadence — racing it with a periodic-tick
        // reconnect would double-fire.
        if (this.state === "reconnecting" || this.state === "error") return;

        // Disconnected: nothing to probe, just try to come back up.
        if (this.state === "disconnected") {
            try {
                await this.requestReconnect("periodic-tick");
            } catch (e) {
                console.error("CouchSync: Health check error:", e);
            }
            return;
        }

        // Connected / syncing: issue a fresh HTTP probe. This is the
        // single source of truth for `lastHealthyAt` and for catching
        // asymmetric faults. PouchDB's own events are ambiguous under
        // partial connectivity (pull longpoll can return empty while
        // push is failing), so we can't infer health from them.
        await this.probeHealth();
    }

    /**
     * Single-flight fresh HTTP probe against the remote. Concurrent
     * callers share the same in-flight Promise; `handlePaused` awaits
     * it to gate callbacks on probe completion.
     */
    private probeHealth(): Promise<boolean> {
        if (!this.remoteDb) return Promise.resolve(false);
        if (this.probePromise) return this.probePromise;
        this.probePromise = this.doProbe();
        return this.probePromise;
    }

    private async doProbe(): Promise<boolean> {
        const remoteDb = this.remoteDb!;
        try {
            await Promise.race([
                remoteDb.info(),
                new Promise((_, reject) =>
                    setTimeout(
                        () => reject(new Error("probe timed out")),
                        PROBE_TIMEOUT_MS,
                    ),
                ),
            ]);
            if (this.remoteDb !== remoteDb) return false;
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
            if (this.remoteDb !== remoteDb) return false;
            logVerbose(`health: probe failed ${e?.message ?? e}`);
            this.pausedPending = false;
            this.enterHardError(this.classifyError(e));
            return false;
        } finally {
            this.probePromise = null;
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

    private async handlePaused(err: unknown): Promise<void> {
        if (err) {
            this.handleTransientError(err);
            return;
        }

        this.pausedPending = true;

        const ok = await this.probeHealth();
        if (!ok) return;

        // If doProbe already consumed pausedPending (it was set before
        // the probe started), callbacks are already fired. But if we
        // shared an already-in-flight probe that started before
        // pausedPending was set, doProbe didn't see it — handle here.
        if (this.pausedPending) {
            if (this.state === "syncing") {
                this.setState("connected");
            }
            this.firePausedCallbacks();
        }
    }

    /** Verify the server can be reached. On failure, transitions to hard
     *  error (which starts the backoff retry timer) and returns false. */
    private async verifyReachable(): Promise<boolean> {
        const err = await this.testConnection();
        if (err) {
            // testConnection returns a string, not an Error. Wrap it so
            // classifyError's regex still matches network-ish messages.
            const detail = this.classifyError({ message: err });
            // If classification falls to "unknown", treat unreachable
            // pings as network issues — that's the usual cause.
            if (detail.kind === "unknown") {
                detail.kind = "network";
                detail.message = `Server unreachable: ${err}`;
            }
            // Only transition if we're not already in a hard error — a
            // verify from an already-backing-off state shouldn't reset
            // the timer, just confirm we're stuck.
            if (this.state !== "error") {
                this.enterHardError(detail);
            }
            return false;
        }
        return true;
    }

    /**
     * Called on every visibilitychange event. Tracks how long the app was
     * hidden and decides whether to use "app-foreground" (brief hide,
     * trust the session) or "app-resume" (long hide or mobile, verify
     * because the socket may have been silently killed by the OS).
     *
     * Symmetric with handleOnline/handleOffline — Replicator owns the
     * full set of environment-change handlers.
     */
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
        // Funnel through the gateway. The gateway handles auth latch,
        // cool-down, and the state-aware decision; we only need to
        // also fire the onReconnect handlers (used by main.ts to
        // trigger a reconcile pass after the live session resumes).
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
}
