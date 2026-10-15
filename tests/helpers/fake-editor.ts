/**
 * Fake Markdown panes for EditorAwareVaultWriter: just enough of
 * `App.workspace`, `MarkdownView` and the CM6 EditorView for the writer to
 * find the panes on a path, read what they would save, and see an IME
 * composition.
 *
 * With `reloadOnModify`, a pane also behaves as Obsidian's text file view
 * does around the disk: a change to the editor's text (typing, or a
 * transaction dispatched by a plugin) marks the pane unsaved and saves it
 * two seconds later; a modify event reloads the pane from the disk, and a
 * pane with unsaved text that differs from both the old and the new disk
 * text gets a three-way merge (diff-match-patch) of its change into the new
 * text. CodeMirror holds line breaks as LF, and the disk text is read
 * without a BOM, as Obsidian reads it.
 */

import { vi, type Mock } from "vitest";
import DiffMatchPatch from "diff-match-patch";
import type { FakeVaultIO } from "./fake-vault-io.ts";
import type { FakeVaultEvents } from "./fake-vault-events.ts";

type TransactionSpec = { changes: { from: number; to: number; insert: string } };

export class FakeDoc {
    constructor(private text: string) {}
    get length(): number { return this.text.length; }
    toString(): string { return this.text; }
}

/** CodeMirror keeps line breaks as LF whatever it is given. */
function toEditorText(text: string): string {
    return text.replace(/\r\n?/g, "\n");
}

export class FakeCM {
    composing = false;
    state: { doc: FakeDoc };
    dispatchSpy: Mock<(spec: TransactionSpec) => void>;
    /** Called on a change that is not Obsidian loading the file. */
    onUserChange: () => void = () => {};

    constructor(initial: string) {
        this.state = { doc: new FakeDoc(toEditorText(initial)) };
        this.dispatchSpy = vi.fn((spec: TransactionSpec) => {
            const { from, to, insert } = spec.changes;
            const cur = this.state.doc.toString();
            this.state = { doc: new FakeDoc(toEditorText(cur.slice(0, from) + insert + cur.slice(to))) };
            this.onUserChange();
        });
    }

    dispatch(spec: TransactionSpec): void {
        this.dispatchSpy(spec);
    }

    /** The user types (or commits an IME composition): the pane's text
     *  changes without reaching the disk. */
    type(text: string): void {
        this.state = { doc: new FakeDoc(toEditorText(text)) };
        this.onUserChange();
    }

    /** Obsidian sets the editor's text from the file: not a change to save. */
    load(text: string): void {
        this.state = { doc: new FakeDoc(toEditorText(text)) };
    }

    text(): string {
        return this.state.doc.toString();
    }
}

export class FakeMarkdownView {
    readonly file: { path: string };
    readonly editor: { cm: FakeCM };
    mode: "source" | "preview" = "source";
    dirty = false;
    /** The disk text this view last read or saved. */
    lastSavedData: string;
    /** Times the view merged unsaved text into a changed file. */
    merges = 0;
    /** Obsidian saves this long after the last change to the editor. */
    saveDelayMs = 2000;
    private data: string;
    private previewText: string;
    private saving = false;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    io: FakeVaultIO | null = null;

    constructor(path: string, initial: string, disk: string = initial) {
        this.file = { path };
        this.editor = { cm: new FakeCM(initial) };
        this.editor.cm.onUserChange = () => this.requestSave();
        this.lastSavedData = disk;
        this.data = disk;
        this.previewText = initial;
    }

    getViewData(): string {
        return this.mode === "source" ? this.editor.cm.text() : this.previewText;
    }

    /** Switching modes hands the view's data to the mode shown next. */
    setMode(mode: "source" | "preview"): void {
        if (mode === this.mode) return;
        this.mode = mode;
        this.setViewData(this.data);
    }

    private setViewData(text: string): void {
        if (this.mode === "source") this.editor.cm.load(text);
        else this.previewText = text;
    }

    private requestSave(): void {
        this.dirty = true;
        if (!this.io) return;
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            void this.save();
        }, this.saveDelayMs);
    }

    private async save(): Promise<void> {
        this.dirty = false;
        const text = this.getViewData();
        if (!this.io || this.lastSavedData === text) return;
        this.data = text;
        this.lastSavedData = text;
        this.saving = true;
        try {
            await this.io.writeBinary(this.file.path, new TextEncoder().encode(text).buffer);
        } finally {
            this.saving = false;
        }
    }

    /** Obsidian's reload of the file on a modify event. */
    async onModify(): Promise<void> {
        if (this.saving || !this.io) return;
        let next = new TextDecoder().decode(await this.io.readBinary(this.file.path));
        const prev = this.lastSavedData;
        this.lastSavedData = next;
        if (prev === next) return;
        if (this.dirty) {
            const shown = this.getViewData();
            if (shown === next) return;
            if (shown !== prev) {
                const dmp = new DiffMatchPatch();
                next = dmp.patch_apply(dmp.patch_make(prev, shown), next)[0];
                this.merges++;
            }
        }
        if (this.data !== next) {
            this.data = next;
            this.setViewData(next);
        }
    }
}

export interface FakeLeaf {
    view: FakeMarkdownView;
    detach: ReturnType<typeof vi.fn>;
}

/** A pane showing `initial` on `path`; `disk` is the file's text as
 *  Obsidian read it, when it differs (CRLF line breaks). */
export function makeLeaf(path: string, initial: string, disk?: string): FakeLeaf {
    return { view: new FakeMarkdownView(path, initial, disk), detach: vi.fn() };
}

/** An App whose Markdown panes are `leaves`; the array may be changed
 *  later to open or close panes. */
export function makeFakeApp(leaves: FakeLeaf[]): import("obsidian").App {
    return {
        workspace: { getLeavesOfType: (_t: string) => leaves },
    } as unknown as import("obsidian").App;
}

/**
 * Make `io` notify as Obsidian's vault does: each write fires `modify`
 * before it returns, to `events` (when given) and to the panes in
 * `leaves` showing the path, which reload and save through `io`.
 */
export function reloadOnModify(io: FakeVaultIO, leaves: FakeLeaf[], events?: FakeVaultEvents): void {
    const write = io.writeBinary.bind(io);
    io.writeBinary = async (path, data) => {
        await write(path, data);
        const stat = await io.stat(path);
        for (const leaf of leaves) {
            if (leaf.view.file.path === path) void leaf.view.onModify();
        }
        if (events && stat) events.emit("modify", path, stat);
    };
    const attach = () => { for (const leaf of leaves) leaf.view.io = io; };
    attach();
    const push = leaves.push.bind(leaves);
    leaves.push = (...items: FakeLeaf[]) => {
        const n = push(...items);
        attach();
        return n;
    };
}
