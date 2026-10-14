import type { MobileStatusPosition } from "../settings.ts";
import { VirtualKeyboard } from "./virtual-keyboard.ts";

/** Space kept between the status and the top of Obsidian's editing toolbar. */
const TOOLBAR_GAP = 4;

/**
 * Places the floating mobile status (a `position: fixed` element) where the
 * settings put it, raised above the on-screen keyboard while it is open.
 *
 * The settings' `bottom` is a distance from the bottom of what is visible,
 * so an open keyboard adds its height to it. While a note is edited,
 * Obsidian also shows its toolbar (`.mobile-toolbar`) just above the
 * keyboard, full width. The status never goes below the toolbar's top, so
 * a small `bottom` does not leave it under the toolbar. Obsidian marks the
 * toolbar's opening and closing with a class on the body
 * (`mod-toolbar-open`), which is watched as well as the keyboard, since the
 * toolbar may be laid out after the keyboard's events.
 */
export class MobileStatusPlacement {
    private readonly keyboard: VirtualKeyboard;
    private bodyObserver: MutationObserver | null = null;

    constructor(
        private readonly el: HTMLElement,
        private readonly win: Window,
        private readonly getPosition: () => MobileStatusPosition,
    ) {
        this.keyboard = new VirtualKeyboard(win, () => this.apply());
    }

    start(): void {
        this.keyboard.start();
        if (!this.bodyObserver && typeof MutationObserver === "function") {
            this.bodyObserver = new MutationObserver(() => this.apply());
            this.bodyObserver.observe(this.win.document.body, {
                attributes: true,
                attributeFilter: ["class"],
            });
        }
        this.apply();
    }

    stop(): void {
        this.keyboard.stop();
        this.bodyObserver?.disconnect();
        this.bodyObserver = null;
    }

    apply(): void {
        const m = this.getPosition();
        const toolbar = this.toolbarCover();
        const bottom = Math.max(
            m.bottom + this.keyboard.height(),
            toolbar > 0 ? toolbar + TOOLBAR_GAP : 0,
        );
        this.el.style.bottom = `${bottom}px`;
        this.el.style.left = m.align === "left" ? `${m.offset}px` : "";
        this.el.style.right = m.align === "right" ? `${m.offset}px` : "";
    }

    /** CSS px from the window's bottom up to the editing toolbar's top; 0 without one. */
    private toolbarCover(): number {
        const bar = this.win.document.querySelector(".mobile-toolbar");
        if (!bar) return 0;
        const rect = bar.getBoundingClientRect();
        if (rect.height <= 0) return 0;
        return Math.max(0, Math.round(this.win.innerHeight - rect.top));
    }
}
