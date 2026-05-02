/**
 * SyncEvents — typed event bus that subsumes the handler arrays
 * SyncEngine used to carry as individual public methods (`onStateChange`,
 * `onError`, etc.).
 *
 * Two flavours of event, matching the semantics they need:
 *
 *   - Fire-and-forget notifications (`emit`): the controller emits,
 *     subscribers react. Handler exceptions are logged and swallowed so
 *     one buggy subscriber can't block the controller.
 *
 *   - Queries (`emitAsyncAny`): each subscriber returns a boolean; the
 *     aggregate answer is "any subscriber said true". Used for
 *     `pull-delete`, where the caller asks "does anyone have unpushed
 *     local edits for this path?" and treats a yes as a concurrent
 *     conflict.
 *
 * Plus one once-latch primitive (`onceIdle` / `fireIdle`) that fires
 * every registered callback exactly once when the session first reaches
 * idle. Registrations after the latch has been tripped fire
 * immediately — a late subscriber still sees the "catchup done" signal.
 *
 * History note: an awaited-broadcast API (`emitAsync` + `onAsync`) used
 * to live here for `pull-write`. Its only subscriber was the vault
 * writer, and the bus's catch-all swallowed write errors, causing
 * `Pull: N written` log lines to misreport silently failed writes. The
 * single subscriber was promoted to a function DI parameter on
 * SyncEngine (`applyPullWrite`) and the awaited API was removed so the
 * trap can't be fallen into again — re-introduce only when a real
 * multi-subscriber awaited use case appears.
 */

import { logError } from "../../ui/log.ts";
import type { CouchSyncDoc, FileDoc } from "../../types.ts";
import type { SyncState } from "../reconnect-policy.ts";

// ── Event payloads ───────────────────────────────────────

export interface SyncEventMap {
    "state-change": { state: SyncState };
    error: { message: string };
    paused: void;
    reconnect: void;
    concurrent: {
        filePath: string;
        localDoc: CouchSyncDoc;
        remoteDoc: CouchSyncDoc;
    };
    "auto-resolve": { filePath: string };
    "catchup-complete": void;
    "catchup-failed": void;
    /** Local DB handle is unrecoverable in this WebView (HandleGuard
     *  exhausted its reopen budget — typically iOS WebKit IDB poisoning
     *  after a long suspend). Subscribers should surface a recovery
     *  affordance to the user (e.g. a Reload-now Notice). Emitted at
     *  most once per SyncEngine lifecycle (`degraded` latch). */
    degraded: { message: string };
}

export interface SyncQueryEventMap {
    /** Return true if local has unpushed edits for this path (→ concurrent conflict). */
    "pull-delete": { path: string; localDoc: FileDoc };
}

type SyncHandler<T> = T extends void
    ? () => void
    : (payload: T) => void;

type SyncQueryHandler<T> = (payload: T) => Promise<boolean>;

// Fire-and-forget uses a normalized `(p: T) => void` storage signature:
// void-payload handlers (`() => void`) are structurally assignable via
// parameter-bivariance, so emit() can invoke `h(payload)` uniformly.
type InternalHandler<T> = (payload: T) => void;

type FireAndForgetHandlers = {
    [K in keyof SyncEventMap]: Set<InternalHandler<SyncEventMap[K]>>;
};
type QueryHandlers = {
    [K in keyof SyncQueryEventMap]: Set<SyncQueryHandler<SyncQueryEventMap[K]>>;
};

// ── SyncEvents ───────────────────────────────────────────

export class SyncEvents {
    private fireAndForget: FireAndForgetHandlers = {
        "state-change": new Set(),
        error: new Set(),
        paused: new Set(),
        reconnect: new Set(),
        concurrent: new Set(),
        "auto-resolve": new Set(),
        "catchup-complete": new Set(),
        "catchup-failed": new Set(),
        degraded: new Set(),
    };
    private queries: QueryHandlers = {
        "pull-delete": new Set(),
    };

    private idleCallbacks: Array<() => void> = [];
    private idleFired = false;

    // ── Fire-and-forget ─────────────────────────────────

    on<K extends keyof SyncEventMap>(
        type: K,
        handler: SyncHandler<SyncEventMap[K]>,
    ): () => void {
        const set = this.fireAndForget[type];
        // SyncHandler<void> is `() => void`; storage uses the uniform
        // `(p: void) => void`. The shapes are compatible at runtime (a
        // 0-arg fn tolerates an extra arg) but TS can't simplify the
        // conditional type through a generic K, so we assert structurally.
        const h = handler as InternalHandler<SyncEventMap[K]>;
        set.add(h);
        return () => { set.delete(h); };
    }

    emit<K extends keyof SyncEventMap>(
        type: K,
        ...args: SyncEventMap[K] extends void ? [] : [SyncEventMap[K]]
    ): void {
        const payload = args[0] as SyncEventMap[K];
        const set = this.fireAndForget[type];
        for (const h of set) {
            try {
                h(payload);
            } catch (e: any) {
                logError(`SyncEvents[${String(type)}] handler error: ${e?.message ?? e}`);
            }
        }
    }

    // ── Queries ─────────────────────────────────────────

    onQuery<K extends keyof SyncQueryEventMap>(
        type: K,
        handler: SyncQueryHandler<SyncQueryEventMap[K]>,
    ): () => void {
        const set = this.queries[type];
        set.add(handler);
        return () => { set.delete(handler); };
    }

    /** True if any subscriber returned true (or false when none registered). */
    async emitAsyncAny<K extends keyof SyncQueryEventMap>(
        type: K,
        payload: SyncQueryEventMap[K],
    ): Promise<boolean> {
        const set = this.queries[type];
        let any = false;
        for (const h of set) {
            try {
                if (await h(payload)) any = true;
            } catch (e: any) {
                logError(`SyncEvents[${String(type)}] query error: ${e?.message ?? e}`);
            }
        }
        return any;
    }

    // ── Idle once-latch ─────────────────────────────────

    /**
     * Register a callback to fire when the session first reaches idle.
     * If the latch has already tripped, the callback fires immediately.
     */
    onceIdle(cb: () => void): void {
        if (this.idleFired) {
            try { cb(); } catch (e: any) {
                logError(`SyncEvents[idle] handler error: ${e?.message ?? e}`);
            }
            return;
        }
        this.idleCallbacks.push(cb);
    }

    /**
     * Trip the idle latch. Fires every pending callback exactly once;
     * subsequent fireIdle calls within the same session are no-ops
     * (`resetIdle` clears the latch on teardown).
     */
    fireIdle(): void {
        if (this.idleFired) return;
        this.idleFired = true;
        const pending = this.idleCallbacks;
        this.idleCallbacks = [];
        for (const cb of pending) {
            try { cb(); } catch (e: any) {
                logError(`SyncEvents[idle] handler error: ${e?.message ?? e}`);
            }
        }
    }

    /** Reset the once-latch on session teardown so the next session can re-trip it. */
    resetIdle(): void {
        this.idleFired = false;
        this.idleCallbacks = [];
    }
}
