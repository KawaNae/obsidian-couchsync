/**
 * Production CompositionTracker — listens to DOM composition events
 * on the focused CodeMirror contenteditable and to workspace events
 * to re-bind when the active leaf changes.
 *
 * IME composition is single-stream and tied to whichever element has
 * focus, so only the active leaf can be mid-composition at any moment.
 * The tracker maintains a map of `path → composing?` and fires the
 * callback registered by `CompositionGate` whenever a path returns to
 * non-composing state.
 *
 * Side-effect channels handled:
 *   - `compositionstart` / `compositionend` on `.cm-content` of the
 *     active leaf (DOM listeners)
 *   - `workspace.active-leaf-change` — rebind listeners to the new
 *     focused contenteditable; if the previous leaf was mid-
 *     composition, force-end it (focus loss aborts IME).
 *   - `window.blur` — same logic as leaf change; user switched apps.
 */

import type { App, EventRef, MarkdownView } from "obsidian";
import type { CompositionTracker } from "../sync/composition-gate.ts";
import { logDebug } from "../ui/log.ts";

export class ObsidianCompositionTracker implements CompositionTracker {
    private composingPaths = new Set<string>();
    private listeners: Array<(path: string) => void> = [];

    private boundEl: HTMLElement | null = null;
    private boundPath: string | null = null;

    private startHandler: (() => void) | null = null;
    private endHandler: (() => void) | null = null;

    private leafChangeRef: EventRef | null = null;
    private layoutChangeRef: EventRef | null = null;
    private blurHandler: (() => void) | null = null;

    constructor(private app: App) {}

    isComposing(path: string): boolean {
        return this.composingPaths.has(path);
    }

    onCompositionEnd(cb: (path: string) => void): () => void {
        this.listeners.push(cb);
        return () => {
            const i = this.listeners.indexOf(cb);
            if (i >= 0) this.listeners.splice(i, 1);
        };
    }

    /** Begin tracking. Bind to the currently active leaf. */
    start(): void {
        this.rebindToActiveLeaf();

        this.leafChangeRef = this.app.workspace.on("active-leaf-change", () => {
            this.rebindToActiveLeaf();
        });
        this.layoutChangeRef = this.app.workspace.on("layout-change", () => {
            this.rebindToActiveLeaf();
        });

        this.blurHandler = () => this.endAllCompositions("window-blur");
        window.addEventListener("blur", this.blurHandler);
    }

    /** Stop tracking and release all bindings. */
    stop(): void {
        this.unbindCurrent();
        if (this.leafChangeRef) {
            this.app.workspace.offref(this.leafChangeRef);
            this.leafChangeRef = null;
        }
        if (this.layoutChangeRef) {
            this.app.workspace.offref(this.layoutChangeRef);
            this.layoutChangeRef = null;
        }
        if (this.blurHandler) {
            window.removeEventListener("blur", this.blurHandler);
            this.blurHandler = null;
        }
        this.endAllCompositions("stop");
        this.listeners = [];
    }

    // ── internals ──────────────────────────────────────────

    private rebindToActiveLeaf(): void {
        const newPath = this.app.workspace.activeEditor?.file?.path ?? null;
        const newEl = this.findContentEl(newPath);

        // Same target — nothing to do.
        if (this.boundEl === newEl && this.boundPath === newPath) return;

        // Leaving a composing leaf without a real compositionend
        // (rare: user switched panes mid-IME — Obsidian typically
        // fires compositionend on focus loss but we belt-and-suspend).
        if (this.boundPath && this.composingPaths.has(this.boundPath)) {
            this.endComposition(this.boundPath, "leaf-change");
        }

        this.unbindCurrent();
        this.boundEl = newEl;
        this.boundPath = newPath;

        if (newEl && newPath) {
            this.startHandler = () => this.startComposition(newPath);
            this.endHandler = () => this.endComposition(newPath, "compositionend");
            newEl.addEventListener("compositionstart", this.startHandler);
            newEl.addEventListener("compositionend", this.endHandler);
        }
    }

    private unbindCurrent(): void {
        if (this.boundEl && this.startHandler) {
            this.boundEl.removeEventListener("compositionstart", this.startHandler);
        }
        if (this.boundEl && this.endHandler) {
            this.boundEl.removeEventListener("compositionend", this.endHandler);
        }
        this.boundEl = null;
        this.boundPath = null;
        this.startHandler = null;
        this.endHandler = null;
    }

    private findContentEl(path: string | null): HTMLElement | null {
        if (!path) return null;
        const view = this.app.workspace.activeEditor as MarkdownView | undefined;
        if (!view?.contentEl) return null;
        const el = view.contentEl.querySelector<HTMLElement>(
            ".cm-content[contenteditable=true]",
        );
        return el ?? null;
    }

    private startComposition(path: string): void {
        if (this.composingPaths.has(path)) return;
        this.composingPaths.add(path);
        logDebug(`compositionstart: ${path}`);
    }

    private endComposition(path: string, reason: string): void {
        if (!this.composingPaths.delete(path)) return;
        logDebug(`compositionend (${reason}): ${path}`);
        for (const l of this.listeners) {
            try { l(path); } catch (e) {
                logDebug(`composition listener failed: ${(e as Error)?.message ?? e}`);
            }
        }
    }

    private endAllCompositions(reason: string): void {
        const paths = Array.from(this.composingPaths);
        for (const p of paths) this.endComposition(p, reason);
    }
}
