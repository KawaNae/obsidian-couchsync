const SHOW_EVENTS = ["keyboardWillShow", "keyboardDidShow"] as const;
const HIDE_EVENTS = ["keyboardWillHide", "keyboardDidHide"] as const;

/**
 * How much of a window's bottom the on-screen keyboard covers, with a call
 * back whenever that may have changed.
 *
 * Two sources tell of the keyboard, and the height is the larger cover:
 * - Obsidian mobile (Android, iOS) runs in a WebView that the keyboard
 *   does not resize: `innerHeight` and `visualViewport` keep their size.
 *   Only Capacitor's Keyboard events on the window tell of it
 *   (`keyboardWillShow` / `keyboardDidShow` carry `keyboardHeight` in CSS
 *   px, `keyboardWillHide` / `keyboardDidHide` follow its closing).
 * - Elsewhere (a browser, Safari) the keyboard shrinks `visualViewport`,
 *   and its cover is what the visual viewport leaves below it.
 *
 * One instance listens to one window; `stop` removes every listener.
 */
export class VirtualKeyboard {
    private nativeHeight = 0;
    private listening = false;

    private readonly onShow = (e: Event): void => {
        const h = (e as Event & { keyboardHeight?: unknown }).keyboardHeight;
        if (typeof h === "number" && h > 0) this.nativeHeight = h;
        this.onChange();
    };

    private readonly onHide = (): void => {
        this.nativeHeight = 0;
        this.onChange();
    };

    private readonly onViewport = (): void => this.onChange();

    constructor(
        private readonly win: Window,
        private readonly onChange: () => void,
    ) {}

    start(): void {
        if (this.listening) return;
        this.listening = true;
        for (const name of SHOW_EVENTS) this.win.addEventListener(name, this.onShow);
        for (const name of HIDE_EVENTS) this.win.addEventListener(name, this.onHide);
        const vv = this.win.visualViewport;
        vv?.addEventListener("resize", this.onViewport);
        vv?.addEventListener("scroll", this.onViewport);
    }

    stop(): void {
        if (!this.listening) return;
        this.listening = false;
        for (const name of SHOW_EVENTS) this.win.removeEventListener(name, this.onShow);
        for (const name of HIDE_EVENTS) this.win.removeEventListener(name, this.onHide);
        const vv = this.win.visualViewport;
        vv?.removeEventListener("resize", this.onViewport);
        vv?.removeEventListener("scroll", this.onViewport);
        this.nativeHeight = 0;
    }

    /** CSS px the keyboard covers from the window's bottom; 0 when it is closed. */
    height(): number {
        const vv = this.win.visualViewport;
        const viewportCover = vv ? this.win.innerHeight - (vv.offsetTop + vv.height) : 0;
        return Math.max(0, this.nativeHeight, Math.round(viewportCover));
    }
}
