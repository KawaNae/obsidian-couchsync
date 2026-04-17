/**
 * SyncEvents — typed event bus that subsumes the eleven handler arrays
 * SyncEngine used to carry as individual public methods (`onStateChange`,
 * `onError`, `onPullWrite`, …).
 *
 * Three flavours of event, matching the semantics they need:
 *
 *   - Fire-and-forget notifications (`emit`): the controller emits,
 *     subscribers react. Handler exceptions are logged and swallowed so
 *     one buggy subscriber can't block the controller.
 *
 *   - Awaited notifications (`emitAsync`): the controller awaits all
 *     subscribers. Used for `pull-write`, where the vault write must
 *     complete before the next pull batch is written (otherwise chunks
 *     could be GC'd mid-flight).
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
}

export interface SyncAsyncEventMap {
    "pull-write": { doc: FileDoc };
}

export interface SyncQueryEventMap {
    /** Return true if local has unpushed edits for this path (→ concurrent conflict). */
    "pull-delete": { path: string; localDoc: FileDoc };
}

type SyncHandler<T> = T extends void
    ? () => void
    : (payload: T) => void;

type SyncAsyncHandler<T> = (payload: T) => Promise<void>;
type SyncQueryHandler<T> = (payload: T) => Promise<boolean>;

// ── SyncEvents ───────────────────────────────────────────

export class SyncEvents {
    private fireAndForget = new Map<keyof SyncEventMap, Set<(p: any) => void>>();
    private awaited = new Map<keyof SyncAsyncEventMap, Set<(p: any) => Promise<void>>>();
    private queries = new Map<keyof SyncQueryEventMap, Set<(p: any) => Promise<boolean>>>();

    private idleCallbacks: Array<() => void> = [];
    private idleFired = false;

    // ── Fire-and-forget ─────────────────────────────────

    on<K extends keyof SyncEventMap>(
        type: K,
        handler: SyncHandler<SyncEventMap[K]>,
    ): () => void {
        let set = this.fireAndForget.get(type);
        if (!set) {
            set = new Set();
            this.fireAndForget.set(type, set);
        }
        set.add(handler as (p: any) => void);
        return () => { set!.delete(handler as (p: any) => void); };
    }

    emit<K extends keyof SyncEventMap>(
        type: K,
        ...args: SyncEventMap[K] extends void ? [] : [SyncEventMap[K]]
    ): void {
        const payload = (args[0] ?? undefined) as SyncEventMap[K];
        const set = this.fireAndForget.get(type);
        if (!set) return;
        for (const h of set) {
            try {
                (h as any)(payload);
            } catch (e: any) {
                logError(`SyncEvents[${String(type)}] handler error: ${e?.message ?? e}`);
            }
        }
    }

    // ── Awaited notifications ───────────────────────────

    onAsync<K extends keyof SyncAsyncEventMap>(
        type: K,
        handler: SyncAsyncHandler<SyncAsyncEventMap[K]>,
    ): () => void {
        let set = this.awaited.get(type);
        if (!set) {
            set = new Set();
            this.awaited.set(type, set);
        }
        set.add(handler as (p: any) => Promise<void>);
        return () => { set!.delete(handler as (p: any) => Promise<void>); };
    }

    async emitAsync<K extends keyof SyncAsyncEventMap>(
        type: K,
        payload: SyncAsyncEventMap[K],
    ): Promise<void> {
        const set = this.awaited.get(type);
        if (!set) return;
        for (const h of set) {
            try {
                await h(payload);
            } catch (e: any) {
                logError(`SyncEvents[${String(type)}] async handler error: ${e?.message ?? e}`);
            }
        }
    }

    // ── Queries ─────────────────────────────────────────

    onQuery<K extends keyof SyncQueryEventMap>(
        type: K,
        handler: SyncQueryHandler<SyncQueryEventMap[K]>,
    ): () => void {
        let set = this.queries.get(type);
        if (!set) {
            set = new Set();
            this.queries.set(type, set);
        }
        set.add(handler as (p: any) => Promise<boolean>);
        return () => { set!.delete(handler as (p: any) => Promise<boolean>); };
    }

    /** True if any subscriber returned true (or false when none registered). */
    async emitAsyncAny<K extends keyof SyncQueryEventMap>(
        type: K,
        payload: SyncQueryEventMap[K],
    ): Promise<boolean> {
        const set = this.queries.get(type);
        if (!set) return false;
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
