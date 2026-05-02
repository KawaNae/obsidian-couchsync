import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FilesystemVaultWriter } from "../src/sync/vault-writer.ts";
import { FakeVaultIO } from "./helpers/fake-vault-io.ts";

describe("FilesystemVaultWriter", () => {
    let io: FakeVaultIO;
    let writer: FilesystemVaultWriter;

    beforeEach(() => {
        io = new FakeVaultIO();
        writer = new FilesystemVaultWriter(io);
    });

    describe("applyRemoteContent", () => {
        it("writes through to IVaultIO and reports applied", async () => {
            io.addFile("a.md", "old");
            const result = await writer.applyRemoteContent(
                "a.md",
                new TextEncoder().encode("new").buffer,
            );
            expect(result).toEqual({ applied: true });
            expect(io.readText("a.md")).toBe("new");
        });

        it("propagates IO errors", async () => {
            // FakeVaultIO.writeBinary throws when file does not exist.
            await expect(
                writer.applyRemoteContent("missing.md", new ArrayBuffer(0)),
            ).rejects.toThrow(/File not found/);
        });
    });

    describe("applyRemoteDeletion", () => {
        it("deletes existing file", async () => {
            io.addFile("a.md", "x");
            await writer.applyRemoteDeletion("a.md");
            expect(await io.exists("a.md")).toBe(false);
        });

        it("is a no-op on missing file", async () => {
            await writer.applyRemoteDeletion("missing.md");
            // No throw. Map unchanged.
            expect(io.files.size).toBe(0);
        });
    });

    describe("createFile", () => {
        it("creates new file via IVaultIO", async () => {
            await writer.createFile("new.md", new TextEncoder().encode("hello").buffer);
            expect(io.readText("new.md")).toBe("hello");
        });
    });

    describe("flushAll", () => {
        it("is a no-op (no deferred state)", () => {
            writer.flushAll();
            // No assertion target — absence of throw is the check.
        });
    });
});

// ── EditorAwareVaultWriter ─────────────────────────────────

import { EditorAwareVaultWriter, type CMLike } from "../src/adapters/editor-aware-vault-writer.ts";
import { CompositionGate } from "../src/sync/composition-gate.ts";
import { FakeCompositionTracker } from "./helpers/fake-composition-tracker.ts";

interface FakeView {
    file: { path: string };
    editor: { cm: FakeCM };
}

interface FakeLeaf {
    view: FakeView;
    detach: ReturnType<typeof vi.fn>;
}

class FakeCM implements CMLike {
    composing = false;
    state: { doc: FakeDoc };
    dispatchSpy: ReturnType<typeof vi.fn>;

    constructor(initial: string) {
        this.state = { doc: new FakeDoc(initial) };
        this.dispatchSpy = vi.fn((spec: { changes: { from: number; to: number; insert: string } }) => {
            const { from, to, insert } = spec.changes;
            const cur = this.state.doc.toString();
            const next = cur.slice(0, from) + insert + cur.slice(to);
            this.state = { doc: new FakeDoc(next) };
        });
    }

    dispatch(spec: { changes: { from: number; to: number; insert: string } }): void {
        this.dispatchSpy(spec);
    }
}

class FakeDoc {
    constructor(private text: string) {}
    get length(): number { return this.text.length; }
    toString(): string { return this.text; }
}

function makeFakeApp(leaves: FakeLeaf[]) {
    return {
        workspace: {
            getLeavesOfType: (_t: string) => leaves,
        },
    } as unknown as import("obsidian").App;
}

function makeLeaf(path: string, initial: string): FakeLeaf {
    return {
        view: {
            file: { path },
            editor: { cm: new FakeCM(initial) },
        },
        detach: vi.fn(),
    };
}

describe("EditorAwareVaultWriter", () => {
    let io: FakeVaultIO;
    let tracker: FakeCompositionTracker;
    let gate: CompositionGate;

    beforeEach(() => {
        vi.useFakeTimers();
        io = new FakeVaultIO();
        tracker = new FakeCompositionTracker();
        gate = new CompositionGate(tracker, { timeoutMs: 30_000 });
        gate.start();
    });

    afterEach(() => {
        gate.stop();
        vi.useRealTimers();
    });

    function makeWriter(leaves: FakeLeaf[], opts: { writeIgnore?: any; historyCapture?: any } = {}) {
        const app = makeFakeApp(leaves);
        return new EditorAwareVaultWriter(
            app,
            io,
            gate,
            opts.writeIgnore ?? null,
            opts.historyCapture ?? null,
        );
    }

    // ── No-editor fallback ────────────────────────────────

    it("falls back to IVaultIO when no editor has the file open", async () => {
        io.addFile("a.md", "old");
        const writer = makeWriter([]);
        const result = await writer.applyRemoteContent(
            "a.md",
            new TextEncoder().encode("new").buffer,
        );
        expect(result).toEqual({ applied: true });
        expect(io.readText("a.md")).toBe("new");
    });

    it("captures history for fallback writes", async () => {
        io.addFile("a.md", "old");
        const captureSyncWrite = vi.fn(async () => {});
        const writer = makeWriter([], { historyCapture: { captureSyncWrite } });
        await writer.applyRemoteContent(
            "a.md",
            new TextEncoder().encode("new").buffer,
        );
        expect(captureSyncWrite).toHaveBeenCalledWith("a.md", "new");
    });

    // ── Single editor, not composing ──────────────────────

    it("dispatches CM transaction when single pane is not composing", async () => {
        const leaf = makeLeaf("a.md", "old");
        const writer = makeWriter([leaf]);
        const result = await writer.applyRemoteContent(
            "a.md",
            new TextEncoder().encode("new").buffer,
        );
        expect(result).toEqual({ applied: true });
        expect(leaf.view.editor.cm.dispatchSpy).toHaveBeenCalledTimes(1);
        expect(leaf.view.editor.cm.state.doc.toString()).toBe("new");
        // No fallback to IVaultIO.
        expect(io.files.size).toBe(0);
    });

    // ── Multi-pane, none composing ────────────────────────

    it("dispatches on every pane simultaneously", async () => {
        const a = makeLeaf("file.md", "old");
        const b = makeLeaf("file.md", "old");
        const writer = makeWriter([a, b]);
        await writer.applyRemoteContent(
            "file.md",
            new TextEncoder().encode("new").buffer,
        );
        expect(a.view.editor.cm.dispatchSpy).toHaveBeenCalledTimes(1);
        expect(b.view.editor.cm.dispatchSpy).toHaveBeenCalledTimes(1);
        expect(a.view.editor.cm.state.doc.toString()).toBe("new");
        expect(b.view.editor.cm.state.doc.toString()).toBe("new");
    });

    // ── Composing — defer ────────────────────────────────

    it("defers dispatch while editor is composing", async () => {
        const leaf = makeLeaf("a.md", "old");
        leaf.view.editor.cm.composing = true;
        tracker.startComposition("a.md");
        const writer = makeWriter([leaf]);

        const promise = writer.applyRemoteContent(
            "a.md",
            new TextEncoder().encode("new").buffer,
        );
        await Promise.resolve();
        expect(leaf.view.editor.cm.dispatchSpy).not.toHaveBeenCalled();

        // End composition → drain → dispatch
        leaf.view.editor.cm.composing = false;
        tracker.endComposition("a.md");
        const result = await promise;
        expect(result).toEqual({ applied: true });
        expect(leaf.view.editor.cm.state.doc.toString()).toBe("new");
    });

    it("skips dispatch when local doc diverges during composition", async () => {
        const leaf = makeLeaf("a.md", "old");
        leaf.view.editor.cm.composing = true;
        tracker.startComposition("a.md");
        const writer = makeWriter([leaf]);

        const promise = writer.applyRemoteContent(
            "a.md",
            new TextEncoder().encode("new").buffer,
        );

        // Simulate user committing IME text — doc changes underneath us.
        leaf.view.editor.cm.state = { doc: new FakeDoc("old + user typed") };
        leaf.view.editor.cm.composing = false;
        tracker.endComposition("a.md");
        const result = await promise;

        expect(result).toEqual({
            applied: false,
            reason: "local-changed-during-composition",
        });
        expect(leaf.view.editor.cm.dispatchSpy).not.toHaveBeenCalled();
    });

    it("falls back to disk write when all editors close during defer", async () => {
        io.addFile("a.md", "old");
        const leaf = makeLeaf("a.md", "old");
        leaf.view.editor.cm.composing = true;
        tracker.startComposition("a.md");

        // Use a leaves array we can mutate to simulate close.
        const leaves = [leaf];
        const writer = new EditorAwareVaultWriter(
            { workspace: { getLeavesOfType: () => leaves } } as unknown as import("obsidian").App,
            io,
            gate,
            null,
            null,
        );

        const promise = writer.applyRemoteContent(
            "a.md",
            new TextEncoder().encode("fallback").buffer,
        );

        leaves.length = 0;  // close all panes
        leaf.view.editor.cm.composing = false;
        tracker.endComposition("a.md");

        const result = await promise;
        expect(result).toEqual({ applied: true });
        expect(io.readText("a.md")).toBe("fallback");
    });

    // ── Deletion ──────────────────────────────────────────

    it("detaches open leaves before deletion", async () => {
        io.addFile("a.md", "x");
        const ignoreDelete = vi.fn();
        const leaf = makeLeaf("a.md", "x");
        const writer = makeWriter([leaf], {
            writeIgnore: { ignoreDelete },
        });

        await writer.applyRemoteDeletion("a.md");

        expect(leaf.detach).toHaveBeenCalled();
        expect(ignoreDelete).toHaveBeenCalledWith("a.md");
        expect(await io.exists("a.md")).toBe(false);
    });

    it("applyRemoteDeletion is a no-op when file already gone", async () => {
        const writer = makeWriter([]);
        await writer.applyRemoteDeletion("missing.md");
        expect(io.files.size).toBe(0);
    });

    // ── createFile ────────────────────────────────────────

    it("createFile writes via IVaultIO", async () => {
        const captureSyncWrite = vi.fn(async () => {});
        const writer = makeWriter([], { historyCapture: { captureSyncWrite } });
        await writer.createFile("new.md", new TextEncoder().encode("hello").buffer);
        expect(io.readText("new.md")).toBe("hello");
        expect(captureSyncWrite).toHaveBeenCalledWith("new.md", "hello");
    });

    // ── flushAll ──────────────────────────────────────────

    it("flushAll rejects pending deferred ops", async () => {
        const leaf = makeLeaf("a.md", "old");
        leaf.view.editor.cm.composing = true;
        tracker.startComposition("a.md");
        const writer = makeWriter([leaf]);

        const promise = writer.applyRemoteContent(
            "a.md",
            new TextEncoder().encode("new").buffer,
        );

        writer.flushAll();
        await expect(promise).rejects.toThrow(/CompositionGate flushed/);
    });
});
