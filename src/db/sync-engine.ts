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

// ── Constants ────────────────────────────────────────────

const HEALTH_CHECK_INTERVAL = 30000; // 30s

/** How long a transient error stays in `reconnecting` before escalating
 *  to a hard `error`. The live session may self-heal inside this window. */
const TRANSIENT_ESCALATION_MS = 10_000;

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
        this.startHealthTimer();
        await this.openSession();
    }

    stop(): void {
        this.envListeners.detach();
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
     */
    async requestReconnect(reason: ReconnectReason): Promise<void> {
        const decision = decideReconnect({
            state: this.state,
            reason,
            authError: this.auth.isBlocked(),
            coolDownActive: Date.now() - this.lastRestartTime < 5000,
        });

        logDebug(`reconnect: reason=${reason} state=${this.state} → ${decision}`);

        if (decision === "skip") return;

        if (decision === "verify-then-restart") {
            this.setState("reconnecting");
            if (!(await this.verifyReachable())) return;
        } else {
            this.setState("reconnecting");
        }

        logInfo(`Reconnect (${reason}): restarting`);
        await this.restart();
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

    private async teardown(): Promise<void> {
        const old = this.session;
        this.session = null;
        this.events.resetIdle();
        this.lastObservedRemoteSeq = 0;
        if (!old) return;
        old.dispose();
        await old.settled;
    }

    private async restart(): Promise<void> {
        this.lastRestartTime = Date.now();
        await this.teardown();
        await this.openSession();
    }

    /**
     * Build a new SyncSession, run catchup, transition to connected, and
     * start live loops. Every failure path routes through `enterError`
     * or `handleDegraded` — never through silent error swallowing.
     */
    private async openSession(): Promise<void> {
        if (this.session) return;
        if (this.auth.isBlocked()) return;
        if (this.degraded) return;

        // Register the session synchronously so concurrent start() /
        // openSession() calls are deduped by the `if (this.session)`
        // guard above before they reach any await.
        const client = this.makeVaultClient();
        const session = new SyncSession({
            client,
            localDb: this.localDb,
            events: this.events,
            checkpoints: this.checkpoints,
            getConflictResolver: () => this.conflictResolver,
            ensureChunks: (doc) => this.ensureChunksInternal(client, doc),
            handleLocalDbError: (e, ctx) => this.handleLocalDbError(e, ctx),
            onTransientError: (err) => this.handleTransientError(err),
        });
        this.session = session;

        this.setState("reconnecting");

        // Precondition: local DB has a live handle. HandleGuard reopens
        // once transparently; `DbError("degraded")` means the reopen
        // budget is exhausted.
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
        // transient-error timer.
        this.backoff.recordSuccess();
        this.stopTransientTimer();
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

    private async verifyReachable(): Promise<boolean> {
        let err: string | null = null;
        const session = this.session;
        if (session) {
            try {
                await session.client.info();
            } catch (e: any) {
                err = e?.message || "Connection failed";
            }
        } else {
            try {
                const probe = this.clientFactory(this.getSettings());
                await probe.info();
            } catch (e: any) {
                err = e?.message || "Connection failed";
            }
        }
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
