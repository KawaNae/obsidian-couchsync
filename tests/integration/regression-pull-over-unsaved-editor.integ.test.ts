/**
 * A pull must not replace input an open editor has not saved yet.
 *
 * Obsidian saves an editor's input about two seconds after it is typed.
 * Until then the disk still holds what was last synced, so dbToFile's own
 * check passes; the editor-aware writer compares the panes with the disk
 * and declines. The declined version waits in the local DB. The reconcile
 * that follows the pull still sees the disk as last synced and cannot
 * decide; the editor's save is what lets it: VaultSync calls back on the
 * save (`setOnEditorSaved`), and the reconcile then offers the pulled
 * version against the saved input.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { VaultSync } from "../../src/sync/vault-sync.ts";
import { Reconciler } from "../../src/sync/reconciler.ts";
import { UNSAVED_EDITOR_CHANGE } from "../../src/sync/vault-writer.ts";
import { EditorAwareVaultWriter } from "../../src/adapters/editor-aware-vault-writer.ts";
import { CompositionGate } from "../../src/sync/composition-gate.ts";
import { LocalDB } from "../../src/db/local-db.ts";
import { PullWriter } from "../../src/db/sync/pull-writer.ts";
import { EchoTracker } from "../../src/db/sync/echo-tracker.ts";
import { SyncEvents } from "../../src/db/sync/sync-events.ts";
import { Checkpoints } from "../../src/db/sync/checkpoints.ts";
import { ConflictResolver } from "../../src/conflict/conflict-resolver.ts";
import { FakeVaultIO } from "../helpers/fake-vault-io.ts";
import { FakeCompositionTracker } from "../helpers/fake-composition-tracker.ts";
import { makeFakeApp, makeLeaf, type FakeLeaf } from "../helpers/fake-editor.ts";
import { makeSettings } from "../helpers/settings-factory.ts";
import { makePendingApply } from "../helpers/pending-apply.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import { splitIntoChunks } from "../../src/db/chunker.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";

let counter = 0;
function uniqueDbName() { return `pull-over-unsaved-editor-${Date.now()}-${counter++}`; }

const PATH = "note.md";
const enc = new TextEncoder();

describe("regression: pull over an editor's unsaved input", () => {
    let vault: FakeVaultIO;
    let db: LocalDB;
    let vs: VaultSync;
    let leaves: FakeLeaf[];
    let gate: CompositionGate;
    let reconciler: Reconciler;
    let reported: { edit: string[]; delete: string[]; recreate: string[] };
    let pullSkipped: number;
    let editorSaved: number;

    beforeEach(() => {
        vault = new FakeVaultIO();
        db = new LocalDB(uniqueDbName());
        db.open();
        leaves = [];
        gate = new CompositionGate(new FakeCompositionTracker());
        gate.start();
        const writer = new EditorAwareVaultWriter(makeFakeApp(leaves), vault, gate, null, null);
        const settings = makeSettings({ deviceId: "dev-B" });
        vs = new VaultSync(vault, db, () => settings, writer);
        editorSaved = 0;
        vs.setOnEditorSaved(() => { editorSaved++; });
        pullSkipped = 0;
        reported = { edit: [], delete: [], recreate: [] };
        reconciler = new Reconciler(
            { getFiles: () => vault.getFiles() } as any,
            db, vs, () => settings,
        );
        reconciler.setConflictOrchestrator({
            async handleDivergentLocalEdit(p: string) { reported.edit.push(p); },
            async handleDivergentLocalDelete(p: string) { reported.delete.push(p); },
            async handleDivergentRecreate(p: string) { reported.recreate.push(p); },
        } as any);
    });

    afterEach(async () => {
        gate.stop();
        await db.destroy();
    });

    async function integrated(text: string): Promise<FileDoc> {
        vault.addFile(PATH, text);
        await vs.fileToDb(PATH);
        return await db.get(makeFileId(PATH)) as FileDoc;
    }

    /** Open a pane on PATH holding `text`. */
    function openPane(text: string): FakeLeaf {
        const leaf = makeLeaf(PATH, text);
        leaves.push(leaf);
        return leaf;
    }

    /** The editor saves what its pane holds; the modify event runs fileToDb. */
    async function save(leaf: FakeLeaf): Promise<void> {
        vault.addFile(PATH, leaf.view.editor.cm.text());
        await vs.fileToDb(PATH);
    }

    async function pull(base: FileDoc, text: string, vclock: Record<string, number>,
        opts: { deleted?: boolean } = {}): Promise<FileDoc> {
        const buf = enc.encode(text).buffer;
        const chunks = await splitIntoChunks(buf);
        const doc: FileDoc = {
            ...base, chunks: chunks.map((c) => c._id), size: buf.byteLength, vclock,
            ...(opts.deleted ? { deleted: true } : {}),
        };
        await db.runWriteTx({ chunks: chunks as unknown as CouchSyncDoc[] });
        const events = new SyncEvents();
        events.on("pull-skipped", () => { pullSkipped++; });
        const applyPullWrite = (d: FileDoc) => vs.dbToFile(d);
        await new PullWriter({
            localDb: db,
            events,
            echoes: new EchoTracker(),
            checkpoints: new Checkpoints(db),
            getConflictResolver: () => new ConflictResolver(),
            ensureChunks: async () => {},
            pendingApply: makePendingApply(db, { write: applyPullWrite }),
            getRemoteDoc: async () => null,
            applyPullWrite,
            probeUnpushed: async () => false,
        }).apply({
            results: [{ id: doc._id, seq: "1", doc: doc as unknown as CouchSyncDoc }],
            last_seq: "1",
        });
        return doc;
    }

    it("keeps the input, and offers the pulled version once the editor saves", async () => {
        const v0 = await integrated("v0\n");
        const pane = openPane("v0\n");
        pane.view.editor.cm.type("v0\nmine\n");

        const r1 = await pull(v0, "remote 1\n", { ...v0.vclock, "dev-A": 1 });

        expect(pane.view.editor.cm.text()).toBe("v0\nmine\n");
        expect(vault.readText(PATH)).toBe("v0\n");
        expect(((await db.get(makeFileId(PATH))) as FileDoc).chunks).toEqual(r1.chunks);
        expect(pullSkipped).toBe(1);

        // The reconcile that pull-skipped fires cannot decide yet.
        expect((await vs.dbToFile(r1)).applied).toBe(false);
        await reconciler.reconcile("paused");
        expect(reported).toEqual({ edit: [], delete: [], recreate: [] });
        expect(pane.view.editor.cm.text()).toBe("v0\nmine\n");
        expect(editorSaved).toBe(0);

        // The save: the push is refused (the doc is ahead), and the
        // callback asks for the reconcile, which offers the conflict.
        await save(pane);
        expect(editorSaved).toBe(1);
        await reconciler.reconcile("paused");
        expect(reported.edit).toEqual([PATH]);
        expect(vault.readText(PATH)).toBe("v0\nmine\n");

        // One declined write asks once.
        await save(pane);
        expect(editorSaved).toBe(1);
    });

    it("writes the pulled version when the input is undone before a save", async () => {
        const v0 = await integrated("v0\n");
        const pane = openPane("v0\n");
        pane.view.editor.cm.type("v0\nmine\n");
        await pull(v0, "remote 1\n", { ...v0.vclock, "dev-A": 1 });

        pane.view.editor.cm.type("v0\n");
        await reconciler.reconcile("paused");

        expect(pane.view.editor.cm.text()).toBe("remote 1\n");
        expect(vault.readText(PATH)).toBe("remote 1\n");
        expect(reported).toEqual({ edit: [], delete: [], recreate: [] });
        // Integrated: a later save does not ask for another reconcile.
        await save(pane);
        expect(editorSaved).toBe(0);
    });

    it("writes the pulled version into a clean pane on a CRLF file", async () => {
        const v0 = await integrated("v0\r\n");
        const pane = openPane("v0\n");

        await pull(v0, "remote 1\n", { ...v0.vclock, "dev-A": 1 });

        expect(pullSkipped).toBe(0);
        expect(pane.view.editor.cm.text()).toBe("remote 1\n");
        expect(vault.readText(PATH)).toBe("remote 1\n");
    });

    it("keeps a file with unsaved input when its deletion is pulled", async () => {
        const v0 = await integrated("v0\n");
        const pane = openPane("v0\n");
        pane.view.editor.cm.type("v0\nmine\n");

        const tomb = await pull(v0, "v0\n", { ...v0.vclock, "dev-A": 1 }, { deleted: true });

        expect(await vs.dbToFile(tomb)).toEqual({ applied: false, reason: UNSAVED_EDITOR_CHANGE });
        expect(vault.files.has(PATH)).toBe(true);
        expect(pane.detach).not.toHaveBeenCalled();
        expect(vs.getLastSynced(PATH)?.deleted).toBeUndefined();

        await save(pane);
        expect(editorSaved).toBe(1);
        await reconciler.reconcile("paused");
        expect(reported.recreate).toEqual([PATH]);
        expect(vault.readText(PATH)).toBe("v0\nmine\n");
    });
});
