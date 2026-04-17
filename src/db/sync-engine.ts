/**
 * SyncEngine — sync loop using CouchClient HTTP + IDocStore.
 *
 *   - CouchClient.changes() + bulkGet() for catchup pull
 *   - CouchClient.changesLongpoll() loop for live pull
 *   - localDb.changes() poll + CouchClient.bulkDocs() for push
 *   - CouchClient.info() for stall detection
 *
 * Event wiring, auth-latch management, and echo suppression are
 * factored into `SyncEvents`, `AuthGate`, and `EchoTracker` — this
 * class focuses on the sync loops themselves.
 */

import type { FileDoc, ChunkDoc } from "../types.ts";
import type { LocalDB } from "./local-db.ts";
import type { CouchSyncSettings } from "../settings.ts";
import type { ICouchClient } from "./interfaces.ts";
import type { ConflictResolver } from "../conflict/conflict-resolver.ts";
import { filePathFromId } from "../types/doc-id.ts";
import { CouchClient, makeCouchClient } from "./couch-client.ts";
import {
    decideReconnect,
    type ReconnectReason,
    type SyncState,
    type SyncErrorDetail,
    type SyncErrorKind,
} from "./reconnect-policy.ts";
import { logDebug, logInfo, logWarn, logError, notify } from "../ui/log.ts";
import { ErrorRecovery } from "./error-recovery.ts";
import { EnvListeners } from "./env-listeners.ts";
import { DbError } from "./write-transaction.ts";
import { AuthGate } from "./sync/auth-gate.ts";
import { EchoTracker } from "./sync/echo-tracker.ts";
import { SyncEvents } from "./sync/sync-events.ts";
import { PullWriter } from "./sync/pull-writer.ts";
import { PullPipeline } from "./sync/pull-pipeline.ts";
import { PushPipeline } from "./sync/push-pipeline.ts";
import { Checkpoints } from "./sync/checkpoints.ts";

// ── Re-exports ──────────────────────────────────────────

export type {
    SyncState,
    ReconnectReason,
    SyncErrorDetail,
    SyncErrorKind,
} from "./reconnect-policy.ts";

// ── Constants ────────────────────────────────────────────

const HEALTH_CHECK_INTERVAL = 30000; // 30s

// ── SyncEngine ───────────────────────────────────────────

export class SyncEngine {
    /** Typed event bus. External subscribers use `events.on(...)` / `events.onAsync(...)`. */
    readonly events = new SyncEvents();

    /** Auth latch. External callers read `auth.isBlocked()` and call `auth.raise/clear`. */
    readonly auth: AuthGate;

    private readonly pullWriter: PullWriter;

    // ── State ─────────────────────────────────────────────

    private state: SyncState = "disconnected";
    private lastHealthyAt = 0;
    private lastErrorDetail: SyncErrorDetail | null = null;
    private lastRestartTime = 0;

    // ── Echo suppression ─────────────────────────────────

    private readonly echoes = new EchoTracker();

    /** Last remote update_seq seen by stall detection. Compared against
     *  our consumed remoteSeq to detect a stalled pull loop. */
    private lastObservedRemoteSeq: number | string = 0;

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

    private readonly errorRecovery: ErrorRecovery;

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

    constructor(
        private localDb: LocalDB,
        private getSettings: () => CouchSyncSettings,
        private isMobile: boolean = false,
        auth?: AuthGate,
    ) {
        this.auth = auth ?? new AuthGate();
        this.checkpoints = new Checkpoints(localDb);

        this.errorRecovery = new ErrorRecovery(
            {
                getState: () => this.state,
                setState: (s, d) => this.setState(s, d),
                emitError: (m) => this.events.emit("error", { message: m }),
                teardown: () => this.teardown(),
                requestReconnect: (r) => this.requestReconnect(r),
            },
            this.auth,
        );

        // External raise (Settings tab probe, config-sync) → pin state=error
        // so the status bar and onError listeners see the auth latch.
        // ErrorRecovery's internal path raises auth then sets state=error,
        // so the early-return guard prevents re-entry.
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
            this.teardown();
        });

        this.pullWriter = new PullWriter({
            localDb: this.localDb,
            events: this.events,
            echoes: this.echoes,
            getConflictResolver: () => this.conflictResolver,
            ensureChunks: (doc) => this.ensureChunks(doc),
        });

        // Pipelines emit "paused" after applying a batch (live loop only —
        // catchup paused is fired by firePausedCallbacks below). SyncEngine
        // owns lastHealthyAt and updates it here.
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
     * chunks are fetched from the remote and persisted locally. When `client`
     * is null, this is a no-op (offline callers rely on existing error paths).
     */
    private async ensureChunks(fileDoc: FileDoc): Promise<void> {
        const existing = await this.localDb.getChunks(fileDoc.chunks);
        const existingIds = new Set(existing.map((c) => c._id));
        const missing = fileDoc.chunks.filter((id) => !existingIds.has(id));
        if (missing.length === 0) return;

        if (!this.client) {
            logWarn(
                `missing ${missing.length} chunk(s) for ${filePathFromId(fileDoc._id)} but no remote client`,
            );
            return;
        }

        logDebug(
            `  fetching ${missing.length} missing chunk(s) from remote for ${filePathFromId(fileDoc._id)}`,
        );
        const fetched = await this.client.bulkGet<ChunkDoc>(missing);
        if (fetched.length > 0) {
            // Chunks are content-addressed: put-if-absent handled inside
            // runWrite when passed via the `chunks` field.
            await this.localDb.runWriteTx({ chunks: fetched });
        }
    }

    async ensureFileChunks(fileDoc: FileDoc): Promise<void> {
        return this.ensureChunks(fileDoc);
    }

    // ── Public API: State ─────────────────────────────────

    getState(): SyncState {
        return this.state;
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

    // ── Public API: Lifecycle ─────────────────────────────

    /**
     * Public lifecycle entry. Attaches env listeners and the health timer
     * once per user-driven lifecycle, then kicks off a session.
     */
    async start(): Promise<void> {
        if (this.running) return;
        // An explicit start() call means the user is trying again — assume
        // they've fixed their credentials.
        this.auth.clear();
        this.envListeners.attach();
        this.startHealthTimer();
        await this.bringUpSession();
    }

    stop(): void {
        this.envListeners.detach();
        this.stopHealthTimer();
        this.errorRecovery.reset();
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

    // One-shot operations live on VaultRemoteOps (plugin.remoteOps).
    // SyncEngine is exclusively live-loop from v0.18.0 onward.

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
                this.errorRecovery.reset();
            }
            if (state !== "reconnecting") {
                this.errorRecovery.reset();
            }
        }

        this.events.emit("state-change", { state });
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
        this.events.resetIdle();
        this.lastObservedRemoteSeq = 0;
        this.echoes.clear();
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
        if (this.auth.isBlocked()) return Promise.resolve();
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
            await this.checkpoints.load();
        } catch (e) {
            logDebug(`checkpoint load error: ${e}`);
            // Start from 0 if meta is unavailable.
        }

        if (this.syncEpoch !== myEpoch) return;

        const pullPipeline = this.makePullPipeline(client, myEpoch);
        const pushPipeline = this.makePushPipeline(client, myEpoch);

        // Catchup = actual data transfer → syncing.
        this.setState("syncing");

        try {
            await pullPipeline.runCatchup();
        } catch (e: any) {
            if (this.syncEpoch !== myEpoch) return;
            this.errorRecovery.enterHardError(this.errorRecovery.classifyError(e));
            this.events.emit("catchup-failed");
            return;
        }

        if (this.syncEpoch !== myEpoch) return;

        // Catchup complete = caught up → connected immediately.
        this.lastHealthyAt = Date.now();
        this.client = client;
        this.running = true;
        this.setState("connected");
        this.firePausedCallbacks();
        this.events.emit("catchup-complete");

        // Live loops run for the rest of the session; their `isCancelled`
        // closures fire when syncEpoch advances (teardown).
        pullPipeline.runLongpoll().catch((e) =>
            logError(`CouchSync: pullLoop unexpected exit: ${e?.message ?? e}`),
        );
        pushPipeline.run().catch((e) =>
            logError(`CouchSync: pushLoop unexpected exit: ${e?.message ?? e}`),
        );
    }

    private makePullPipeline(client: ICouchClient, epoch: number): PullPipeline {
        return new PullPipeline({
            localDb: this.localDb,
            client,
            pullWriter: this.pullWriter,
            errorRecovery: this.errorRecovery,
            events: this.events,
            isCancelled: () => this.syncEpoch !== epoch,
            getRemoteSeq: () => this.checkpoints.getRemoteSeq(),
            setRemoteSeq: (s) => this.checkpoints.setRemoteSeq(s),
            saveCheckpoints: () => this.saveCheckpointsSafe(),
            handleLocalDbError: (e, ctx) => this.handleLocalDbError(e, ctx),
            delay: (ms) => this.delay(ms, epoch),
        });
    }

    private makePushPipeline(client: ICouchClient, epoch: number): PushPipeline {
        return new PushPipeline({
            localDb: this.localDb,
            client,
            echoes: this.echoes,
            events: this.events,
            isCancelled: () => this.syncEpoch !== epoch,
            getLastPushedSeq: () => this.checkpoints.getLastPushedSeq(),
            setLastPushedSeq: (s) => this.checkpoints.setLastPushedSeq(s),
            saveCheckpoints: () => this.saveCheckpointsSafe(),
            handleLocalDbError: (e, ctx) => this.handleLocalDbError(e, ctx),
            delay: (ms) => this.delay(ms, epoch),
        });
    }

    // ── Internal: Checkpoints ─────────────────────────────

    /** Wrap Checkpoints.save() with the local DB error handler — quota
     *  errors halt the sync loops, transient errors log at warn. */
    private async saveCheckpointsSafe(): Promise<void> {
        try {
            await this.checkpoints.save();
        } catch (e) {
            this.handleLocalDbError(e, "checkpoint save");
        }
    }

    /**
     * Triage a local-DB error from any sync-loop write.
     *  - `recovery: "halt"` (typically quota): show the user-facing message
     *    once and tear down the sync loops.
     *  - Anything else: log at warn and let the caller's retry loop handle it.
     */
    private handleLocalDbError(e: unknown, context: string): void {
        if (e instanceof DbError && e.recovery === "halt") {
            if (this.state !== "error") {
                if (e.userMessage) notify(e.userMessage, 15000);
                logError(`local DB halt during ${context}: ${e.kind} — ${e.message}`);
                this.teardown();
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

    /**
     * Periodic health check (30s interval). In connected/syncing states,
     * performs stall detection: fetches the remote update_seq and compares
     * it against our consumed remoteSeq. If the remote has advanced but
     * our pull loop hasn't consumed those changes, the session is stalled
     * and we trigger a reconnect.
     */
    private async checkHealth(): Promise<void> {
        if (this.auth.isBlocked()) return;

        if (this.state === "reconnecting" || this.state === "error") return;

        if (this.state === "disconnected") {
            try {
                await this.requestReconnect("periodic-tick");
            } catch (e) {
                logError(`CouchSync: Health check error: ${e?.message ?? e}`);
            }
            return;
        }

        // Connected / syncing: stall detection via update_seq comparison.
        // CouchDB 3.x cluster returns opaque seq strings (e.g. "1771-g1AAAA…")
        // where the opaque suffix can differ between info() and _changes even
        // for the same logical position. Compare only the numeric prefix.
        if (!this.client) return;
        const sessionEpoch = this.syncEpoch;
        try {
            const info = await this.client.info();
            if (this.syncEpoch !== sessionEpoch) return;

            const currentRemoteSeq = info.update_seq;
            const remoteNum = SyncEngine.seqNumericPrefix(currentRemoteSeq);
            const consumedNum = SyncEngine.seqNumericPrefix(this.checkpoints.getRemoteSeq());

            if (remoteNum !== consumedNum
                && remoteNum === SyncEngine.seqNumericPrefix(this.lastObservedRemoteSeq)) {
                // Remote seq hasn't changed since last check, but its
                // numeric prefix exceeds what we've consumed — stalled.
                logDebug(`health: stall detected (remote=${remoteNum}, consumed=${consumedNum})`);
                await this.requestReconnect("stalled");
                return;
            }

            this.lastObservedRemoteSeq = currentRemoteSeq;
            this.lastHealthyAt = Date.now();
        } catch (e: any) {
            if (this.syncEpoch !== sessionEpoch) return;
            logDebug(`health: info() failed ${e?.message ?? e}`);
            this.errorRecovery.enterHardError(this.errorRecovery.classifyError(e));
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

    /** Verify the server can be reached. On failure, transitions to hard
     *  error and returns false. Uses the live client when available,
     *  falling back to a fresh one from saved settings. */
    private async verifyReachable(): Promise<boolean> {
        let err: string | null = null;
        if (this.client) {
            try {
                await this.client.info();
            } catch (e: any) {
                err = e?.message || "Connection failed";
            }
        } else {
            const s = this.getSettings();
            try {
                const probe = makeCouchClient(s.couchdbUri, s.couchdbDbName, s.couchdbUser, s.couchdbPassword);
                await probe.info();
            } catch (e: any) {
                err = e?.message || "Connection failed";
            }
        }
        if (err) {
            const detail = this.errorRecovery.classifyError({ message: err });
            if (detail.kind === "unknown") {
                detail.kind = "network";
                detail.message = `Server unreachable: ${err}`;
            }
            if (this.state !== "error") {
                this.errorRecovery.enterHardError(detail);
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

    /**
     * Extract the numeric prefix from a CouchDB sequence value.
     * CouchDB 3.x clusters return opaque strings like "1771-g1AAAACReJzL…".
     * The opaque suffix can differ between `info()` and `_changes` for the
     * same logical position, so only the numeric prefix is safe to compare.
     */
    private static seqNumericPrefix(seq: number | string): number {
        if (typeof seq === "number") return seq;
        const n = parseInt(seq, 10);
        return Number.isNaN(n) ? 0 : n;
    }
}
