/**
 * In-memory CompositionTracker for tests. Tests call `setComposing()`
 * to flip the state and `endComposition()` to fire the end notification.
 */

import type { CompositionTracker } from "../../src/sync/composition-gate.ts";

export class FakeCompositionTracker implements CompositionTracker {
    private composing = new Set<string>();
    private listeners: Array<(path: string) => void> = [];

    isComposing(path: string): boolean {
        return this.composing.has(path);
    }

    onCompositionEnd(cb: (path: string) => void): () => void {
        this.listeners.push(cb);
        return () => {
            const i = this.listeners.indexOf(cb);
            if (i >= 0) this.listeners.splice(i, 1);
        };
    }

    // ── test helpers ────────────────────────────────────────

    /** Mark `path` as composing without firing any event. */
    startComposition(path: string): void {
        this.composing.add(path);
    }

    /** Clear `path`'s composing flag and notify listeners. */
    endComposition(path: string): void {
        this.composing.delete(path);
        for (const l of this.listeners) l(path);
    }

    /** Number of active onCompositionEnd subscribers. */
    get listenerCount(): number {
        return this.listeners.length;
    }
}
