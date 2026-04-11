import PouchDB from "pouchdb-browser/lib/index.js";
import type { CouchSyncDoc } from "../types.ts";
import type { LocalDB } from "./local-db.ts";
import type { CouchSyncSettings } from "../settings.ts";
import * as remoteCouch from "./remote-couch.ts";
import { decideReconnect, type ReconnectReason, type SyncState } from "./reconnect-policy.ts";
import { logVerbose, logNotice } from "../ui/log.ts";

// Re-export so existing imports of `SyncState` from "./replicator" keep
// working. The canonical home is `reconnect-policy.ts` because it's the
// only module that needs to be importable from node tests.
export type { SyncState, ReconnectReason } from "./reconnect-policy.ts";
export type SyncPhase = "idle" | "pulling" | "applying" | "live";

export type OnChangeHandler = (doc: CouchSyncDoc) => void;
export type OnStateChangeHandler = (state: SyncState) => void;
export type OnErrorHandler = (message: string) => void;

const HEALTH_CHECK_INTERVAL = 30000; // 30s

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
    private lastSyncedSeq: number | string = 0;
    private lastRestartTime = 0;
    private lastChangeAt = 0;
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

    /** Timestamp (ms) of the most recent sync change event, or 0 if never. */
    getLastChangeAt(): number {
        return this.lastChangeAt;
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
        this.authError = true;
        this.setState("error");
        this.emitError(
            `Authentication failed (${status})${reason ? ": " + reason : ""}. ` +
                `Update credentials in the Connection tab.`,
        );
        if (this.sync) {
            (this.sync as any).removeAllListeners();
            this.sync.cancel();
            this.sync = null;
        }
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

    private setState(state: SyncState): void {
        if (this.state === state) return;
        this.state = state;
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
     * Internal cleanup: cancel sync, remove listeners, close remote DB.
     * Shared by stop() and restart(). Does NOT emit a state change —
     * the caller decides what state to transition to.
     */
    private teardown(): void {
        this.syncEpoch++;
        if (this.healthTimer) {
            clearInterval(this.healthTimer);
            this.healthTimer = null;
        }
        window.removeEventListener("offline", this.boundOnOffline);
        window.removeEventListener("online", this.boundOnOnline);
        document.removeEventListener("visibilitychange", this.boundOnVisibility);
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
        // Reset so the next session doesn't carry a stale timestamp into
        // UI ("5h ago" after a fresh reconnect) or into handlePaused heuristics.
        this.lastChangeAt = 0;
    }

    /**
     * Restart sync session (preserves PouchDB checkpoint).
     *
     * Goes through bringUpSession() so the new live sync is gated on a
     * one-shot catchup pull completing. This prevents the "false connected"
     * state where PouchDB fires `paused` on a fresh session before actually
     * pulling remote changes — which would leave the device diverged until
     * manual intervention.
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
     * Entry point for bringing up a session (initial start or after restart).
     * Same pipeline for both so there's a single path to reason about.
     *
     *   prepareRemoteDb → setState("reconnecting") → catchupPull (await) →
     *   assign this.remoteDb → startLiveSync → setState("syncing")
     *
     * The catchup pull is the key difference from the previous design:
     * it's a one-shot db.replicate.from() that resolves only when the local
     * DB has pulled every pending doc from the remote. Without it, the
     * subsequent live sync's `paused` event can fire spuriously before any
     * batch has been processed, leaving the device falsely "connected".
     */
    async start(): Promise<void> {
        if (this.sync) return;
        // An explicit start() call means the user is trying again — assume
        // they've fixed their credentials and allow retries from here on.
        this.authError = false;
        await this.bringUpSession();
    }

    private async bringUpSession(): Promise<void> {
        if (this.sync) return;
        if (this.authError) return;

        const myEpoch = this.syncEpoch;
        const remoteDb = this.prepareRemoteDb();
        this.setState("reconnecting");

        try {
            await this.catchupPull(remoteDb);
        } catch (e: any) {
            if (e?.status === 401 || e?.status === 403) {
                this.authError = true;
                this.setState("error");
                this.emitError(
                    `Authentication failed (${e.status}). Check your CouchDB credentials.`,
                );
            } else {
                this.setState("error");
                this.emitError("Catchup failed: " + (e?.message ?? "unknown"));
            }
            remoteDb.close();
            return;
        }

        // Another teardown happened during our await — discard this session.
        if (this.syncEpoch !== myEpoch) {
            remoteDb.close();
            return;
        }

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
     * One-shot pull replication. Resolves on `complete`, rejects on `error`.
     * Uses the shared PouchDB checkpoint so a fresh catchup after restart
     * picks up exactly where the previous session left off (no re-download).
     */
    private async catchupPull(remoteDb: PouchDB.Database<CouchSyncDoc>): Promise<void> {
        const db = this.localDb.getDb();
        logVerbose("catchup: starting one-shot pull");
        await new Promise<void>((resolve, reject) => {
            const rep = db.replicate.from(remoteDb, {
                batch_size: 50,
                batches_limit: 5,
            });
            rep.on("complete", (info: any) => {
                logNotice(
                    `Catchup complete: docs_read=${info?.docs_read ?? 0} last_seq=${info?.last_seq ?? "?"}`,
                );
                resolve();
            });
            rep.on("error", (err: any) => {
                reject(err);
            });
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
            this.lastChangeAt = Date.now();
            this.setState("syncing");
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
        });

        this.sync.on("denied", (err) => {
            console.error("CouchSync: replication denied:", err);
            this.setState("error");
            this.emitError("Sync denied: check CouchDB permissions.");
        });

        this.sync.on("error", (err) => {
            console.error("CouchSync: replication error:", err);
            // 401/403 is a permanent credential failure. Stop the retry loop
            // so PouchDB doesn't keep hammering the server forever.
            if (err?.status === 401 || err?.status === 403) {
                this.authError = true;
                this.setState("error");
                this.emitError(
                    `Authentication failed (${err.status}). Check your CouchDB credentials.`,
                );
                if (this.sync) {
                    (this.sync as any).removeAllListeners();
                    this.sync.cancel();
                    this.sync = null;
                }
                return;
            }
            this.setState("error");
            this.emitError("Sync error: " + (err?.message || "unknown"));
        });

        this.sync.on("complete", () => {
            this.setState("disconnected");
        });

        // Health check: detect silent disconnections (PouchDB bug #3714)
        this.healthTimer = setInterval(() => this.checkHealth(), HEALTH_CHECK_INTERVAL);

        // Environment state listeners for immediate detection
        window.addEventListener("offline", this.boundOnOffline);
        window.addEventListener("online", this.boundOnOnline);
        document.addEventListener("visibilitychange", this.boundOnVisibility);

        this.setState("syncing");
    }

    stop(): void {
        this.teardown();
        this.setState("disconnected");
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

    private async updateLastSyncedSeq(): Promise<void> {
        const info = await this.localDb.getDb().info();
        this.lastSyncedSeq = info.update_seq;
    }

    private async checkHealth(): Promise<void> {
        if (this.authError) return;

        try {
            // Connected (idle/long-poll): PouchDB's own timeout (30s) and
            // heartbeat (10s) detect dead sockets. Stall check is not
            // needed because update_seq not moving is normal when the
            // vault is quiet. Silent socket death during background is
            // caught by app-resume; network changes by network-online.
            //
            // Reconnecting: restart is already in progress, don't interfere.
            if (this.state === "connected" || this.state === "reconnecting") return;

            // Syncing (active transfer): if update_seq hasn't moved and
            // no change event fired recently, the transfer is stuck.
            if (this.state === "syncing") {
                const info = await this.localDb.getDb().info();
                const stalled = info.update_seq === this.lastSyncedSeq;
                const recentChange = Date.now() - this.lastChangeAt < HEALTH_CHECK_INTERVAL;
                if (stalled && !recentChange) {
                    logVerbose(`health: syncing stall detected (seq=${info.update_seq})`);
                    await this.requestReconnect("stalled");
                }
                return;
            }

            // Inactive session (disconnected/error): try to recover via
            // the gateway. The "periodic-tick" reason routes through
            // verify-then-restart so we don't hammer a still-down server.
            if (this.state === "disconnected" || this.state === "error") {
                await this.requestReconnect("periodic-tick");
            }
        } catch (e) {
            console.error("CouchSync: Health check error:", e);
        }
    }

    private async handlePaused(err: unknown): Promise<void> {
        const epoch = this.syncEpoch;

        if (err) {
            this.setState("error");
            this.emitError("Sync paused: connection issue");
            return;
        }

        // Catchup pull in bringUpSession() has already verified the session
        // has pulled pending remote changes, so `paused` here means genuine
        // idle (or back-off wait on a healthy socket — either way nothing
        // to do). No need to re-verify reachability.
        await this.updateLastSyncedSeq();

        // Sync session was replaced while we were awaiting — discard
        // this stale callback to avoid overwriting the new session's state.
        if (this.syncEpoch !== epoch) return;

        this.setState("connected");
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

    /** Verify the server can be reached. Pins state="error" with a notice on
     *  failure (without restarting); returns true if reachable. */
    private async verifyReachable(): Promise<boolean> {
        const err = await this.testConnection();
        if (err) {
            if (this.state !== "error") {
                this.setState("error");
                this.emitError(`Server unreachable: ${err}`);
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
