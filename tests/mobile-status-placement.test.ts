import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MobileStatusPlacement } from "../src/ui/mobile-status-placement.ts";
import type { MobileStatusPosition } from "../src/settings.ts";

/**
 * A window as Obsidian mobile shows it: the keyboard does not resize it
 * (innerHeight and visualViewport stay put), Capacitor's events tell of
 * the keyboard, and the editing toolbar is an element found by class.
 */
class FakeViewport extends EventTarget {
    height: number;
    offsetTop = 0;
    constructor(height: number) {
        super();
        this.height = height;
    }
}

class FakeWindow extends EventTarget {
    innerHeight = 900;
    visualViewport = new FakeViewport(900);
    toolbarTop: number | null = null;
    safeAreaTop = "";
    getComputedStyle = () => ({
        getPropertyValue: (name: string) => (name === "--safe-area-inset-top" ? this.safeAreaTop : ""),
    });
    document = {
        body: {},
        documentElement: {},
        querySelector: (sel: string) => {
            if (sel !== ".mobile-toolbar" || this.toolbarTop === null) return null;
            const top = this.toolbarTop;
            return { getBoundingClientRect: () => ({ top, height: 44 }) };
        },
    };
    listenerCount = 0;
    addEventListener(...args: Parameters<EventTarget["addEventListener"]>): void {
        this.listenerCount++;
        super.addEventListener(...args);
    }
    removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>): void {
        this.listenerCount--;
        super.removeEventListener(...args);
    }
}

class FakeObserver {
    static live = new Set<FakeObserver>();
    constructor(readonly callback: () => void) {}
    observe(): void { FakeObserver.live.add(this); }
    disconnect(): void { FakeObserver.live.delete(this); }
}

function keyboardEvent(name: string, keyboardHeight?: number): Event {
    const e = new Event(name);
    if (keyboardHeight !== undefined) Object.assign(e, { keyboardHeight });
    return e;
}

describe("MobileStatusPlacement", () => {
    let win: FakeWindow;
    let el: { style: Record<string, string>; getBoundingClientRect: () => { height: number } };
    let position: MobileStatusPosition;
    let placement: MobileStatusPlacement;

    beforeEach(() => {
        vi.stubGlobal("MutationObserver", FakeObserver);
        FakeObserver.live.clear();
        win = new FakeWindow();
        el = { style: {}, getBoundingClientRect: () => ({ height: 18 }) };
        position = { align: "left", bottom: 50, offset: 8 };
        placement = new MobileStatusPlacement(
            el as unknown as HTMLElement,
            win as unknown as Window,
            () => position,
        );
        placement.start();
    });

    afterEach(() => {
        placement.stop();
        vi.unstubAllGlobals();
    });

    it("places the status at the settings' bottom while the keyboard is closed", () => {
        expect(el.style.bottom).toBe("50px");
        expect(el.style.left).toBe("8px");
    });

    it("raises the status by the keyboard's height when the keyboard opens, and lowers it back on close", () => {
        win.dispatchEvent(keyboardEvent("keyboardWillShow", 336));
        expect(el.style.bottom).toBe("386px");

        win.dispatchEvent(keyboardEvent("keyboardDidHide", 0));
        expect(el.style.bottom).toBe("50px");
    });

    it("follows a keyboard that shrinks the visual viewport", () => {
        win.visualViewport.height = 600;
        win.visualViewport.dispatchEvent(new Event("resize"));
        expect(el.style.bottom).toBe("350px");

        win.visualViewport.height = 900;
        win.visualViewport.dispatchEvent(new Event("resize"));
        expect(el.style.bottom).toBe("50px");
    });

    it("keeps the status above the editing toolbar once the toolbar opens", () => {
        win.dispatchEvent(keyboardEvent("keyboardWillShow", 336));
        // The toolbar sits 52px above the keyboard's top: its top is 388px
        // above the window's bottom, higher than 50 + 336.
        win.toolbarTop = 900 - 388;
        for (const o of FakeObserver.live) o.callback();
        expect(el.style.bottom).toBe("392px");
    });

    it("leaves the settings' bottom when it already clears the toolbar", () => {
        position = { ...position, bottom: 80 };
        win.toolbarTop = 900 - 388;
        win.dispatchEvent(keyboardEvent("keyboardDidShow", 336));
        expect(el.style.bottom).toBe("416px");
    });

    it("keeps the status inside the screen's top when the settings' bottom and the keyboard reach past it", () => {
        position = { ...position, bottom: 600 };
        placement.apply();
        expect(el.style.bottom).toBe("600px");

        // 600 + 336 would put the status 54px above the screen; it stops
        // 4px below the top: 900 - 4 - 18.
        win.dispatchEvent(keyboardEvent("keyboardWillShow", 336));
        expect(el.style.bottom).toBe("878px");

        win.dispatchEvent(keyboardEvent("keyboardDidHide", 0));
        expect(el.style.bottom).toBe("600px");
    });

    it("keeps the status below the visual viewport's top when that is scrolled down", () => {
        position = { ...position, bottom: 600 };
        win.visualViewport.offsetTop = 100;
        win.visualViewport.height = 500;
        win.visualViewport.dispatchEvent(new Event("resize"));
        // 900 - 100 - 4 - 18
        expect(el.style.bottom).toBe("778px");
    });

    it("keeps the status below the system's status bar, as the safe area's top inset tells", () => {
        position = { ...position, bottom: 600 };
        win.safeAreaTop = "51.8px";
        win.dispatchEvent(keyboardEvent("keyboardWillShow", 336));
        // floor(900 - 51.8 - 4 - 18)
        expect(el.style.bottom).toBe("826px");
    });

    it("stops following the keyboard and the toolbar on stop", () => {
        expect(win.listenerCount).toBe(4);
        expect(FakeObserver.live.size).toBe(1);

        placement.stop();
        expect(win.listenerCount).toBe(0);
        expect(FakeObserver.live.size).toBe(0);

        win.dispatchEvent(keyboardEvent("keyboardWillShow", 336));
        win.visualViewport.height = 600;
        win.visualViewport.dispatchEvent(new Event("resize"));
        expect(el.style.bottom).toBe("50px");
    });
});
