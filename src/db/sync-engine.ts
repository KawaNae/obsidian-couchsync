/**
 * SyncEngine — sync loop using CouchClient HTTP + ILocalStore.
 *
 *   - CouchClient.changes() + bulkGet() for catchup pull
 *   - CouchClient.changesLongpoll() loop for live pull
 *   - localDb.changes() poll + CouchClient.bulkDocs() for push
 *   - CouchClient.info() for health probes
 */

import type { CouchSyncDoc, FileDoc } from "../types.ts";
import { isReplicatedDocId } from "../types/doc-id.ts";
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
import { logDebug, logInfo, logWarn, logError } from "../ui/log.ts";

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
        this.deniedWarningEmitted = false;
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
            this.enterHardError(this.classifyError(e));
            return;
        }

        if (this.syncEpoch !== myEpoch) return;

        // Catchup complete = caught up → connected immediately.
        this.lastHealthyAt = Date.now();
        this.client = client;
        this.running = true;
        this.setState("connected");
        this.firePausedCallbacks();
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

                const detail = this.classifyError(e);

                if (detail.kind === "auth" || detail.kind === "server") {
                    this.handleTransientError(e);
                } else {
                    // Network/timeout errors on longpoll are expected.
                    logDebug(
                        `pullLoop: ${detail.kind} error, retrying — ${detail.message}`,
                    );
                }

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
                    this.lastHealthyAt = Date.now();
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
                logDebug(`push error: ${e?.message ?? e}`);
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

        for (const row of result.results) {
            if (!row.doc || row.deleted) continue;
            const { _rev, ...rest } = row.doc as any;
            const remoteDoc = rest as CouchSyncDoc;

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
                        logDebug(`  ⚡ ${filePath} (concurrent)`);
                        concurrent.push({ filePath, localDoc, remoteDoc });
                        continue; // keep local, don't write remote
                    }
                    // "take-remote": fall through to accept
                }
            }

            accepted.push(remoteDoc);
        }

        // Write accepted docs (including chunks) BEFORE firing concurrent
        // handlers — the handler needs remote chunks in local DB to show
        // the diff modal.
        if (accepted.length > 0) {
            await this.localDb.bulkPut(accepted);

            // Pull-driven vault writes: write accepted FileDocs directly
            // to vault. Chunks are already in localDB from the bulkPut
            // above, so dbToFile's getChunks is guaranteed to succeed.
            if (this.onPullWriteHandler) {
                for (const doc of accepted) {
                    if (isFileDoc(doc)) {
                        const path = filePathFromId(doc._id);
                        try {
                            await this.onPullWriteHandler(doc);
                            logDebug(`  ← ${path} (take-remote)`);
                            writtenCount++;
                        } catch (e) {
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
                    } catch (e) {
                        logError(`onChange handler error: ${e?.message ?? e}`);
                    }
                }
            }
        }

        // Summary log — only when there's something to report.
        const hasActivity = writtenCount > 0 || keepLocalCount > 0 || concurrent.length > 0 || writeFailCount > 0;
        if (hasActivity) {
            const parts: string[] = [];
            if (writtenCount > 0) parts.push(`${writtenCount} written`);
            if (keepLocalCount > 0) parts.push(`${keepLocalCount} keep-local`);
            if (concurrent.length > 0) parts.push(`${concurrent.length} concurrent`);
            if (writeFailCount > 0) parts.push(`${writeFailCount} failed`);
            if (chunkCount > 0) parts.push(`${chunkCount} chunks`);
            logInfo(`Pull: ${parts.join(", ")}`);
        }

        // Fire concurrent handlers after chunks are written.
        for (const { filePath, localDoc, remoteDoc } of concurrent) {
            for (const h of this.onConcurrentHandlers) {
                try {
                    await h(filePath, localDoc, remoteDoc);
                } catch (e) {
                    logError(`CouchSync: onConcurrent handler error: ${e?.message ?? e}`);
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
            } else if (isFile) {
                logDebug(`  → ${filePathFromId(doc._id)}`);
                fileCount++;
            } else if (isChunk) {
                chunkCount++;
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
        const meta = this.localDb.getMetaStore();
        const remoteSeq = await meta.getMeta<number | string>(META_REMOTE_SEQ);
        const pushSeq = await meta.getMeta<number | string>(META_PUSH_SEQ);
        if (remoteSeq !== null) this.remoteSeq = remoteSeq;
        if (pushSeq !== null) this.lastPushedSeq = pushSeq;
        logDebug(`checkpoints loaded: remoteSeq=${this.remoteSeq} pushSeq=${this.lastPushedSeq}`);
    }

    private async saveCheckpoints(): Promise<void> {
        try {
            const meta = this.localDb.getMetaStore();
            await meta.putMeta(META_REMOTE_SEQ, this.remoteSeq);
            await meta.putMeta(META_PUSH_SEQ, this.lastPushedSeq);
        } catch (e) {
            logDebug(`checkpoint save error: ${e}`);
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
        logDebug(
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
        logDebug(`error retry scheduled in ${delay}ms (step ${this.errorRetryStep})`);
        this.errorRetryTimer = setTimeout(async () => {
            this.errorRetryTimer = null;
            this.errorRetryStep++;
            try {
                await this.requestReconnect("retry-backoff");
            } catch (e) {
                logError(`CouchSync: retry reconnect failed: ${e?.message ?? e}`);
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
                logError(`CouchSync: Health check error: ${e?.message ?? e}`);
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
            logDebug(`health: probe ok state=${this.state}`);
            return true;
        } catch (e: any) {
            if (this.syncEpoch !== sessionEpoch) return false;
            logDebug(`health: probe failed ${e?.message ?? e}`);
            this.enterHardError(this.classifyError(e));
            return false;
        } finally {
            this.probePromise = null;
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
                    logError(`CouchSync: onReconnect handler error: ${e?.message ?? e}`);
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
