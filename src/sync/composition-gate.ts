/**
 * Holds back vault-write operations on a path while the editor for that
 * path is in IME composition.
 *
 * When a remote pull arrives for a file the user is mid-converting in
 * an IME (Japanese, Chinese, etc.), applying the write immediately
 * destroys the in-progress composition decoration in CodeMirror. The
 * gate lets `VaultWriter.applyRemoteContent` defer the write until
 * `compositionend`, then drains the queued ops in FIFO order.
 *
 * The gate is event-source-agnostic: it consumes a `CompositionTracker`
 * abstraction so production wires it to Obsidian DOM events while tests
 * can drive it synchronously.
 */

/**
 * Source of "is path P currently composing?" facts plus a stream of
 * "composition ended for path P" notifications.
 */
export interface CompositionTracker {
    /** True when at least one editor pane for `path` is mid-composition. */
    isComposing(path: string): boolean;

    /**
     * Subscribe to "composition ended" notifications. Fired when the
     * last composing pane for a path returns to non-composing state.
     * Returns an unsubscribe function.
     */
    onCompositionEnd(cb: (path: string) => void): () => void;
}

export interface CompositionGateOptions {
    /**
     * Maximum time to hold a deferred op before force-draining it
     * (composition stuck because user switched apps, IDE froze, etc.).
     * Default 30 s — long enough for Google IME's longest learning-
     * dictionary commits but short enough to bound the worst case.
     */
    timeoutMs?: number;
}

interface DeferredEntry {
    run: () => Promise<void>;
    cancel: (reason: Error) => void;
}

export class CompositionGate {
    private deferred = new Map<string, DeferredEntry[]>();
    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    /** Per-path drain lock — prevents concurrent runQueue invocations. */
    private draining = new Set<string>();
    private unsubscribe: (() => void) | null = null;
    private readonly timeoutMs: number;

    constructor(
        private tracker: CompositionTracker,
        options: CompositionGateOptions = {},
    ) {
        this.timeoutMs = options.timeoutMs ?? 30_000;
    }

    start(): void {
        if (this.unsubscribe) return;
        this.unsubscribe = this.tracker.onCompositionEnd((path) => {
            void this.runQueue(path, false);
        });
    }

    stop(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        for (const t of this.timers.values()) clearTimeout(t);
        this.timers.clear();
    }

    /**
     * Run `fn` immediately if `path` is not composing and has no
     * pending queue. Otherwise enqueue and run on next drain.
     *
     * The returned Promise resolves with `fn`'s value, or rejects with
     * `fn`'s thrown error or with a flush error if the gate is
     * destructively flushed (plugin unload) before the op runs.
     */
    defer<T>(path: string, fn: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const entry: DeferredEntry = {
                run: async () => {
                    try { resolve(await fn()); }
                    catch (e) { reject(e); }
                },
                cancel: (reason) => reject(reason),
            };
            const queue = this.deferred.get(path) ?? [];
            queue.push(entry);
            this.deferred.set(path, queue);
            this.armTimer(path);
            // Try to drain right now — fast path when not composing
            // and no other drain in flight.
            void this.runQueue(path, false);
        });
    }

    /**
     * Drain `path`'s queue regardless of composition state. Used by
     * external triggers (timeout, layout-change, window blur).
     */
    forceFlush(path: string): Promise<void> {
        return this.runQueue(path, true);
    }

    /**
     * Destructive flush — reject all pending ops without running them.
     * For plugin unload only.
     */
    flushAll(): void {
        for (const t of this.timers.values()) clearTimeout(t);
        this.timers.clear();
        const reason = new Error("CompositionGate flushed (plugin unload)");
        for (const queue of this.deferred.values()) {
            for (const entry of queue) entry.cancel(reason);
        }
        this.deferred.clear();
    }

    /** @internal test helper */
    pendingCount(path: string): number {
        return this.deferred.get(path)?.length ?? 0;
    }

    // ── internals ──────────────────────────────────────────

    private armTimer(path: string): void {
        if (this.timers.has(path)) return;
        const t = setTimeout(() => {
            this.timers.delete(path);
            void this.runQueue(path, true);
        }, this.timeoutMs);
        this.timers.set(path, t);
    }

    /**
     * Drain `path`'s queue serially until empty or — when `force` is
     * false — until composition resumes. Re-entrant: if called while
     * already draining the same path, returns immediately and the
     * outer drainer will see the new entries.
     */
    private async runQueue(path: string, force: boolean): Promise<void> {
        if (this.draining.has(path)) return;
        this.draining.add(path);
        try {
            while (true) {
                const queue = this.deferred.get(path);
                if (!queue || queue.length === 0) break;
                if (!force && this.tracker.isComposing(path)) break;
                const entry = queue.shift()!;
                await entry.run();
            }
            const remaining = this.deferred.get(path);
            if (!remaining || remaining.length === 0) {
                this.deferred.delete(path);
                const t = this.timers.get(path);
                if (t) {
                    clearTimeout(t);
                    this.timers.delete(path);
                }
            }
        } finally {
            this.draining.delete(path);
        }
    }
}
