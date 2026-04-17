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
import type { ErrorRecovery } from "../error-recovery.ts";
import { EchoTracker } from "./echo-tracker.ts";
import type { SyncEvents } from "./sync-events.ts";
import type { Checkpoints } from "./checkpoints.ts";
import { PullWriter } from "./pull-writer.ts";
import { PullPipeline } from "./pull-pipeline.ts";
import { PushPipeline } from "./push-pipeline.ts";
import { logError } from "../../ui/log.ts";

export interface SyncSessionDeps {
    client: ICouchClient;
    localDb: LocalDB;
    events: SyncEvents;
    errorRecovery: ErrorRecovery;
    checkpoints: Checkpoints;
    getConflictResolver: () => ConflictResolver | undefined;
    ensureChunks: (doc: FileDoc) => Promise<void>;
    handleLocalDbError: (e: unknown, ctx: string) => void;
}

export class SyncSession {
    readonly client: ICouchClient;
    readonly echoes: EchoTracker;
    readonly pullWriter: PullWriter;

    private _disposed = false;
    private tasks: Array<Promise<unknown>> = [];
    /** Pending delay() entries — disposed wakes them all so loops exit
     *  immediately rather than waiting out the remaining backoff. */
    private pendingDelays = new Set<{ timer: ReturnType<typeof setTimeout>; resolve: () => void }>();
    private readonly pullPipeline: PullPipeline;
    private readonly pushPipeline: PushPipeline;

    constructor(deps: SyncSessionDeps) {
        this.client = deps.client;
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
            errorRecovery: deps.errorRecovery,
            events: deps.events,
            isCancelled,
            handleLocalDbError: deps.handleLocalDbError,
            delay,
        });
        this.pushPipeline = new PushPipeline({
            localDb: deps.localDb,
            client: deps.client,
            echoes: this.echoes,
            events: deps.events,
            checkpoints: deps.checkpoints,
            isCancelled,
            handleLocalDbError: deps.handleLocalDbError,
            delay,
        });
    }

    get disposed(): boolean { return this._disposed; }

    async runCatchup(): Promise<void> {
        const p = this.pullPipeline.runCatchup();
        this.tasks.push(p);
        await p;
    }

    startLive(): void {
        this.tasks.push(
            this.pullPipeline.runLongpoll().catch((e) =>
                logError(`CouchSync: pullLoop unexpected exit: ${e?.message ?? e}`),
            ),
            this.pushPipeline.run().catch((e) =>
                logError(`CouchSync: pushLoop unexpected exit: ${e?.message ?? e}`),
            ),
        );
    }

    dispose(): void {
        this._disposed = true;
        // Wake any pending delay() so loops exit immediately.
        for (const d of this.pendingDelays) {
            clearTimeout(d.timer);
            d.resolve();
        }
        this.pendingDelays.clear();
    }

    get settled(): Promise<void> {
        return Promise.allSettled(this.tasks).then(() => {});
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
