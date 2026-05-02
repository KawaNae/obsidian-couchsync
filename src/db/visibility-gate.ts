/**
 * VisibilityGate — gates the sync loops while the page is hidden.
 *
 * iOS Safari force-aborts in-flight IndexedDB transactions on
 * `visibilitychange→hidden`. The push/pull loops would otherwise spin
 * on the dead handle, exhaust HandleGuard's reopen budget, and surface
 * a false "DB is degraded — restart Obsidian" notice. Pausing the
 * loops while hidden side-steps the problem entirely; HandleGuard's
 * reopen path remains as the second line of defence.
 *
 * Two cooperation points with the sync loops:
 *
 *   - `waitVisible(signal)`: top-of-loop gate. The pipeline blocks here
 *     while hidden so it never starts new work mid-suspend.
 *
 *   - `linkedAbortOnHidden(externalSignal)`: per-cycle abort scope.
 *     Wraps the cycle's external (session) signal so any in-flight
 *     fetch / I/O the cycle started is *proactively* aborted on the
 *     `hidden` transition — before iOS gets a chance to rip-kill it
 *     and surface a "Load failed" artifact on the next resume.
 */

/** Minimal view of `document` we depend on — typed so tests can stub. */
interface VisibilityDocument {
    visibilityState: "visible" | "hidden" | "prerender" | string;
    addEventListener(type: "visibilitychange", listener: () => void): void;
    removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/** Handle returned by `linkedAbortOnHidden`. The `signal` aborts on
 *  either source; the caller must invoke `release()` after the cycle
 *  completes (success path or normal-error path) so the gate's hidden
 *  listener set doesn't accumulate stale entries across long-lived
 *  loops. `release()` is idempotent. */
export interface LinkedAbortHandle {
    signal: AbortSignal;
    release: () => void;
}

export interface VisibilityGate {
    /** True iff the page is currently hidden. */
    isHidden(): boolean;
    /** Resolve when the page is visible. Resolves immediately if already
     *  visible, on the next visibilitychange→visible if hidden, or
     *  immediately if `signal` is (or becomes) aborted. Never throws —
     *  the caller is expected to re-check its own cancellation flag. */
    waitVisible(signal: AbortSignal): Promise<void>;
    /** Returns an AbortSignal that aborts when EITHER:
     *   - this gate transitions to hidden, OR
     *   - `externalSignal` aborts.
     *  Used by sync pipelines for per-cycle I/O cancellation: an
     *  in-flight longpoll/bulk fetch is short-circuited the moment the
     *  page goes background, so iOS doesn't process a forced-abort
     *  artifact on the next resume. The returned handle's `release()`
     *  must be called once the cycle settles, even on success path. */
    linkedAbortOnHidden(externalSignal: AbortSignal): LinkedAbortHandle;
}

/** No-op gate for tests / non-browser hosts. `linkedAbortOnHidden`
 *  short-circuits to the external signal — there is no hidden state to
 *  trigger an extra abort, and a no-op `release` keeps the call shape
 *  identical so production code paths exercise the same control flow. */
export const ALWAYS_VISIBLE: VisibilityGate = {
    isHidden: () => false,
    waitVisible: () => Promise.resolve(),
    linkedAbortOnHidden: (externalSignal) => ({
        signal: externalSignal,
        release: () => {},
    }),
};

export class BrowserVisibilityGate implements VisibilityGate {
    private visibleWaiters = new Set<() => void>();
    private hiddenListeners = new Set<() => void>();
    private attached = false;
    private boundOnChange = () => this.handleChange();

    constructor(private doc: VisibilityDocument = document) {}

    attach(): void {
        if (this.attached) return;
        this.doc.addEventListener("visibilitychange", this.boundOnChange);
        this.attached = true;
    }

    detach(): void {
        if (!this.attached) return;
        this.doc.removeEventListener("visibilitychange", this.boundOnChange);
        this.attached = false;
        // Wake any pending waiters and trip any hidden listeners so
        // their loops aren't stuck after the engine shuts down.
        this.flushVisibleWaiters();
        this.flushHiddenListeners();
    }

    isHidden(): boolean {
        return this.doc.visibilityState === "hidden";
    }

    waitVisible(signal: AbortSignal): Promise<void> {
        if (!this.isHidden()) return Promise.resolve();
        if (signal.aborted) return Promise.resolve();
        return new Promise<void>((resolve) => {
            const done = () => {
                this.visibleWaiters.delete(done);
                signal.removeEventListener("abort", done);
                resolve();
            };
            this.visibleWaiters.add(done);
            signal.addEventListener("abort", done, { once: true });
        });
    }

    linkedAbortOnHidden(externalSignal: AbortSignal): LinkedAbortHandle {
        const controller = new AbortController();

        // Already-aborted short-circuits: avoid registering listeners
        // on an event source that will never need them.
        if (externalSignal.aborted || this.isHidden()) {
            controller.abort();
            return { signal: controller.signal, release: () => {} };
        }

        // Single-fire abort — both sources race to call this; the second
        // call is a no-op via the `released` latch.
        let released = false;
        const onTrigger = () => {
            if (released) return;
            released = true;
            externalSignal.removeEventListener("abort", onTrigger);
            this.hiddenListeners.delete(onTrigger);
            controller.abort();
        };

        externalSignal.addEventListener("abort", onTrigger, { once: true });
        this.hiddenListeners.add(onTrigger);

        return {
            signal: controller.signal,
            release: () => {
                if (released) return;
                released = true;
                externalSignal.removeEventListener("abort", onTrigger);
                this.hiddenListeners.delete(onTrigger);
                // No abort() — release means "cycle settled normally".
            },
        };
    }

    private handleChange(): void {
        if (this.isHidden()) {
            this.flushHiddenListeners();
        } else {
            this.flushVisibleWaiters();
        }
    }

    private flushVisibleWaiters(): void {
        // Snapshot so waiters can mutate the set during resolution.
        const snapshot = [...this.visibleWaiters];
        this.visibleWaiters.clear();
        for (const fn of snapshot) fn();
    }

    private flushHiddenListeners(): void {
        // Hidden listeners are one-shot abort triggers — each one will
        // remove itself via the latch, but we snapshot+clear up front
        // for the same reason: re-entrancy safety.
        const snapshot = [...this.hiddenListeners];
        this.hiddenListeners.clear();
        for (const fn of snapshot) fn();
    }
}
