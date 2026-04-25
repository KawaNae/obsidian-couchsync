/**
 * SyncEngine — live sync loop supervisor.
 *
 * Owns the state machine (`SyncState`) and the single retry timer. All
 * other collaborators are injected or embedded:
 *   - SyncSession: the live per-session client + pipelines
 *   - Checkpoints: durable sync progress markers
 *   - AuthGate: 401/403 latch
 *   - BackoffSchedule: pure step counter for retry delays
 *   - EnvListeners: window.online / visibilitychange wiring
 *
 * Retry is supervised here, not in a sub-object. Every failure path
 * routes through `enterError(detail)`, which bumps the backoff and
 * schedules exactly one retry timer. The timer callback runs
 * `attemptReconnect()` once. If that call `enterError`s again, the next
 * retry is scheduled inside that call — never from both sides. This
 * structural rule makes "error retry scheduled" log at most once per
 * tick, which was the root cause of the v0.15.x infinite-retry storm.
 */

import type { FileDoc, ChunkDoc } from "../types.ts";
import type { LocalDB } from "./local-db.ts";
import type { CouchSyncSettings } from "../settings.ts";
import type { ICouchClient } from "./interfaces.ts";
import type { ConflictResolver } from "../conflict/conflict-resolver.ts";
import { filePathFromId } from "../types/doc-id.ts";
import { makeCouchClient } from "./couch-client.ts";
import { decideReconnect } from "./reconnect-policy.ts";
import type {
    ReconnectReason,
    SyncState,
    SyncErrorDetail,
} from "./reconnect-policy.ts";
import { logDebug, logInfo, logWarn, logError, notify } from "../ui/log.ts";
import { EnvListeners } from "./env-listeners.ts";
import { DbError } from "./write-transaction.ts";
import { AuthGate } from "./sync/auth-gate.ts";
import { SyncEvents } from "./sync/sync-events.ts";
import { Checkpoints } from "./sync/checkpoints.ts";
import { SyncSession } from "./sync/sync-session.ts";
import { BackoffSchedule } from "./sync/backoff.ts";
import { classifyError } from "./sync/errors.ts";
import { BrowserVisibilityGate, ALWAYS_VISIBLE, type VisibilityGate } from "./visibility-gate.ts";

// ── Constants ────────────────────────────────────────────

const HEALTH_CHECK_INTERVAL = 30000; // 30s

/** How long a transient error stays in `reconnecting` before escalating
 *  to a hard `error`. The live session may self-heal inside this window. */
const TRANSIENT_ESCALATION_MS = 10_000;

/** Upper bound on `info()` during verifyReachable. The default HTTP
 *  timeout is 30s — too long for a reachability probe.
 *
 *  - `app-resume` / `network-online` use 15s because the mobile network
 *    stack often takes several seconds to come back after suspend
 *    (2026-04-22 main vault log: 5001ms abort followed by 18s recovery
 *    via retry-backoff). A longer ceiling on these reasons absorbs the
 *    slow-revival case in one round-trip.
 *  - All other reasons (retry-backoff, periodic-tick, etc.) stay at 5s.
 */
const VERIFY_REACHABLE_TIMEOUT_FAST_MS = 5_000;
const VERIFY_REACHABLE_TIMEOUT_RESUME_MS = 15_000;

/** Pick the verify-reachable timeout for a reconnect reason. Exported
 *  for unit testing — production calls go through `verifyReachable`. */
export function verifyTimeoutMs(reason: ReconnectReason): number {
    if (reason === "app-resume" || reason === "network-online") {
        return VERIFY_REACHABLE_TIMEOUT_RESUME_MS;
    }
    return VERIFY_REACHABLE_TIMEOUT_FAST_MS;
}

// ── SyncEngine ───────────────────────────────────────────

export class SyncEngine {
    /** Typed event bus. External subscribers use `events.on(...)` / `events.onAsync(...)`. */
    readonly events = new SyncEvents();

    /** Auth latch. External callers read `auth.isBlocked()` and call `auth.raise/clear`. */
    readonly auth: AuthGate;

    // ── State ─────────────────────────────────────────────

    private state: SyncState = "disconnected";
    private lastHealthyAt = 0;
    private lastErrorDetail: SyncErrorDetail | null = null;
    private lastRestartTime = 0;

    /** Last remote update_seq seen by stall detection. Compared against
     *  our consumed remoteSeq to detect a stalled pull loop. */
    private lastObservedRemoteSeq: number | string = 0;

    // ── Session management ────────────────────────────────

    /** Current live session. null when disconnected, in error, or
     *  between restart() teardown and the next openSession(). */
    private session: SyncSession | null = null;

    // ── Diagnostics ───────────────────────────────────────

    /** Monotonic id stamped on each `requestReconnect` chain so parallel
     *  reconnects can be told apart in the log (see B/C race analysis). */
    private reconnectCounter = 0;

    /** Monotonic id stamped on each SyncSession so pipeline logs and
     *  teardown diagnostics can distinguish new vs. old (still-draining)
     *  sessions. */
    private sessionEpoch = 0;

    // ── Reconnect single-flight guard ─────────────────────

    /** Promise of the currently-running reconnect chain (or null if
     *  none). New callers observe this and either drop or queue one
     *  follow-up by priority. Prevents the sess#N cascade where app-
     *  resume and retry-backoff both attempted restart. */
    private reconnectInFlight: Promise<void> | null = null;
    private reconnectInFlightReason: ReconnectReason | null = null;
    /** At most one queued follow-up reason (the highest-priority one
     *  seen while in-flight). Fires after the current chain finishes. */
    private queuedReconnectReason: ReconnectReason | null = null;

    // ── Error handling ────────────────────────────────────

    /** Pure backoff step counter. Reset only via `backoff.recordSuccess()`. */
    private readonly backoff = new BackoffSchedule();
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private transientTimer: ReturnType<typeof setTimeout> | null = null;
    /** True once a degraded local DB has been surfaced to the user; stops
     *  further retry attempts until the user restarts Obsidian or calls
     *  `start()` again. */
    private degraded = false;

    // ── Timers & env listeners ────────────────────────────

    private healthTimer: ReturnType<typeof setInterval> | null = null;

    private readonly envListeners = new EnvListeners({
        getState: () => this.state,
        setState: (s) => this.setState(s),
        emitError: (m) => this.events.emit("error", { message: m }),
        requestReconnect: (r) => this.requestReconnect(r),
        fireReconnectHandlers: () => this.events.emit("reconnect"),
        isMobile: this.isMobile,
    });

    /** Pauses live loops while the page is hidden. iOS Safari aborts
     *  IndexedDB transactions on visibilitychange→hidden; without this
     *  gate the push loop exhausts HandleGuard's reopen budget. Falls
     *  back to ALWAYS_VISIBLE in non-browser test contexts. */
    private readonly visibility: VisibilityGate =
        typeof document !== "undefined"
            ? new BrowserVisibilityGate(document)
            : ALWAYS_VISIBLE;

    // ── Checkpoints ───────────────────────────────────────

    /** Persistent sync progress markers (remoteSeq, lastPushedSeq).
     *  Owned by SyncEngine because they survive across sessions. */
    private readonly checkpoints: Checkpoints;

    // ── Constructor ───────────────────────────────────────

    private readonly clientFactory: (s: CouchSyncSettings) => ICouchClient;

    constructor(
        private localDb: LocalDB,
        private getSettings: () => CouchSyncSettings,
        private isMobile: boolean = false,
        auth?: AuthGate,
        clientFactory?: (s: CouchSyncSettings) => ICouchClient,
    ) {
        this.auth = auth ?? new AuthGate();
        this.clientFactory = clientFactory ?? ((s) =>
            makeCouchClient(s.couchdbUri, s.couchdbDbName, s.couchdbUser, s.couchdbPassword)
        );
        this.checkpoints = new Checkpoints(localDb);

        // External raise (Settings tab probe, config-sync) → pin state=error
        // so the status bar and onError listeners see the auth latch.
        this.auth.onChange((detail) => {
            if (!detail) return;
            if (this.state === "error") return;
            this.setState("error", {
                kind: "auth",
                code: detail.status,
                message:
                    `Authentication failed (${detail.status})${detail.reason ? ": " + detail.reason : ""}. ` +
                    `Update credentials in the Connection tab.`,
            });
            this.stopRetryTimer();
            void this.teardown();
        });

        // Pipelines emit "paused" after applying a batch. SyncEngine owns
        // lastHealthyAt and updates it here.
        this.events.on("paused", () => {
            if (this.state === "connected" || this.state === "syncing") {
                this.lastHealthyAt = Date.now();
            }
        });
    }

    setConflictResolver(resolver: ConflictResolver): void {
        this.conflictResolver = resolver;
    }

    private conflictResolver?: ConflictResolver;

    /**
     * Ensure every chunk referenced by FileDoc exists in localDB. Any missing
     * chunks are fetched via `client` and persisted locally. When `client`
     * is null, this is a no-op (offline callers rely on existing error paths).
     */
    private async ensureChunksInternal(
        client: ICouchClient | null,
        fileDoc: FileDoc,
    ): Promise<void> {
        const existing = await this.localDb.getChunks(fileDoc.chunks);
        const existingIds = new Set(existing.map((c) => c._id));
        const missing = fileDoc.chunks.filter((id) => !existingIds.has(id));
        if (missing.length === 0) return;

        if (!client) {
            logWarn(
                `missing ${missing.length} chunk(s) for ${filePathFromId(fileDoc._id)} but no remote client`,
            );
            return;
        }

        logDebug(
            `  fetching ${missing.length} missing chunk(s) from remote for ${filePathFromId(fileDoc._id)}`,
        );
        const fetched = await client.bulkGet<ChunkDoc>(missing);
        if (fetched.length > 0) {
            await this.localDb.runWriteTx({ chunks: fetched });
        }
    }

    /** Public API for Reconciler / ConflictOrchestrator. Uses the live
     *  session's client when available, no-op otherwise. */
    async ensureFileChunks(fileDoc: FileDoc): Promise<void> {
        return this.ensureChunksInternal(this.session?.client ?? null, fileDoc);
    }

    // ── Public API: State ─────────────────────────────────

    getState(): SyncState {
        return this.state;
    }

    getLastHealthyAt(): number {
        return this.lastHealthyAt;
    }

    getLastErrorDetail(): SyncErrorDetail | null {
        return this.lastErrorDetail;
    }

    /** Expose the VisibilityGate so ConfigSync can share gating with the
     *  live sync loops. Both must agree on hidden/visible to avoid
     *  hidden-time fetch failures and dead-tx symptoms on iOS. */
    getVisibilityGate(): VisibilityGate {
        return this.visibility;
    }

    // ── Public API: Lifecycle ─────────────────────────────

    /**
     * Public lifecycle entry. Attaches env listeners and the health timer
     * once per user-driven lifecycle, then kicks off a session.
     */
    async start(): Promise<void> {
        if (this.session) return;
        // An explicit start() call means the user is trying again — assume
        // they've fixed their credentials and the DB handle.
        this.auth.clear();
        this.degraded = false;
        this.envListeners.attach();
        if (this.visibility instanceof BrowserVisibilityGate) {
            this.visibility.attach();
        }
        this.startHealthTimer();
        await this.openSession();
    }

    stop(): void {
        this.envListeners.detach();
        if (this.visibility instanceof BrowserVisibilityGate) {
            this.visibility.detach();
        }
        this.stopHealthTimer();
        this.stopRetryTimer();
        this.stopTransientTimer();
        this.backoff.recordSuccess();
        // Fire-and-forget teardown — public stop() shouldn't block on
        // session loops winding down. The disconnect state is set
        // synchronously so the UI updates immediately.
        void this.teardown();
        this.setState("disconnected");
    }

    /**
     * Single entry point for every reconnect request. Funnels all
     * triggers through the policy gateway (decideReconnect) so the auth
     * latch, cool-down, and state-specific guards are always applied.
     *
     * Single-flight: only one reconnect chain runs at a time. While one
     * is in flight, additional calls compare reasons by priority and
     * either drop (lower-or-equal) or queue exactly one follow-up
     * (higher). This absorbs the app-resume + retry-backoff race that
     * produced the sess#1→sess#5 cascade observed in 2026-04-22 logs.
     */
    async requestReconnect(reason: ReconnectReason): Promise<void> {
        if (this.reconnectInFlight) {
            const currentP = reasonPriority(this.reconnectInFlightReason ?? "periodic-tick");
            const newP = reasonPriority(reason);
            const queuedP = this.queuedReconnectReason
                ? reasonPriority(this.queuedReconnectReason)
                : -1;
            if (newP > currentP && newP > queuedP) {
                this.queuedReconnectReason = reason;
                logDebug(`[rc-queue] defer reason=${reason} (in-flight=${this.reconnectInFlightReason})`);
            } else {
                logDebug(`[rc-drop] drop reason=${reason} (in-flight=${this.reconnectInFlightReason})`);
            }
            return this.reconnectInFlight;
        }

        this.reconnectInFlightReason = reason;
        this.reconnectInFlight = this.doReconnect(reason).finally(() => {
            this.reconnectInFlight = null;
            this.reconnectInFlightReason = null;
            const next = this.queuedReconnectReason;
            if (next) {
                this.queuedReconnectReason = null;
                // Fire on next microtask so the awaiter of the completed
                // promise observes the clean state before the follow-up
                // starts, and so the caller never sees a recursive stack.
                queueMicrotask(() => {
                    this.requestReconnect(next).catch((e: any) =>
                        logError(`CouchSync: queued reconnect failed: ${e?.message ?? e}`),
                    );
                });
            }
        });
        return this.reconnectInFlight;
    }

    private async doReconnect(reason: ReconnectReason): Promise<void> {
        const rc = ++this.reconnectCounter;
        const decision = decideReconnect({
            state: this.state,
            reason,
            authError: this.auth.isBlocked(),
            coolDownActive: Date.now() - this.lastRestartTime < 5000,
        });

        logDebug(`[rc#${rc}] reconnect: reason=${reason} state=${this.state} → ${decision}`);

        if (decision === "skip") return;

        if (decision === "verify-then-restart") {
            this.setState("reconnecting");
            if (!(await this.verifyReachable(rc, reason))) return;
        } else {
            this.setState("reconnecting");
        }

        logInfo(`[rc#${rc}] Reconnect (${reason}): restarting`);
        await this.restart(rc);
    }

    // ── Internal: Error supervisor ───────────────────────

    /**
     * Enter hard error state with `detail`. Drops the live session,
     * bumps the backoff step, and schedules the next retry — unless the
     * error is auth (latch) or the DB is degraded (halt).
     *
     * This is the single gate into `error` state. `setState("error")`
     * elsewhere is not used; every hard-error path comes through here.
     */
    private enterError(detail: SyncErrorDetail): void {
        this.stopTransientTimer();
        this.setState("error", detail);
        this.events.emit("error", { message: detail.message });

        if (detail.kind === "auth") {
            // Auth is user-gated. Raise the latch, tear down, and leave
            // the retry timer off — only a fresh start() clears this.
            this.auth.raise(detail.code ?? 401, detail.message);
            this.stopRetryTimer();
            void this.teardown();
            return;
        }

        if (this.degraded) {
            // Degraded local DB has already surfaced to the user; don't
            // keep polling into a dead handle.
            this.stopRetryTimer();
            return;
        }

        this.backoff.recordFailure();
        this.scheduleNextAttempt();
    }

    /**
     * Soft error path. Route through `reconnecting` state and give
     * TRANSIENT_ESCALATION_MS for the session to self-heal before
     * promoting to hard error. Called by pipelines on auth / 5xx hints.
     */
    private handleTransientError(err: unknown): void {
        const detail = classifyError(err);
        logDebug(
            `transient error: kind=${detail.kind} code=${detail.code ?? "-"} msg=${detail.message}`,
        );

        if (detail.kind === "auth") {
            this.enterError(detail);
            return;
        }

        if (this.state !== "reconnecting") {
            this.setState("reconnecting");
        }
        this.stopTransientTimer();
        this.transientTimer = setTimeout(() => {
            this.transientTimer = null;
            if (this.state === "reconnecting") {
                logDebug(`transient escalated to hard error after ${TRANSIENT_ESCALATION_MS}ms`);
                this.enterError(detail);
            }
        }, TRANSIENT_ESCALATION_MS);
    }

    /**
     * Degraded local DB: HandleGuard exhausted its reopen budget. Notify
     * once, halt retries, and require explicit `start()` to resume.
     */
    private handleDegraded(e: DbError): void {
        if (this.degraded) return;
        this.degraded = true;
        if (e.userMessage) notify(e.userMessage, 15000);
        logError(`local DB degraded: ${e.message}`);
        this.stopRetryTimer();
        this.stopTransientTimer();
        this.setState("error", {
            kind: "unknown",
            message: e.userMessage ?? "Local DB is no longer usable — restart Obsidian.",
        });
        void this.teardown();
    }

    /** Lay down one retry timer. Cancels any previous timer. Fires at
     *  most once; the fire path either succeeds (which resets backoff)
     *  or re-enters `enterError`, which re-schedules from there. */
    private scheduleNextAttempt(): void {
        this.stopRetryTimer();
        const delay = this.backoff.nextDelay();
        logDebug(`error retry scheduled in ${delay}ms (step ${this.backoff.currentStep})`);
        this.retryTimer = setTimeout(async () => {
            this.retryTimer = null;
            try {
                await this.requestReconnect("retry-backoff");
            } catch (e: any) {
                logError(`CouchSync: retry reconnect failed: ${e?.message ?? e}`);
            }
        }, delay);
    }

    private stopRetryTimer(): void {
        if (!this.retryTimer) return;
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
    }

    private stopTransientTimer(): void {
        if (!this.transientTimer) return;
        clearTimeout(this.transientTimer);
        this.transientTimer = null;
    }

    // ── Internal: State management ────────────────────────

    /**
     * Pure state transition. Emits `state-change` when the state
     * actually changes. Never touches the retry/backoff state — those
     * are supervised by `enterError` / `openSession` directly.
     */
    private setState(state: SyncState, errorDetail?: SyncErrorDetail): void {
        // Always allow re-emit for error state so a kind change reaches UI.
        if (this.state === state && state !== "error") return;

        this.state = state;

        if (state === "error") {
            this.lastErrorDetail = errorDetail ?? null;
        } else {
            this.lastErrorDetail = null;
        }

        this.events.emit("state-change", { state });
    }

    // ── Internal: Session lifecycle ───────────────────────

    private async teardown(rc = 0): Promise<void> {
        const tag = rc > 0 ? `[rc#${rc}] ` : "";
        const old = this.session;
        this.session = null;
        this.events.resetIdle();
        this.lastObservedRemoteSeq = 0;
        if (!old) return;
        const t0 = Date.now();
        old.dispose();
        // Log the watch every 5s while waiting — captures B (teardown
        // stuck) by reporting which labels remain unsettled over time.
        const watch = setInterval(() => {
            const pending = old.unsettledLabels();
            if (pending.length === 0) return;
            logDebug(
                `[sess#${old.epoch}] ${tag}teardown: waiting ${Date.now() - t0}ms (pending=[${pending.join(",")}])`,
            );
        }, 5000);
        try {
            await old.settled;
        } finally {
            clearInterval(watch);
        }
        logDebug(`[sess#${old.epoch}] ${tag}teardown: settled in ${Date.now() - t0}ms`);
    }

    private async restart(rc = 0): Promise<void> {
        this.lastRestartTime = Date.now();
        await this.teardown(rc);
        await this.openSession(rc);
    }

    /**
     * Build a new SyncSession, run catchup, transition to connected, and
     * start live loops. Every failure path routes through `enterError`
     * or `handleDegraded` — never through silent error swallowing.
     */
    private async openSession(rc = 0): Promise<void> {
        const tag = rc > 0 ? `[rc#${rc}] ` : "";
        if (this.session) return;
        if (this.auth.isBlocked()) return;
        if (this.degraded) return;

        // Register the session synchronously so concurrent start() /
        // openSession() calls are deduped by the `if (this.session)`
        // guard above before they reach any await.
        const client = this.makeVaultClient();
        const epoch = ++this.sessionEpoch;
        const session = new SyncSession({
            epoch,
            client,
            localDb: this.localDb,
            events: this.events,
            checkpoints: this.checkpoints,
            getConflictResolver: () => this.conflictResolver,
            ensureChunks: (doc) => this.ensureChunksInternal(client, doc),
            handleLocalDbError: (e, ctx) => this.handleLocalDbError(e, ctx),
            onTransientError: (err) => this.handleTransientError(err),
            visibility: this.visibility,
        });
        this.session = session;
        logDebug(`${tag}openSession: sess#${epoch} created`);

        this.setState("reconnecting");

        // Precondition: local DB has a live handle. HandleGuard reopens
        // once transparently; `DbError("degraded")` means the reopen
        // budget is exhausted.
        const ensureStart = Date.now();
        try {
            await this.localDb.ensureHealthy();
        } catch (e) {
            if (session.disposed) return;
            this.session = null;
            if (e instanceof DbError && e.kind === "degraded") {
                this.handleDegraded(e);
            } else {
                this.enterError(classifyError(e));
            }
            return;
        }
        if (session.disposed) return;
        logDebug(`${tag}openSession: ensureHealthy done in ${Date.now() - ensureStart}ms`);

        const checkpointsStart = Date.now();
        try {
            await this.checkpoints.load();
        } catch (e) {
            if (session.disposed) return;
            this.session = null;
            if (e instanceof DbError && e.kind === "degraded") {
                this.handleDegraded(e);
            } else {
                this.enterError(classifyError(e));
            }
            return;
        }
        if (session.disposed) return;
        logDebug(`${tag}openSession: checkpoints.load done in ${Date.now() - checkpointsStart}ms`);

        // Catchup = actual data transfer → syncing.
        this.setState("syncing");
        try {
            await session.runCatchup();
        } catch (e: any) {
            if (session.disposed) return;
            this.session = null;
            this.events.emit("catchup-failed");
            if (e instanceof DbError && e.kind === "degraded") {
                this.handleDegraded(e);
            } else {
                this.enterError(classifyError(e));
            }
            return;
        }
        if (session.disposed) return;

        // Catchup complete = caught up → connected.
        this.lastHealthyAt = Date.now();
        this.setState("connected");
        // Success resets both the backoff schedule and any pending
        // transient-error timer. Also kill the retry timer — otherwise a
        // retry-backoff scheduled before this success chain started
        // (e.g. from a push error during visibility=hidden) fires
        // 5 seconds later and needlessly re-restarts the live session.
        this.backoff.recordSuccess();
        this.stopTransientTimer();
        this.stopRetryTimer();
        this.firePausedCallbacks();
        this.events.emit("catchup-complete");

        session.startLive();
    }

    /**
     * Triage a local-DB error from any sync-loop write.
     *  - `recovery: "halt"` (quota / degraded): surface and tear down.
     *  - Anything else: log at warn and let the caller's retry loop handle it.
     */
    private handleLocalDbError(e: unknown, context: string): void {
        if (e instanceof DbError && e.kind === "degraded") {
            this.handleDegraded(e);
            return;
        }
        if (e instanceof DbError && e.recovery === "halt") {
            if (this.state !== "error") {
                if (e.userMessage) notify(e.userMessage, 15000);
                logError(`local DB halt during ${context}: ${e.kind} — ${e.message}`);
                void this.teardown();
            }
            return;
        }
        if (e instanceof DbError) {
            logWarn(`local DB error during ${context}: ${e.kind} — ${e.message}`);
            return;
        }
        logDebug(`local DB error during ${context}: ${(e as any)?.message ?? e}`);
    }

    // ── Internal: Stall detection ──────────────────────────

    private async checkHealth(): Promise<void> {
        if (this.auth.isBlocked()) return;

        if (this.state === "reconnecting" || this.state === "error") return;

        if (this.state === "disconnected") {
            try {
                await this.requestReconnect("periodic-tick");
            } catch (e: any) {
                logError(`CouchSync: Health check error: ${e?.message ?? e}`);
            }
            return;
        }

        const session = this.session;
        if (!session) return;
        try {
            const info = await session.client.info();
            if (session.disposed) return;

            const currentRemoteSeq = info.update_seq;
            const remoteNum = SyncEngine.seqNumericPrefix(currentRemoteSeq);
            const consumedNum = SyncEngine.seqNumericPrefix(this.checkpoints.getRemoteSeq());

            if (remoteNum !== consumedNum
                && remoteNum === SyncEngine.seqNumericPrefix(this.lastObservedRemoteSeq)) {
                logDebug(`health: stall detected (remote=${remoteNum}, consumed=${consumedNum})`);
                await this.requestReconnect("stalled");
                return;
            }

            this.lastObservedRemoteSeq = currentRemoteSeq;
            this.lastHealthyAt = Date.now();
        } catch (e: any) {
            if (session.disposed) return;
            logDebug(`health: info() failed ${e?.message ?? e}`);
            this.enterError(classifyError(e));
        }
    }

    // ── Internal: Paused callbacks ──────────────────────────

    private firePausedCallbacks(): void {
        this.events.fireIdle();
        this.events.emit("paused");
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

    // ── Internal: Verify reachability ─────────────────────

    private async verifyReachable(rc = 0, reason: ReconnectReason = "periodic-tick"): Promise<boolean> {
        const tag = rc > 0 ? `[rc#${rc}] ` : "";
        let err: string | null = null;
        const session = this.session;
        const t0 = Date.now();
        const via = session ? "session-client" : "probe-client";
        // Reason-aware probe ceiling: app-resume / network-online get
        // a longer budget for mobile network revival; faster reasons
        // stay at 5s so a hung socket can't block the reconnect chain.
        const timeoutMs = verifyTimeoutMs(reason);
        const timeoutCtl = new AbortController();
        const timer = setTimeout(() => timeoutCtl.abort(), timeoutMs);
        try {
            if (session) {
                try {
                    await session.client.info(timeoutCtl.signal);
                } catch (e: any) {
                    err = e?.message || "Connection failed";
                }
            } else {
                try {
                    const probe = this.clientFactory(this.getSettings());
                    await probe.info(timeoutCtl.signal);
                } catch (e: any) {
                    err = e?.message || "Connection failed";
                }
            }
        } finally {
            clearTimeout(timer);
        }
        logDebug(`${tag}verify: info() via ${via} returned in ${Date.now() - t0}ms (err=${err ?? "none"})`);
        if (err) {
            const detail = classifyError({ message: err });
            if (detail.kind === "unknown") {
                detail.kind = "network";
                detail.message = `Server unreachable: ${err}`;
            }
            if (this.state !== "error") {
                this.enterError(detail);
            }
            return false;
        }
        return true;
    }

    // ── Internal: Helpers ─────────────────────────────────

    private makeVaultClient(): ICouchClient {
        return this.clientFactory(this.getSettings());
    }

    private static seqNumericPrefix(seq: number | string): number {
        if (typeof seq === "number") return seq;
        const n = parseInt(seq, 10);
        return Number.isNaN(n) ? 0 : n;
    }
}

/**
 * Ranking of ReconnectReason when the single-flight guard has to pick
 * between an in-flight reason and a newcomer. Higher wins. User-visible
 * events (app-resume, app-foreground) trump silent retries.
 */
function reasonPriority(reason: ReconnectReason): number {
    switch (reason) {
        case "manual":          return 5;
        case "app-resume":      return 4;
        case "app-foreground":  return 3;
        case "network-online":  return 3;
        case "stalled":         return 2;
        case "config-failure":  return 2;
        case "retry-backoff":   return 1;
        case "periodic-tick":   return 0;
        default:                return 0;
    }
}
