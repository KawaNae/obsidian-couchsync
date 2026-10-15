import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
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
            expect(await writer.applyRemoteDeletion("missing.md")).toEqual({ applied: true });
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

import { EditorAwareVaultWriter } from "../src/adapters/editor-aware-vault-writer.ts";
import { CompositionGate } from "../src/sync/composition-gate.ts";
import { UNSAVED_EDITOR_CHANGE, UNSYNCED_VAULT_CHANGE } from "../src/sync/vault-writer.ts";
import { FakeCompositionTracker } from "./helpers/fake-composition-tracker.ts";
import { makeFakeApp, makeLeaf, reloadOnModify, type FakeLeaf } from "./helpers/fake-editor.ts";

const bytes = (text: string) => new TextEncoder().encode(text).buffer;

describe("EditorAwareVaultWriter", () => {
    let io: FakeVaultIO;
    let tracker: FakeCompositionTracker;
    let gate: CompositionGate;
    let writeIgnore: {
        ignoreDelete: Mock<(path: string) => void>;
        ignoreModifyTo: Mock<(path: string, content: ArrayBuffer) => void>;
    };

    beforeEach(() => {
        vi.useFakeTimers();
        io = new FakeVaultIO();
        tracker = new FakeCompositionTracker();
        gate = new CompositionGate(tracker, { timeoutMs: 30_000 });
        gate.start();
        writeIgnore = { ignoreDelete: vi.fn(), ignoreModifyTo: vi.fn() };
    });

    afterEach(() => {
        gate.stop();
        vi.useRealTimers();
    });

    function makeWriter(leaves: FakeLeaf[], opts: { historyCapture?: any } = {}) {
        return new EditorAwareVaultWriter(
            makeFakeApp(leaves), io, gate, writeIgnore, opts.historyCapture ?? null,
        );
    }

    /** Start an IME composition in `leaf` with its text unchanged. */
    function compose(leaf: FakeLeaf): void {
        leaf.view.editor.cm.composing = true;
        tracker.startComposition(leaf.view.file.path);
    }

    function endComposition(leaf: FakeLeaf): void {
        leaf.view.editor.cm.composing = false;
        tracker.endComposition(leaf.view.file.path);
    }

    // ── No editor ─────────────────────────────────────────

    it("writes the disk when no editor has the file open", async () => {
        io.addFile("a.md", "old");
        const writer = makeWriter([]);
        const content = bytes("new");
        expect(await writer.applyRemoteContent("a.md", content)).toEqual({ applied: true });
        expect(io.readText("a.md")).toBe("new");
        expect(writeIgnore.ignoreModifyTo).toHaveBeenCalledWith("a.md", content);
    });

    it("marks the written bytes before the modify event the write causes", async () => {
        io.addFile("a.md", "old");
        const writer = makeWriter([]);
        const marked: number[] = [];
        const write = io.writeBinary.bind(io);
        io.writeBinary = async (p, d) => {
            marked.push(writeIgnore.ignoreModifyTo.mock.calls.length);
            await write(p, d);
        };
        await writer.applyRemoteContent("a.md", bytes("new"));
        expect(marked).toEqual([1]);
    });

    it("captures history for writes", async () => {
        io.addFile("a.md", "old");
        const captureSyncWrite = vi.fn(async () => {});
        const writer = makeWriter([], { historyCapture: { captureSyncWrite } });
        await writer.applyRemoteContent("a.md", bytes("new"));
        expect(captureSyncWrite).toHaveBeenCalledWith("a.md", "new");
    });

    // ── Panes that hold what the disk holds ───────────────

    it("writes the disk and leaves the pane's text to Obsidian's reload", async () => {
        io.addFile("a.md", "old");
        const leaf = makeLeaf("a.md", "old");
        const writer = makeWriter([leaf]);
        expect(await writer.applyRemoteContent("a.md", bytes("new"))).toEqual({ applied: true });
        expect(io.readText("a.md")).toBe("new");
        expect(leaf.view.editor.cm.dispatchSpy).not.toHaveBeenCalled();
        expect(leaf.view.editor.cm.text()).toBe("old");
        expect(leaf.view.dirty).toBe(false);
    });

    it("writes the disk once for several panes on the path", async () => {
        io.addFile("file.md", "old");
        const a = makeLeaf("file.md", "old");
        const b = makeLeaf("file.md", "old");
        const other = makeLeaf("other.md", "x");
        const writer = makeWriter([a, b, other]);
        const writes: string[] = [];
        const write = io.writeBinary.bind(io);
        io.writeBinary = async (p, d) => { writes.push(p); await write(p, d); };
        await writer.applyRemoteContent("file.md", bytes("new"));
        expect(writes).toEqual(["file.md"]);
        for (const leaf of [a, b, other]) {
            expect(leaf.view.editor.cm.dispatchSpy).not.toHaveBeenCalled();
        }
    });

    it("treats CRLF and a BOM on disk as the pane's LF text", async () => {
        io.addFile("a.md", "﻿line 1\r\nline 2\r\n");
        const leaf = makeLeaf("a.md", "line 1\nline 2\n");
        const writer = makeWriter([leaf]);
        expect(await writer.applyRemoteContent("a.md", bytes("new\r\n"))).toEqual({ applied: true });
        expect(io.readText("a.md")).toBe("new\r\n");
    });

    it("compares what a pane in reading view shows, not its hidden editor", async () => {
        // Obsidian reloads only the mode on screen; the hidden editor gets
        // the text when the user switches back to it.
        io.addFile("a.md", "v1");
        const leaf = makeLeaf("a.md", "v1");
        leaf.view.mode = "preview";
        leaf.view.editor.cm.load("v0");
        const writer = makeWriter([leaf]);
        expect(await writer.applyRemoteContent("a.md", bytes("v2"))).toEqual({ applied: true });
        expect(io.readText("a.md")).toBe("v2");
    });

    // ── Obsidian's reload ─────────────────────────────────

    describe("with Obsidian reloading the open note", () => {
        it("shows a version written to a CRLF note once, and keeps its CRLF", async () => {
            const disk = "line 1\r\nline 2\r\nline 3\r\n";
            io.addFile("a.md", disk);
            const leaf = makeLeaf("a.md", "line 1\nline 2\nline 3\n", disk);
            const leaves = [leaf];
            reloadOnModify(io, leaves);
            const writer = makeWriter(leaves);

            expect(await writer.applyRemoteContent("a.md", bytes("line 1 DEV\r\nline 2\r\nline 3\r\n")))
                .toEqual({ applied: true });
            await vi.advanceTimersByTimeAsync(5000);

            expect(leaf.view.editor.cm.text()).toBe("line 1 DEV\nline 2\nline 3\n");
            expect(leaf.view.merges).toBe(0);
            expect(leaf.view.dirty).toBe(false);
            expect(io.readText("a.md")).toBe("line 1 DEV\r\nline 2\r\nline 3\r\n");
        });

        it("shows a version written to a note with a BOM and CRLF once, and keeps both", async () => {
            const disk = "﻿line 1\r\nline 2\r\n";
            io.addFile("a.md", disk);
            const leaf = makeLeaf("a.md", "line 1\nline 2\n", "line 1\r\nline 2\r\n");
            const leaves = [leaf];
            reloadOnModify(io, leaves);
            const writer = makeWriter(leaves);

            const written = "﻿line 1 DEV\r\nline 2\r\n";
            expect(await writer.applyRemoteContent("a.md", bytes(written))).toEqual({ applied: true });
            await vi.advanceTimersByTimeAsync(5000);

            expect(leaf.view.editor.cm.text()).toBe("line 1 DEV\nline 2\n");
            expect(leaf.view.merges).toBe(0);
            // readText drops the BOM, as Obsidian does: compare the bytes.
            expect(new Uint8Array(io.files.get("a.md")!.data)).toEqual(new Uint8Array(bytes(written)));
        });

        it("keeps input typed between the check and the write: Obsidian merges and saves it", async () => {
            io.addFile("a.md", "a\nb\n");
            const leaf = makeLeaf("a.md", "a\nb\n");
            const leaves = [leaf];
            reloadOnModify(io, leaves);
            const writer = makeWriter(leaves);
            let typed = false;
            const write = io.writeBinary.bind(io);
            io.writeBinary = async (p, d) => {
                if (!typed) { typed = true; leaf.view.editor.cm.type("a\nb\nmine\n"); }
                await write(p, d);
            };

            expect(await writer.applyRemoteContent("a.md", bytes("A\nb\n"))).toEqual({ applied: true });
            await vi.advanceTimersByTimeAsync(0);
            expect(leaf.view.editor.cm.text()).toBe("A\nb\nmine\n");
            expect(leaf.view.merges).toBe(1);

            await vi.advanceTimersByTimeAsync(2000);
            expect(io.readText("a.md")).toBe("A\nb\nmine\n");
        });
    });

    // ── Unsaved input ─────────────────────────────────────

    it("declines and touches nothing while a pane holds unsaved input", async () => {
        io.addFile("a.md", "old");
        const leaf = makeLeaf("a.md", "old plus typing");
        const writer = makeWriter([leaf]);
        expect(await writer.applyRemoteContent("a.md", bytes("new"))).toEqual({
            applied: false, reason: UNSAVED_EDITOR_CHANGE,
        });
        expect(leaf.view.editor.cm.text()).toBe("old plus typing");
        expect(io.readText("a.md")).toBe("old");
        // No echo suppression: the editor's coming save is the user's change.
        expect(writeIgnore.ignoreModifyTo).not.toHaveBeenCalled();
    });

    it("declines when any one of several panes holds unsaved input", async () => {
        io.addFile("a.md", "old");
        const clean = makeLeaf("a.md", "old");
        const typing = makeLeaf("a.md", "old!");
        const writer = makeWriter([clean, typing]);
        const result = await writer.applyRemoteContent("a.md", bytes("new"));
        expect(result).toEqual({ applied: false, reason: UNSAVED_EDITOR_CHANGE });
        expect(io.readText("a.md")).toBe("old");
    });

    it("declines unsaved input on a file with CRLF line breaks", async () => {
        io.addFile("a.md", "line 1\r\n");
        const leaf = makeLeaf("a.md", "line 1\nline 2\n");
        const writer = makeWriter([leaf]);
        expect((await writer.applyRemoteContent("a.md", bytes("new"))).applied).toBe(false);
        expect(io.readText("a.md")).toBe("line 1\r\n");
    });

    it("writes once the editor has saved its input and the pane matches the disk again", async () => {
        io.addFile("a.md", "old");
        const leaf = makeLeaf("a.md", "old!");
        const writer = makeWriter([leaf]);
        expect((await writer.applyRemoteContent("a.md", bytes("new"))).applied).toBe(false);
        io.addFile("a.md", "old!"); // the editor's save
        expect(await writer.applyRemoteContent("a.md", bytes("new"))).toEqual({ applied: true });
    });

    // ── IME composition ───────────────────────────────────

    it("waits for a composition that has not changed the text, then writes", async () => {
        io.addFile("a.md", "old");
        const leaf = makeLeaf("a.md", "old");
        compose(leaf);
        const writer = makeWriter([leaf]);

        const promise = writer.applyRemoteContent("a.md", bytes("new"));
        await vi.advanceTimersByTimeAsync(0);
        expect(gate.pendingCount("a.md")).toBe(1);
        expect(io.readText("a.md")).toBe("old");

        endComposition(leaf);
        expect(await promise).toEqual({ applied: true });
        expect(io.readText("a.md")).toBe("new");
        expect(leaf.view.editor.cm.dispatchSpy).not.toHaveBeenCalled();
    });

    it("declines at once when the composing pane already holds input", async () => {
        io.addFile("a.md", "old");
        const leaf = makeLeaf("a.md", "old");
        compose(leaf);
        leaf.view.editor.cm.type("old にほん");
        const writer = makeWriter([leaf]);

        expect(await writer.applyRemoteContent("a.md", bytes("new"))).toEqual({
            applied: false, reason: UNSAVED_EDITOR_CHANGE,
        });
        expect(gate.pendingCount("a.md")).toBe(0);
    });

    it("declines when the composition commits text into the pane", async () => {
        io.addFile("a.md", "old");
        const leaf = makeLeaf("a.md", "old");
        compose(leaf);
        const writer = makeWriter([leaf]);

        const promise = writer.applyRemoteContent("a.md", bytes("new"));
        await vi.advanceTimersByTimeAsync(0);
        leaf.view.editor.cm.type("old 日本");
        endComposition(leaf);

        expect(await promise).toEqual({ applied: false, reason: UNSAVED_EDITOR_CHANGE });
        expect(leaf.view.editor.cm.text()).toBe("old 日本");
        expect(io.readText("a.md")).toBe("old");
    });

    it("declines when the committed text was saved while the write waited", async () => {
        io.addFile("a.md", "old");
        const leaf = makeLeaf("a.md", "old");
        compose(leaf);
        const writer = makeWriter([leaf]);

        const promise = writer.applyRemoteContent("a.md", bytes("new"));
        await vi.advanceTimersByTimeAsync(0);
        leaf.view.editor.cm.type("old 日本");
        io.addFile("a.md", "old 日本"); // the editor's save: pane == disk again
        endComposition(leaf);

        expect(await promise).toEqual({ applied: false, reason: UNSYNCED_VAULT_CHANGE });
        expect(io.readText("a.md")).toBe("old 日本");
    });

    it("declines, without waiting again, when the composition outlasts the gate's timeout", async () => {
        io.addFile("a.md", "old");
        const leaf = makeLeaf("a.md", "old");
        compose(leaf);
        const writer = makeWriter([leaf]);

        const promise = writer.applyRemoteContent("a.md", bytes("new"));
        await vi.advanceTimersByTimeAsync(30_000);

        expect(await promise).toEqual({ applied: false, reason: UNSAVED_EDITOR_CHANGE });
        expect(gate.pendingCount("a.md")).toBe(0);
        expect(io.readText("a.md")).toBe("old");
    });

    it("writes the disk when every pane closed while the write waited", async () => {
        io.addFile("a.md", "old");
        const leaf = makeLeaf("a.md", "old");
        compose(leaf);
        const leaves = [leaf];
        const writer = makeWriter(leaves);

        const promise = writer.applyRemoteContent("a.md", bytes("fallback"));
        await vi.advanceTimersByTimeAsync(0);
        leaves.length = 0;
        endComposition(leaf);

        expect(await promise).toEqual({ applied: true });
        expect(io.readText("a.md")).toBe("fallback");
    });

    it("flushAll rejects a write waiting for a composition", async () => {
        io.addFile("a.md", "old");
        const leaf = makeLeaf("a.md", "old");
        compose(leaf);
        const writer = makeWriter([leaf]);

        const promise = writer.applyRemoteContent("a.md", bytes("new"));
        await vi.advanceTimersByTimeAsync(0);
        writer.flushAll();
        await expect(promise).rejects.toThrow(/CompositionGate flushed/);
    });

    // ── Deletion ──────────────────────────────────────────

    it("detaches the panes and deletes the file when they hold the disk's text", async () => {
        io.addFile("a.md", "x\r\n");
        const leaf = makeLeaf("a.md", "x\n");
        const writer = makeWriter([leaf]);

        expect(await writer.applyRemoteDeletion("a.md")).toEqual({ applied: true });
        expect(leaf.detach).toHaveBeenCalled();
        expect(writeIgnore.ignoreDelete).toHaveBeenCalledWith("a.md");
        expect(await io.exists("a.md")).toBe(false);
    });

    it("detaches the panes before anything is awaited", async () => {
        io.addFile("a.md", "x");
        const leaf = makeLeaf("a.md", "x");
        const writer = makeWriter([leaf]);
        const detachedAtExists: boolean[] = [];
        const exists = io.exists.bind(io);
        let checked = false;
        io.exists = async (p) => {
            // The first call is the check; the next one starts the removal.
            if (checked) detachedAtExists.push(leaf.detach.mock.calls.length > 0);
            checked = true;
            return exists(p);
        };
        await writer.applyRemoteDeletion("a.md");
        expect(detachedAtExists).toEqual([true]);
    });

    it("keeps the file and its panes while a pane holds unsaved input", async () => {
        io.addFile("a.md", "x");
        const leaf = makeLeaf("a.md", "x and more");
        const writer = makeWriter([leaf]);

        expect(await writer.applyRemoteDeletion("a.md")).toEqual({
            applied: false, reason: UNSAVED_EDITOR_CHANGE,
        });
        expect(leaf.detach).not.toHaveBeenCalled();
        expect(writeIgnore.ignoreDelete).not.toHaveBeenCalled();
        expect(await io.exists("a.md")).toBe(true);
    });

    it("waits for a composition before detaching and deleting", async () => {
        io.addFile("a.md", "x");
        const leaf = makeLeaf("a.md", "x");
        compose(leaf);
        const writer = makeWriter([leaf]);

        const promise = writer.applyRemoteDeletion("a.md");
        await vi.advanceTimersByTimeAsync(0);
        expect(leaf.detach).not.toHaveBeenCalled();

        endComposition(leaf);
        expect(await promise).toEqual({ applied: true });
        expect(leaf.detach).toHaveBeenCalled();
        expect(await io.exists("a.md")).toBe(false);
    });

    it("applyRemoteDeletion is a no-op when the file is already gone", async () => {
        const writer = makeWriter([]);
        expect(await writer.applyRemoteDeletion("missing.md")).toEqual({ applied: true });
        expect(io.files.size).toBe(0);
    });

    // ── createFile ────────────────────────────────────────

    it("createFile writes via IVaultIO", async () => {
        const captureSyncWrite = vi.fn(async () => {});
        const writer = makeWriter([], { historyCapture: { captureSyncWrite } });
        await writer.createFile("new.md", bytes("hello"));
        expect(io.readText("new.md")).toBe("hello");
        expect(captureSyncWrite).toHaveBeenCalledWith("new.md", "hello");
    });
});
