/**
 * VisibilityGate — gates the sync loops while the page is hidden.
 *
 * iOS Safari force-aborts in-flight IndexedDB transactions on
 * `visibilitychange→hidden`. The push/pull loops would otherwise spin
 * on the dead handle, exhaust HandleGuard's reopen budget, and surface
 * a false "DB is degraded — restart Obsidian" notice. Pausing the
 * loops while hidden side-steps the problem entirely; HandleGuard's
 * reopen path remains as the second line of defence.
 */

/** Minimal view of `document` we depend on — typed so tests can stub. */
interface VisibilityDocument {
    visibilityState: "visible" | "hidden" | "prerender" | string;
    addEventListener(type: "visibilitychange", listener: () => void): void;
    removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface VisibilityGate {
    /** True iff the page is currently hidden. */
    isHidden(): boolean;
    /** Resolve when the page is visible. Resolves immediately if already
     *  visible, on the next visibilitychange→visible if hidden, or
     *  immediately if `signal` is (or becomes) aborted. Never throws —
     *  the caller is expected to re-check its own cancellation flag. */
    waitVisible(signal: AbortSignal): Promise<void>;
}

/** No-op gate for tests / non-browser hosts. */
export const ALWAYS_VISIBLE: VisibilityGate = {
    isHidden: () => false,
    waitVisible: () => Promise.resolve(),
};

export class BrowserVisibilityGate implements VisibilityGate {
    private waiters = new Set<() => void>();
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
        // Wake any pending waiters so their loops aren't stuck after
        // the engine shuts down.
        this.flushWaiters();
    }

    isHidden(): boolean {
        return this.doc.visibilityState === "hidden";
    }

    waitVisible(signal: AbortSignal): Promise<void> {
        if (!this.isHidden()) return Promise.resolve();
        if (signal.aborted) return Promise.resolve();
        return new Promise<void>((resolve) => {
            const done = () => {
                this.waiters.delete(done);
                signal.removeEventListener("abort", done);
                resolve();
            };
            this.waiters.add(done);
            signal.addEventListener("abort", done, { once: true });
        });
    }

    private handleChange(): void {
        if (this.isHidden()) return;
        this.flushWaiters();
    }

    private flushWaiters(): void {
        // Snapshot so waiters can mutate the set during resolution.
        const snapshot = [...this.waiters];
        this.waiters.clear();
        for (const fn of snapshot) fn();
    }
}
