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
import { makeFakeApp, makeLeaf, type FakeLeaf } from "./helpers/fake-editor.ts";

const bytes = (text: string) => new TextEncoder().encode(text).buffer;

describe("EditorAwareVaultWriter", () => {
    let io: FakeVaultIO;
    let tracker: FakeCompositionTracker;
    let gate: CompositionGate;
    let writeIgnore: { ignoreDelete: ReturnType<typeof vi.fn>; ignoreNextModify: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        vi.useFakeTimers();
        io = new FakeVaultIO();
        tracker = new FakeCompositionTracker();
        gate = new CompositionGate(tracker, { timeoutMs: 30_000 });
        gate.start();
        writeIgnore = { ignoreDelete: vi.fn(), ignoreNextModify: vi.fn() };
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
        expect(await writer.applyRemoteContent("a.md", bytes("new"))).toEqual({ applied: true });
        expect(io.readText("a.md")).toBe("new");
        expect(writeIgnore.ignoreNextModify).toHaveBeenCalledWith("a.md");
    });

    it("captures history for writes", async () => {
        io.addFile("a.md", "old");
        const captureSyncWrite = vi.fn(async () => {});
        const writer = makeWriter([], { historyCapture: { captureSyncWrite } });
        await writer.applyRemoteContent("a.md", bytes("new"));
        expect(captureSyncWrite).toHaveBeenCalledWith("a.md", "new");
    });

    // ── Panes that hold what the disk holds ───────────────

    it("replaces a pane that holds the disk's text, and writes the disk", async () => {
        io.addFile("a.md", "old");
        const leaf = makeLeaf("a.md", "old");
        const writer = makeWriter([leaf]);
        expect(await writer.applyRemoteContent("a.md", bytes("new"))).toEqual({ applied: true });
        expect(leaf.view.editor.cm.text()).toBe("new");
        expect(io.readText("a.md")).toBe("new");
        expect(writeIgnore.ignoreNextModify).toHaveBeenCalledWith("a.md");
    });

    it("replaces every pane on the path and writes the disk once", async () => {
        io.addFile("file.md", "old");
        const a = makeLeaf("file.md", "old");
        const b = makeLeaf("file.md", "old");
        const other = makeLeaf("other.md", "x");
        const writer = makeWriter([a, b, other]);
        await writer.applyRemoteContent("file.md", bytes("new"));
        expect(a.view.editor.cm.text()).toBe("new");
        expect(b.view.editor.cm.text()).toBe("new");
        expect(other.view.editor.cm.dispatchSpy).not.toHaveBeenCalled();
        expect(io.readText("file.md")).toBe("new");
    });

    it("replaces the panes before the disk write, so later input lands on the new text", async () => {
        io.addFile("a.md", "old");
        const leaf = makeLeaf("a.md", "old");
        const writer = makeWriter([leaf]);
        const textAtDiskWrite: string[] = [];
        const write = io.writeBinary.bind(io);
        io.writeBinary = async (p, d) => {
            textAtDiskWrite.push(leaf.view.editor.cm.text());
            await write(p, d);
        };
        await writer.applyRemoteContent("a.md", bytes("new"));
        expect(textAtDiskWrite).toEqual(["new"]);
    });

    it("treats CRLF and a BOM on disk as the pane's LF text", async () => {
        io.addFile("a.md", "﻿line 1\r\nline 2\r\n");
        const leaf = makeLeaf("a.md", "line 1\nline 2\n");
        const writer = makeWriter([leaf]);
        expect(await writer.applyRemoteContent("a.md", bytes("new\n"))).toEqual({ applied: true });
        expect(leaf.view.editor.cm.text()).toBe("new\n");
        expect(io.readText("a.md")).toBe("new\n");
    });

    // ── Unsaved input ─────────────────────────────────────

    it("declines and touches nothing while a pane holds unsaved input", async () => {
        io.addFile("a.md", "old");
        const leaf = makeLeaf("a.md", "old plus typing");
        const writer = makeWriter([leaf]);
        expect(await writer.applyRemoteContent("a.md", bytes("new"))).toEqual({
            applied: false, reason: UNSAVED_EDITOR_CHANGE,
        });
        expect(leaf.view.editor.cm.dispatchSpy).not.toHaveBeenCalled();
        expect(io.readText("a.md")).toBe("old");
        // No echo suppression: the editor's coming save is the user's change.
        expect(writeIgnore.ignoreNextModify).not.toHaveBeenCalled();
    });

    it("declines when any one of several panes holds unsaved input", async () => {
        io.addFile("a.md", "old");
        const clean = makeLeaf("a.md", "old");
        const typing = makeLeaf("a.md", "old!");
        const writer = makeWriter([clean, typing]);
        const result = await writer.applyRemoteContent("a.md", bytes("new"));
        expect(result).toEqual({ applied: false, reason: UNSAVED_EDITOR_CHANGE });
        expect(clean.view.editor.cm.dispatchSpy).not.toHaveBeenCalled();
        expect(typing.view.editor.cm.dispatchSpy).not.toHaveBeenCalled();
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
        expect(leaf.view.editor.cm.dispatchSpy).not.toHaveBeenCalled();
        expect(io.readText("a.md")).toBe("old");

        endComposition(leaf);
        expect(await promise).toEqual({ applied: true });
        expect(leaf.view.editor.cm.text()).toBe("new");
        expect(io.readText("a.md")).toBe("new");
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
        expect(leaf.view.editor.cm.dispatchSpy).not.toHaveBeenCalled();
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
