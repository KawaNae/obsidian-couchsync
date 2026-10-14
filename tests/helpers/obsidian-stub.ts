/**
 * Minimal runtime stub for the `obsidian` package in the test env.
 *
 * The real `obsidian` npm package ships only .d.ts — the runtime API
 * exists inside the Obsidian app. Tests that transitively import code
 * which references `Notice`, etc. need a no-op implementation so the
 * module graph resolves. Dialogs get just enough of `Modal` and `Setting`
 * to be opened and inspected.
 */

export class Notice {
    constructor(_message: string, _timeout?: number) {}
    setMessage(_message: string): this { return this; }
    hide(): void {}
}

// ── Dialogs ────────────────────────────────────────────────────────────
//
// A tree of fake elements, enough for a modal's onOpen to build its content
// and for a test to look at the buttons and the focus. Not a DOM.

class FakeDocument {
    activeElement: FakeElement | null = null;
}

type ElOpts = string | { text?: string; cls?: string };

export class FakeElement {
    children: FakeElement[] = [];
    classes = new Set<string>();
    style: Record<string, string> = {};
    text = "";
    type = "";
    value = "";
    placeholder = "";
    disabled = false;
    onclick: (() => void) | null = null;

    constructor(readonly tagName: string, readonly ownerDocument: FakeDocument) {}

    createEl(tag: string, opts: ElOpts = {}): FakeElement {
        const el = new FakeElement(tag.toUpperCase(), this.ownerDocument);
        const o = typeof opts === "string" ? { cls: opts } : opts;
        if (o.text !== undefined) el.text = o.text;
        if (o.cls) el.classes.add(o.cls);
        this.children.push(el);
        return el;
    }
    createDiv(opts: ElOpts = {}): FakeElement { return this.createEl("div", opts); }
    createSpan(opts: ElOpts = {}): FakeElement { return this.createEl("span", opts); }
    empty(): void { this.children = []; }
    addClass(cls: string): void { this.classes.add(cls); }
    removeClass(cls: string): void { this.classes.delete(cls); }
    toggleClass(cls: string, on: boolean): void { if (on) this.addClass(cls); else this.removeClass(cls); }
    focus(): void { this.ownerDocument.activeElement = this; }
    contains(el: FakeElement | null): boolean {
        return el === this || this.children.some((c) => c.contains(el));
    }
    /** Depth-first, in document order. */
    *walk(): Generator<FakeElement> {
        yield this;
        for (const c of this.children) yield* c.walk();
    }
}

export class Modal {
    modalEl: FakeElement;
    contentEl: FakeElement;
    /** Obsidian focuses the dialog's first focusable element on open only
     *  when the device has a physical keyboard; false stands for a device
     *  without one. */
    hasInitialInputFocus = true;

    constructor(readonly app: unknown) {
        this.modalEl = new FakeElement("DIV", new FakeDocument());
        this.contentEl = this.modalEl.createDiv("modal-content");
    }

    open(): void {
        this.onOpen();
        if (!this.hasInitialInputFocus) return;
        for (const el of this.modalEl.walk()) {
            if ((el.tagName === "BUTTON" || el.tagName === "INPUT") && !el.disabled) {
                el.focus();
                return;
            }
        }
    }
    close(): void { this.onClose(); }
    onOpen(): void {}
    onClose(): void {}
}

export class ButtonComponent {
    buttonEl: FakeElement;
    constructor(containerEl: FakeElement) { this.buttonEl = containerEl.createEl("button"); }
    setButtonText(text: string): this { this.buttonEl.text = text; return this; }
    setCta(): this { this.buttonEl.addClass("mod-cta"); return this; }
    setWarning(): this { this.buttonEl.addClass("mod-warning"); return this; }
    setDisabled(disabled: boolean): this { this.buttonEl.disabled = disabled; return this; }
    onClick(fn: () => void): this { this.buttonEl.onclick = fn; return this; }
}

export class TextComponent {
    inputEl: FakeElement;
    constructor(containerEl: FakeElement) {
        this.inputEl = containerEl.createEl("input");
        this.inputEl.type = "text";
    }
    setPlaceholder(text: string): this { this.inputEl.placeholder = text; return this; }
    onChange(_fn: (value: string) => void): this { return this; }
}

export class Setting {
    settingEl: FakeElement;
    controlEl: FakeElement;
    constructor(containerEl: FakeElement) {
        this.settingEl = containerEl.createDiv("setting-item");
        this.controlEl = this.settingEl.createDiv("setting-item-control");
    }
    setName(_name: string): this { return this; }
    setDesc(_desc: string): this { return this; }
    addButton(cb: (btn: ButtonComponent) => void): this { cb(new ButtonComponent(this.controlEl)); return this; }
    addText(cb: (text: TextComponent) => void): this { cb(new TextComponent(this.controlEl)); return this; }
}
