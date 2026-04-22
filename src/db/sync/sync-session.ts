/**
 * SyncSession — 1 live session の identity.
 *
 * Owns:
 *   - the CouchClient for this session
 *   - EchoTracker (pull/push echo suppression, session-scoped state)
 *   - PullWriter (uses this session's echoes)
 *   - PullPipeline / PushPipeline
 *
 * Cross-session concerns (checkpoints, events, errorRecovery) come in
 * via shared-object references — session doesn't own those, it uses them.
 *
 * Lifetime: `disposed` boolean + `settled` Promise. dispose() flips the
 * flag; pipelines observe it via their isCancelled closure and exit at
 * the next await boundary. settled resolves once all tasks (catchup +
 * live loops) have finished.
 */

import type { FileDoc } from "../../types.ts";
import type { LocalDB } from "../local-db.ts";
import type { ICouchClient } from "../interfaces.ts";
import type { ConflictResolver } from "../../conflict/conflict-resolver.ts";
import { EchoTracker } from "./echo-tracker.ts";
import type { SyncEvents } from "./sync-events.ts";
import type { Checkpoints } from "./checkpoints.ts";
import { PullWriter } from "./pull-writer.ts";
import { PullPipeline } from "./pull-pipeline.ts";
import { PushPipeline } from "./push-pipeline.ts";
import { logDebug, logError } from "../../ui/log.ts";

export interface SyncSessionDeps {
    /** Monotonic identifier supplied by SyncEngine. Shows up in pipeline
     *  and teardown logs so concurrent sessions are distinguishable. */
    epoch: number;
    client: ICouchClient;
    localDb: LocalDB;
    events: SyncEvents;
    checkpoints: Checkpoints;
    getConflictResolver: () => ConflictResolver | undefined;
    ensureChunks: (doc: FileDoc) => Promise<void>;
    handleLocalDbError: (e: unknown, ctx: string) => void;
    /** Invoked from pipelines when a transient upstream error (auth /
     *  5xx) occurs. The supervisor (SyncEngine) decides escalation. */
    onTransientError: (err: unknown) => void;
}

interface LabeledTask {
    label: string;
    promise: Promise<unknown>;
    settled: boolean;
}

export class SyncSession {
    readonly epoch: number;
    readonly client: ICouchClient;
    readonly echoes: EchoTracker;
    readonly pullWriter: PullWriter;
    /** Aborted on dispose(). Pipelines, delays, and HTTP calls observe
     *  this to break out of in-flight awaits without waiting for wall-
     *  clock timeouts. Single owner = one AbortController per session. */
    readonly signal: AbortSignal;

    private _disposed = false;
    private readonly controller: AbortController;
    private tasks: LabeledTask[] = [];
    /** Pending delay() entries — disposed wakes them all so loops exit
     *  immediately rather than waiting out the remaining backoff. */
    private pendingDelays = new Set<{ timer: ReturnType<typeof setTimeout>; resolve: () => void }>();
    private readonly pullPipeline: PullPipeline;
    private readonly pushPipeline: PushPipeline;

    constructor(deps: SyncSessionDeps) {
        this.epoch = deps.epoch;
        this.client = deps.client;
        this.controller = new AbortController();
        this.signal = this.controller.signal;
        this.echoes = new EchoTracker();
        this.pullWriter = new PullWriter({
            localDb: deps.localDb,
            events: deps.events,
            echoes: this.echoes,
            checkpoints: deps.checkpoints,
            getConflictResolver: deps.getConflictResolver,
            ensureChunks: deps.ensureChunks,
        });
        const isCancelled = () => this._disposed;
        const delay = (ms: number) => this.delay(ms);
        this.pullPipeline = new PullPipeline({
            client: deps.client,
            pullWriter: this.pullWriter,
            checkpoints: deps.checkpoints,
            events: deps.events,
            sessionEpoch: deps.epoch,
            isCancelled,
            signal: this.signal,
            handleLocalDbError: deps.handleLocalDbError,
            onTransientError: deps.onTransientError,
            delay,
        });
        this.pushPipeline = new PushPipeline({
            localDb: deps.localDb,
            client: deps.client,
            echoes: this.echoes,
            events: deps.events,
            checkpoints: deps.checkpoints,
            sessionEpoch: deps.epoch,
            isCancelled,
            signal: this.signal,
            handleLocalDbError: deps.handleLocalDbError,
            delay,
        });
    }

    get disposed(): boolean { return this._disposed; }

    async runCatchup(): Promise<void> {
        const p = this.pullPipeline.runCatchup();
        this.track("catchup", p);
        await p;
    }

    startLive(): void {
        this.track(
            "pullLoop",
            this.pullPipeline.runLongpoll().catch((e) =>
                logError(`CouchSync: [sess#${this.epoch}] pullLoop unexpected exit: ${e?.message ?? e}`),
            ),
        );
        this.track(
            "pushLoop",
            this.pushPipeline.run().catch((e) =>
                logError(`CouchSync: [sess#${this.epoch}] pushLoop unexpected exit: ${e?.message ?? e}`),
            ),
        );
    }

    private track(label: string, promise: Promise<unknown>): void {
        const entry: LabeledTask = { label, promise, settled: false };
        this.tasks.push(entry);
        // Use then(onF, onR) — `.finally()` forwards rejections down a
        // new chain with no awaiter and trips "unhandled rejection".
        // Here both branches return void so the tracking chain always
        // resolves fulfilled.
        promise.then(
            () => { entry.settled = true; },
            () => { entry.settled = true; },
        );
    }

    dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        const unsettled = this.tasks.filter((t) => !t.settled).map((t) => t.label);
        logDebug(
            `[sess#${this.epoch}] session dispose: tasks=${this.tasks.length} (unsettled=[${unsettled.join(",")}]) pendingDelays=${this.pendingDelays.size}`,
        );
        // Wake any pending delay() so loops exit immediately.
        for (const d of this.pendingDelays) {
            clearTimeout(d.timer);
            d.resolve();
        }
        this.pendingDelays.clear();
        // Abort in-flight HTTP/fetch and signal-aware awaits in one shot.
        this.controller.abort();
    }

    get settled(): Promise<void> {
        return Promise.allSettled(this.tasks.map((t) => t.promise)).then(() => {});
    }

    /** Labels of tasks that have not yet resolved/rejected. Used by
     *  teardown diagnostics to say *which* task kept us waiting. */
    unsettledLabels(): string[] {
        return this.tasks.filter((t) => !t.settled).map((t) => t.label);
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => {
            if (this._disposed) { resolve(); return; }
            const entry: { timer: ReturnType<typeof setTimeout>; resolve: () => void } = {
                timer: setTimeout(() => {
                    this.pendingDelays.delete(entry);
                    resolve();
                }, ms),
                resolve,
            };
            this.pendingDelays.add(entry);
        });
    }
}
