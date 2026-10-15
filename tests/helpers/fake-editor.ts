/**
 * Fake Markdown panes for EditorAwareVaultWriter: just enough of
 * `App.workspace`, `MarkdownView` and the CM6 EditorView for the writer to
 * find the panes on a path, read their text, see an IME composition, and
 * replace their text.
 */

import { vi } from "vitest";
import type { CMLike } from "../../src/adapters/editor-aware-vault-writer.ts";

export class FakeDoc {
    constructor(private text: string) {}
    get length(): number { return this.text.length; }
    toString(): string { return this.text; }
}

export class FakeCM implements CMLike {
    composing = false;
    state: { doc: FakeDoc };
    dispatchSpy: ReturnType<typeof vi.fn>;

    constructor(initial: string) {
        this.state = { doc: new FakeDoc(initial) };
        this.dispatchSpy = vi.fn((spec: { changes: { from: number; to: number; insert: string } }) => {
            const { from, to, insert } = spec.changes;
            const cur = this.state.doc.toString();
            this.state = { doc: new FakeDoc(cur.slice(0, from) + insert + cur.slice(to)) };
        });
    }

    dispatch(spec: { changes: { from: number; to: number; insert: string } }): void {
        this.dispatchSpy(spec);
    }

    /** The user types (or commits an IME composition): the pane's text
     *  changes without reaching the disk. */
    type(text: string): void {
        this.state = { doc: new FakeDoc(text) };
    }

    text(): string {
        return this.state.doc.toString();
    }
}

export interface FakeLeaf {
    view: { file: { path: string }; editor: { cm: FakeCM } };
    detach: ReturnType<typeof vi.fn>;
}

export function makeLeaf(path: string, initial: string): FakeLeaf {
    return {
        view: { file: { path }, editor: { cm: new FakeCM(initial) } },
        detach: vi.fn(),
    };
}

/** An App whose Markdown panes are `leaves`; the array may be changed
 *  later to open or close panes. */
export function makeFakeApp(leaves: FakeLeaf[]): import("obsidian").App {
    return {
        workspace: { getLeavesOfType: (_t: string) => leaves },
    } as unknown as import("obsidian").App;
}
