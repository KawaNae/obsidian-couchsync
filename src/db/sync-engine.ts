/**
 * SyncEngine — sync loop using CouchClient HTTP + IDocStore.
 *
 *   - CouchClient.changes() + bulkGet() for catchup pull
 *   - CouchClient.changesLongpoll() loop for live pull
 *   - localDb.changes() poll + CouchClient.bulkDocs() for push
 *   - CouchClient.info() for stall detection
 */

import type { CouchSyncDoc, FileDoc, ChunkDoc } from "../types.ts";
import { stripRev } from "../utils/doc.ts";
import { isReplicatedDocId, isFileDocId } from "../types/doc-id.ts";
import type { LocalDB } from "./local-db.ts";
import type { CouchSyncSettings } from "../settings.ts";
import type { ICouchClient, ChangesResult } from "./interfaces.ts";
import type { ConflictResolver, PullVerdict } from "../conflict/conflict-resolver.ts";
import { isFileDoc, isConfigDoc } from "../types.ts";
import { filePathFromId, configPathFromId } from "../types/doc-id.ts";
import * as remoteCouch from "./remote-couch.ts";
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

// ── Re-exports ──────────────────────────────────────────

export type {
    SyncState,
    ReconnectReason,
    SyncErrorDetail,
    SyncErrorKind,
} from "./reconnect-policy.ts";

export type OnChangeHandler = (doc: CouchSyncDoc) => void;
export type OnStateChangeHandler = (state: SyncState) => void;
export type OnErrorHandler = (message: string) => void;
export type OnConcurrentHandler = (
    filePath: string,
    localDoc: CouchSyncDoc,
    remoteDoc: CouchSyncDoc,
) => void | Promise<void>;

/** Tracks a doc ID written by pull so the push loop can distinguish
 *  the pull echo from a genuine post-pull user edit. */
interface PullWriteRecord {
    /** localDb updateSeq immediately after bulkPut. Any local change
     *  with seq <= this value is the pull echo; seq > this is a new edit. */
    seq: number;
    /** Date.now() at insertion — used for TTL-based cleanup. */
    addedAt: number;
}

// ── Constants ────────────────────────────────────────────

const HEALTH_CHECK_INTERVAL = 30000; // 30s
const CATCHUP_IDLE_TIMEOUT_MS = 60000; // abort catchup after 60s of no progress

/** Build identifier, logged at start(). Lets us verify on mobile that a
 *  deployed plugin update actually reached the device. */
const BUILD_TAG = "sync-engine-v0.15.0";

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
    private lastHealthyAt = 0;
    private lastErrorDetail: SyncErrorDetail | null = null;
    private lastRestartTime = 0;

    // ── Event handlers ────────────────────────────────────

    private onChangeHandlers: OnChangeHandler[] = [];
    private onStateChangeHandlers: OnStateChangeHandler[] = [];
    private onErrorHandlers: OnErrorHandler[] = [];
    private onPausedHandlers: (() => void)[] = [];
    private onReconnectHandlers: (() => void)[] = [];
    private onConcurrentHandlers: OnConcurrentHandler[] = [];
    private onPullWriteHandler: ((doc: FileDoc) => Promise<void>) | null = null;
    /** Returns true if local has unpushed changes (→ concurrent conflict). */
    private onPullDeleteHandler:
        ((path: string, localDoc: FileDoc) => Promise<boolean>) | null = null;
    private onAutoResolveHandler: ((filePath: string) => void) | null = null;
    private onCatchupCompleteHandler: (() => void) | null = null;
    private onCatchupFailedHandler: (() => void) | null = null;
    private idleCallbacks: (() => void)[] = [];
    private hasBeenIdle = false;

    /** Doc IDs written by pull (bulkPut). Push loop uses seq comparison
     *  to distinguish pull echoes from genuine post-pull edits. */
    private pullWrittenIds = new Map<string, PullWriteRecord>();
    private static readonly PULL_WRITTEN_TTL_MS = 60_000;
    /** Doc IDs recently pushed. Pull skips logging for these (echo suppression). */
    private recentlyPushedIds = new Set<string>();
    /** Last remote update_seq seen by stall detection. Compared against
     *  our consumed remoteSeq to detect a stalled pull loop. */
    private lastObservedRemoteSeq: number | string = 0;

    // ── Pull loop retry state ────────────────────────────
    private pullRetryMs = 2_000;
    private lastPullErrorMsg: string | null = null;
    private static readonly PULL_RETRY_MIN_MS = 2_000;
    private static readonly PULL_RETRY_MAX_MS = 30_000;

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

    private readonly errorRecovery = new ErrorRecovery({
        getState: () => this.state,
        setState: (s, d) => this.setState(s, d),
        emitError: (m) => this.emitError(m),
        setAuthError: () => { this.authError = true; },
        teardown: () => this.teardown(),
        requestReconnect: (r) => this.requestReconnect(r),
    });

    // ── Timers & env listeners ────────────────────────────

    private healthTimer: ReturnType<typeof setInterval> | null = null;

    private readonly envListeners = new EnvListeners({
        getState: () => this.state,
        setState: (s) => this.setState(s),
        emitError: (m) => this.emitError(m),
        requestReconnect: (r) => this.requestReconnect(r),
        fireReconnectHandlers: () => this.fireReconnectHandlers(),
        isMobile: this.isMobile,
    });

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

    setConflictResolver(resolver: ConflictResolver): void {
        this.conflictResolver = resolver;
    }

    private conflictResolver?: ConflictResolver;

    /**
     * FileDoc が参照する chunk が全て localDB に存在することを保証する。
     * 不足分はリモートから fetch して localDB に保存する。
     * client が null の場合は何もしない（オフライン時は既存エラーに委ねる）。
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
            await this.localDb.runWrite({ chunks: fetched });
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
        this.errorRecovery.enterHardError({
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

    onConcurrent(handler: OnConcurrentHandler): void {
        this.onConcurrentHandlers.push(handler);
    }

    /**
     * Register a handler for pull-driven vault writes. Called for each
     * accepted FileDoc after bulkPut (chunks already in localDB).
     * This is the primary vault write path for pulled documents —
     * Reconciler handles only drift detection.
     */
    onPullWrite(handler: (doc: FileDoc) => Promise<void>): void {
        this.onPullWriteHandler = handler;
    }

    /**
     * Called when a remote deletion is detected in the changes feed.
     * The handler returns true if local has unpushed edits (→ concurrent
     * conflict), false if the deletion was applied successfully.
     */
    onPullDelete(handler: (path: string, localDoc: FileDoc) => Promise<boolean>): void {
        this.onPullDeleteHandler = handler;
    }

    /**
     * Called when a pulled doc is auto-resolved as take-remote (vclock
     * dominance). main.ts uses this to auto-dismiss open conflict modals.
     */
    onAutoResolve(handler: (filePath: string) => void): void {
        this.onAutoResolveHandler = handler;
    }

    /** Called after catchup completes and pull-writes are done. */
    onCatchupComplete(handler: () => void): void {
        this.onCatchupCompleteHandler = handler;
    }

    /** Called when catchup fails (hard error). */
    onCatchupFailed(handler: () => void): void {
        this.onCatchupFailedHandler = handler;
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
        logDebug(`sync-engine start (build=${BUILD_TAG})`);
        // An explicit start() call means the user is trying again — assume
        // they've fixed their credentials.
        this.authError = false;
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
            authError: this.authError,
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

    /** Create the vault remote database if it doesn't exist. */
    async ensureRemoteDb(): Promise<void> {
        const client = this.makeVaultClient();
        await client.ensureDb();
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
                this.errorRecovery.reset();
            }
            if (state !== "reconnecting") {
                this.errorRecovery.reset();
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
        this.deniedWarningEmitted = false;
        this.lastObservedRemoteSeq = 0;
        this.pullWrittenIds.clear();
        this.pullRetryMs = SyncEngine.PULL_RETRY_MIN_MS;
        this.lastPullErrorMsg = null;
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
            logDebug(`checkpoint load error: ${e}`);
            // Start from 0 if meta is unavailable.
        }

        if (this.syncEpoch !== myEpoch) return;

        // Catchup = actual data transfer → syncing.
        this.setState("syncing");

        try {
            await this.catchupPull(client, myEpoch);
        } catch (e: any) {
            if (this.syncEpoch !== myEpoch) return;
            this.errorRecovery.enterHardError(this.errorRecovery.classifyError(e));
            this.onCatchupFailedHandler?.();
            return;
        }

        if (this.syncEpoch !== myEpoch) return;

        // Catchup complete = caught up → connected immediately.
        this.lastHealthyAt = Date.now();
        this.client = client;
        this.running = true;
        this.setState("connected");
        this.firePausedCallbacks();
        this.onCatchupCompleteHandler?.();
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
        logDebug("catchup: starting HTTP changes pull");

        let lastProgressAt = Date.now();

        while (true) {
            if (this.syncEpoch !== epoch) return;

            // Check idle timeout.
            if (Date.now() - lastProgressAt > CATCHUP_IDLE_TIMEOUT_MS) {
                logInfo("Catchup timed out (no progress for 60s)");
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
                logDebug(
                    `catchup: batch ${result.results.length} docs, seq=${result.last_seq}`,
                );
            } else {
                // No more changes — catchup complete.
                const seq = String(result.last_seq);
                logInfo(
                    `Catchup complete (seq=${seq.length > 20 ? seq.slice(0, 20) + "…" : seq})`,
                );
                // Update seq even on empty result (last_seq may advance).
                this.remoteSeq = result.last_seq;
                await this.saveCheckpoints();
                break;
            }
        }
    }

    // ── Internal: Live sync loops ─────────────────────────

    /**
     * Start the pull and push loops running concurrently in the background.
     * Both loops check syncEpoch to self-terminate on teardown.
     */
    private startLiveSync(epoch: number): void {
        // State is already "connected" — just start the loops.
        this.pullLoop(epoch).catch((e) =>
            logError(`CouchSync: pullLoop unexpected exit: ${e?.message ?? e}`),
        );
        this.pushLoop(epoch).catch((e) =>
            logError(`CouchSync: pushLoop unexpected exit: ${e?.message ?? e}`),
        );
    }

    /**
     * Long-poll pull loop. Each iteration issues a longpoll _changes
     * request. On received changes: syncing → apply → connected.
     * On empty result (max-wait timeout): no state change.
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
                    this.pullRetryMs = SyncEngine.PULL_RETRY_MIN_MS;
                    this.lastPullErrorMsg = null;
                    this.setState("syncing");
                    await this.writePulledDocs(result);
                    if (this.syncEpoch !== epoch) return;
                    this.lastHealthyAt = Date.now();
                    this.setState("connected");
                    this.firePausedCallbacks();
                }
                // Empty result (longpoll max-wait): stay connected.
            } catch (e: any) {
                if (this.syncEpoch !== epoch) return;

                if (e instanceof DbError) {
                    this.handleLocalDbError(e, "pull write");
                    if (e.recovery === "halt") return; // teardown already invoked
                    await this.delay(this.pullRetryMs, epoch);
                    continue;
                }

                const detail = this.errorRecovery.classifyError(e);

                if (detail.kind === "auth" || detail.kind === "server") {
                    this.errorRecovery.handleTransientError(e);
                } else if (this.state !== "reconnecting" && this.state !== "error") {
                    // Deduplicate consecutive identical error messages.
                    if (detail.message !== this.lastPullErrorMsg) {
                        this.lastPullErrorMsg = detail.message;
                        logDebug(
                            `pullLoop: ${detail.kind} error, retrying — ${detail.message}`,
                        );
                    }
                }

                await this.delay(this.pullRetryMs, epoch);
                this.pullRetryMs = Math.min(
                    this.pullRetryMs * 2,
                    SyncEngine.PULL_RETRY_MAX_MS,
                );
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

                // Filter to replicated docs. For pull-written docs, use
                // seq comparison: if the local change's seq is greater than
                // the seq recorded at pull time, it's a genuine post-pull
                // user edit and must be pushed.
                const toPush = localChanges.results.filter((r) => {
                    if (!r.doc || !isReplicatedDocId(r.id) || r.deleted) return false;
                    const record = this.pullWrittenIds.get(r.id);
                    if (!record) return true;
                    const rSeq = typeof r.seq === "number" ? r.seq : parseInt(String(r.seq), 10);
                    return rSeq > record.seq;
                });

                // Clean up pullWrittenIds: remove seen IDs + TTL expiry.
                const now = Date.now();
                for (const r of localChanges.results) {
                    this.pullWrittenIds.delete(r.id);
                }
                for (const [id, rec] of this.pullWrittenIds) {
                    if (now - rec.addedAt > SyncEngine.PULL_WRITTEN_TTL_MS) {
                        this.pullWrittenIds.delete(id);
                    }
                }

                if (toPush.length > 0 && this.client) {
                    const docs = toPush.map((r) => r.doc!);
                    await this.pushDocs(docs);
                    this.lastHealthyAt = Date.now();
                }

                this.lastPushedSeq = localChanges.last_seq;
                await this.saveCheckpoints();
            } catch (e: any) {
                if (this.syncEpoch !== epoch) return;
                if (e instanceof DbError) {
                    this.handleLocalDbError(e, "push loop");
                    if (e.recovery === "halt") return;
                } else {
                    // Push errors are logged but don't escalate — the next
                    // cycle will retry.
                    logDebug(`push error: ${e?.message ?? e}`);
                }
            }

            await this.delay(PUSH_POLL_INTERVAL_MS, epoch);
        }
    }

    // ── Internal: Doc I/O ─────────────────────────────────

    /**
     * Write pulled docs to local store with vclock guard.
     * For FileDoc/ConfigDoc: compare vclock before writing.
     * ChunkDoc: always accept (no vclock, keyed by content hash).
     */
    private async writePulledDocs(
        result: ChangesResult<CouchSyncDoc>,
    ): Promise<void> {
        const accepted: CouchSyncDoc[] = [];
        const concurrent: Array<{
            filePath: string;
            localDoc: CouchSyncDoc;
            remoteDoc: CouchSyncDoc;
        }> = [];
        let keepLocalCount = 0;
        let chunkCount = 0;
        let writtenCount = 0;
        let writeFailCount = 0;
        let deletedCount = 0;

        for (const row of result.results) {
            // Handle remote deletions (CouchDB tombstones).
            if (row.deleted) {
                if (isFileDocId(row.id)) {
                    await this.handlePulledDeletion(row.id, concurrent);
                    deletedCount++;
                }
                continue;
            }
            if (!row.doc) continue;
            const remoteDoc = stripRev(row.doc) as CouchSyncDoc;

            // Skip echo: docs we just pushed come back via changes feed.
            if (this.recentlyPushedIds.has(remoteDoc._id)) {
                this.recentlyPushedIds.delete(remoteDoc._id);
                continue;
            }

            // ChunkDocs have no vclock — always accept.
            if (!isFileDoc(remoteDoc) && !isConfigDoc(remoteDoc)) {
                accepted.push(remoteDoc);
                chunkCount++;
                continue;
            }

            // vclock guard: compare with local version.
            if (this.conflictResolver) {
                const localDoc = await this.localDb.get(remoteDoc._id);
                if (localDoc && (isFileDoc(localDoc) || isConfigDoc(localDoc))) {
                    const verdict = await this.conflictResolver.resolveOnPull(
                        localDoc, remoteDoc,
                    );
                    if (verdict === "keep-local") {
                        const path = isFileDoc(remoteDoc) ? filePathFromId(remoteDoc._id) : configPathFromId(remoteDoc._id);
                        logDebug(`  × ${path} (keep-local)`);
                        keepLocalCount++;
                        continue;
                    }
                    if (verdict === "concurrent") {
                        const filePath = isFileDoc(remoteDoc)
                            ? filePathFromId(remoteDoc._id)
                            : configPathFromId(remoteDoc._id);
                        // Ensure remote chunks are available locally so the
                        // conflict modal can display the remote content.
                        if (isFileDoc(remoteDoc)) {
                            await this.ensureChunks(remoteDoc);
                        }
                        logDebug(`  ⚡ ${filePath} (concurrent)`);
                        concurrent.push({ filePath, localDoc, remoteDoc });
                        continue; // keep local, don't write remote
                    }
                    // "take-remote": fall through to accept
                }
            }

            accepted.push(remoteDoc);
        }

        // Atomic commit: accepted docs + META_REMOTE_SEQ in one rw tx.
        // Crash between the two is impossible — remote changes and the
        // checkpoint advance together or neither. pullWrittenIds / vault
        // writes are in-memory / filesystem side effects, so they happen
        // *after* the tx via onCommit.
        const nextRemoteSeq = result.last_seq;
        if (accepted.length > 0) {
            await this.localDb.runWrite({
                // bulkPut semantics: docs here are accepted from the remote
                // and must overwrite local rows (the CAS decision was made
                // upstream in resolveOnPull). No expectedVclock → unconditional.
                docs: accepted.map((d) => ({ doc: d })),
                meta: [{ op: "put", key: META_REMOTE_SEQ, value: nextRemoteSeq }],
                onCommit: async () => {
                    const { updateSeq } = await this.localDb.info();
                    const seq = typeof updateSeq === "number"
                        ? updateSeq
                        : parseInt(String(updateSeq), 10);
                    const now = Date.now();
                    for (const doc of accepted) {
                        this.pullWrittenIds.set(doc._id, { seq, addedAt: now });
                    }

                    if (this.onPullWriteHandler) {
                        for (const doc of accepted) {
                            if (isFileDoc(doc)) {
                                const path = filePathFromId(doc._id);
                                try {
                                    await this.ensureChunks(doc);
                                    await this.onPullWriteHandler(doc);
                                    logDebug(`  ← ${path} (take-remote)`);
                                    writtenCount++;
                                    this.onAutoResolveHandler?.(path);
                                } catch (e: any) {
                                    logError(`pull vault write failed: ${path}: ${e?.message ?? e}`);
                                    writeFailCount++;
                                }
                            }
                        }
                    }

                    for (const doc of accepted) {
                        for (const handler of this.onChangeHandlers) {
                            try {
                                handler(doc);
                            } catch (e: any) {
                                logError(`onChange handler error: ${e?.message ?? e}`);
                            }
                        }
                    }
                },
            });
            this.remoteSeq = nextRemoteSeq;
        } else {
            // No docs to apply — just advance the checkpoint (1 small meta write).
            this.remoteSeq = nextRemoteSeq;
            await this.saveCheckpoints();
        }

        // Summary log — only when there's something to report.
        const hasActivity = writtenCount > 0 || keepLocalCount > 0
            || concurrent.length > 0 || writeFailCount > 0 || deletedCount > 0;
        if (hasActivity) {
            const parts: string[] = [];
            if (writtenCount > 0) parts.push(`${writtenCount} written`);
            if (deletedCount > 0) parts.push(`${deletedCount} deleted`);
            if (keepLocalCount > 0) parts.push(`${keepLocalCount} keep-local`);
            if (concurrent.length > 0) parts.push(`${concurrent.length} concurrent`);
            if (writeFailCount > 0) parts.push(`${writeFailCount} failed`);
            if (chunkCount > 0) parts.push(`${chunkCount} chunks`);
            logInfo(`Pull: ${parts.join(", ")}`);
        }

        // Fire concurrent handlers (non-blocking). The handlers run
        // asynchronously — writePulledDocs returns immediately so the
        // pull loop continues receiving. Any bulkPut inside a handler
        // (e.g. vclock merge on keep-local) is NOT in pullWrittenIds,
        // so the push loop will naturally pick it up.
        for (const { filePath, localDoc, remoteDoc } of concurrent) {
            for (const h of this.onConcurrentHandlers) {
                Promise.resolve(h(filePath, localDoc, remoteDoc)).catch((e: any) =>
                    logError(`onConcurrent handler error: ${e?.message ?? e}`),
                );
            }
        }
    }

    /**
     * Handle a remote deletion detected in the changes feed.
     * Delegates to onPullDeleteHandler which checks for unpushed local
     * edits and either applies the deletion or signals a concurrent conflict.
     */
    private async handlePulledDeletion(
        docId: string,
        concurrent: Array<{ filePath: string; localDoc: CouchSyncDoc; remoteDoc: CouchSyncDoc }>,
    ): Promise<void> {
        const path = filePathFromId(docId);
        const localDoc = await this.localDb.get<FileDoc>(docId);

        // No local doc or already deleted — nothing to do.
        if (!localDoc || !isFileDoc(localDoc) || localDoc.deleted) return;

        if (this.onPullDeleteHandler) {
            const hasUnpushed = await this.onPullDeleteHandler(path, localDoc);
            if (hasUnpushed) {
                // Remote deletion vs local edit → concurrent conflict.
                const tombstone: FileDoc = {
                    _id: docId, type: "file", chunks: [],
                    mtime: localDoc.mtime, ctime: localDoc.ctime,
                    size: 0, deleted: true, vclock: {},
                };
                concurrent.push({ filePath: path, localDoc, remoteDoc: tombstone });
                logDebug(`  ⚡ ${path} (concurrent: remote-deleted vs local-edit)`);
            }
        }
    }

    /**
     * Push docs to remote. Fetches current remote revs and threads them
     * onto the docs before bulkDocs, same approach as remote-couch.ts
     * pushDocs().
     */
    private async pushDocs(docs: CouchSyncDoc[]): Promise<void> {
        if (!this.client || docs.length === 0) return;

        // Strip local _rev, prepare docs for remote.
        const prepared: Array<CouchSyncDoc & { _rev?: string }> = docs.map(
            (d) => stripRev(d) as CouchSyncDoc,
        );

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

        // Count results and log per-file details.
        let fileCount = 0;
        let chunkCount = 0;
        let deniedCount = 0;
        let conflictCount = 0;

        for (let i = 0; i < results.length; i++) {
            const res = results[i];
            const doc = prepared[i];
            const isFile = doc._id?.startsWith("file:");
            const isChunk = doc._id?.startsWith("chunk:");

            if (res.error === "forbidden") {
                const path = isFile ? filePathFromId(doc._id) : doc._id;
                logDebug(`  → ${path} (denied: ${res.reason})`);
                deniedCount++;
                if (!this.deniedWarningEmitted) {
                    this.deniedWarningEmitted = true;
                    this.emitError(
                        "Some documents were denied — check CouchDB _security permissions.",
                    );
                }
            } else if (res.error === "conflict") {
                const path = isFile ? filePathFromId(doc._id) : doc._id;
                logDebug(`  → ${path} (conflict, will resolve on next pull)`);
                conflictCount++;
            } else {
                // Success — track for echo suppression in pull.
                this.recentlyPushedIds.add(doc._id);
                if (isFile) {
                    logDebug(`  → ${filePathFromId(doc._id)}`);
                    fileCount++;
                } else if (isChunk) {
                    chunkCount++;
                }
            }
        }

        // Summary — only when files were pushed.
        if (fileCount > 0 || deniedCount > 0 || conflictCount > 0) {
            const parts: string[] = [];
            if (fileCount > 0) parts.push(`${fileCount} files`);
            if (chunkCount > 0) parts.push(`${chunkCount} chunks`);
            if (deniedCount > 0) parts.push(`${deniedCount} denied`);
            if (conflictCount > 0) parts.push(`${conflictCount} conflicts`);
            logInfo(`Push: ${parts.join(", ")}`);
        }
    }

    // ── Internal: Checkpoints ─────────────────────────────

    private async loadCheckpoints(): Promise<void> {
        // Checkpoints live in the docs-store meta so they can sit in the
        // same rw tx as pull-written docs. Migrate from the legacy metaStore
        // location transparently on first load.
        const docsStore = this.localDb.getStore();
        let remoteSeq = await docsStore.getMeta<number | string>(META_REMOTE_SEQ);
        let pushSeq = await docsStore.getMeta<number | string>(META_PUSH_SEQ);

        if (remoteSeq === null && pushSeq === null) {
            const legacy = this.localDb.getMetaStore();
            const legacyRemote = await legacy.getMeta<number | string>(META_REMOTE_SEQ);
            const legacyPush = await legacy.getMeta<number | string>(META_PUSH_SEQ);
            if (legacyRemote !== null || legacyPush !== null) {
                const meta: Array<{ op: "put"; key: string; value: unknown }> = [];
                if (legacyRemote !== null) meta.push({ op: "put", key: META_REMOTE_SEQ, value: legacyRemote });
                if (legacyPush !== null) meta.push({ op: "put", key: META_PUSH_SEQ, value: legacyPush });
                await docsStore.runWrite({ meta });
                await legacy.runWrite({
                    meta: [
                        { op: "delete", key: META_REMOTE_SEQ },
                        { op: "delete", key: META_PUSH_SEQ },
                    ],
                });
                remoteSeq = legacyRemote;
                pushSeq = legacyPush;
                logDebug("checkpoints migrated from legacy metaStore");
            }
        }

        if (remoteSeq !== null) this.remoteSeq = remoteSeq;
        if (pushSeq !== null) this.lastPushedSeq = pushSeq;
        logDebug(`checkpoints loaded: remoteSeq=${this.remoteSeq} pushSeq=${this.lastPushedSeq}`);
    }

    private async saveCheckpoints(): Promise<void> {
        try {
            // Both sequence checkpoints land in the docs store so a later
            // pull-commit refactor can inline them into the same tx.
            await this.localDb.getStore().runWrite({
                meta: [
                    { op: "put", key: META_REMOTE_SEQ, value: this.remoteSeq },
                    { op: "put", key: META_PUSH_SEQ, value: this.lastPushedSeq },
                ],
            });
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
        if (this.authError) return;

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
            const consumedNum = SyncEngine.seqNumericPrefix(this.remoteSeq);

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
        if (!this.hasBeenIdle) {
            this.hasBeenIdle = true;
            for (const cb of this.idleCallbacks) cb();
            this.idleCallbacks = [];
        }
        for (const handler of this.onPausedHandlers) {
            try { handler(); } catch (e) {
                logError(`CouchSync: onPaused handler error: ${e?.message ?? e}`);
            }
        }
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

    private fireReconnectHandlers(): void {
        for (const handler of this.onReconnectHandlers) {
            try {
                handler();
            } catch (e) {
                logError(`CouchSync: onReconnect handler error: ${e?.message ?? e}`);
            }
        }
    }

    // ── Internal: Verify reachability ─────────────────────

    /** Verify the server can be reached. On failure, transitions to hard
     *  error and returns false. */
    private async verifyReachable(): Promise<boolean> {
        const err = await this.testConnection();
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
