import type { MobileStatusPosition } from "../settings.ts";
import { VirtualKeyboard } from "./virtual-keyboard.ts";

/** Space kept between the status and what it must not cross: the editing toolbar's top, the screen's top. */
const EDGE_GAP = 4;

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
 *
 * The status is there to be seen, so it never goes above the top of what is
 * visible and readable either, whether the keyboard is open or not: a large
 * `bottom` raised by the keyboard would otherwise put it off the screen. That
 * top is the visual viewport's top, lowered by the safe area's top inset: the
 * WebView reaches under the system's status bar, and Obsidian publishes the
 * inset as `--safe-area-inset-top` on the root element (0 where it does not).
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
        const wanted = Math.max(
            m.bottom + this.keyboard.height(),
            toolbar > 0 ? toolbar + EDGE_GAP : 0,
        );
        const bottom = Math.min(wanted, this.highestBottom());
        this.el.style.bottom = `${bottom}px`;
        this.el.style.left = m.align === "left" ? `${m.offset}px` : "";
        this.el.style.right = m.align === "right" ? `${m.offset}px` : "";
    }

    /** The largest `bottom` that keeps the whole status below the visible top. */
    private highestBottom(): number {
        const visibleTop = Math.max(0, this.win.visualViewport?.offsetTop ?? 0) + this.safeAreaTop();
        const height = this.el.getBoundingClientRect().height;
        return Math.max(0, Math.floor(this.win.innerHeight - visibleTop - EDGE_GAP - height));
    }

    /** CSS px the system's status bar covers at the top; 0 when it is not told. */
    private safeAreaTop(): number {
        const root = this.win.document.documentElement;
        const raw = this.win.getComputedStyle(root).getPropertyValue("--safe-area-inset-top");
        const px = parseFloat(raw);
        return Number.isFinite(px) && px > 0 ? px : 0;
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
