/**
 * A pulled version written to a note open in a pane, with Obsidian
 * reloading the pane on the modify event.
 *
 * The writer writes the disk only. If it also set the editor's text,
 * Obsidian would take that for typing: the pane would be unsaved when the
 * modify event came, and Obsidian would merge the "typing" into the new
 * disk text. On a note with CRLF line breaks the editor's LF text never
 * equals the disk text, so the merge ran and the changed lines doubled;
 * Obsidian then saved the doubled text with LF line breaks.
 *
 * The modify event the write causes is not an edit. Obsidian's save of
 * input typed while the version was being written is one, and reaches the
 * local DB with the usual debounce.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { VaultSync } from "../../src/sync/vault-sync.ts";
import { ChangeTracker } from "../../src/sync/change-tracker.ts";
import { EditorAwareVaultWriter } from "../../src/adapters/editor-aware-vault-writer.ts";
import { CompositionGate } from "../../src/sync/composition-gate.ts";
import { LocalDB } from "../../src/db/local-db.ts";
import { PullWriter } from "../../src/db/sync/pull-writer.ts";
import { EchoTracker } from "../../src/db/sync/echo-tracker.ts";
import { SyncEvents } from "../../src/db/sync/sync-events.ts";
import { Checkpoints } from "../../src/db/sync/checkpoints.ts";
import { ConflictResolver } from "../../src/conflict/conflict-resolver.ts";
import { FakeVaultIO } from "../helpers/fake-vault-io.ts";
import { FakeVaultEvents } from "../helpers/fake-vault-events.ts";
import { FakeCompositionTracker } from "../helpers/fake-composition-tracker.ts";
import { makeFakeApp, makeLeaf, reloadOnModify, type FakeLeaf } from "../helpers/fake-editor.ts";
import { makeSettings } from "../helpers/settings-factory.ts";
import { makePendingApply } from "../helpers/pending-apply.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import { splitIntoChunks } from "../../src/db/chunker.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";

let counter = 0;
function uniqueDbName() { return `pull-into-open-note-${Date.now()}-${counter++}`; }

const PATH = "note.md";
const enc = new TextEncoder();
const DEBOUNCE_MS = 20;
const SAVE_DELAY_MS = 50;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("regression: a pulled version written into an open note", () => {
    let vault: FakeVaultIO;
    let events: FakeVaultEvents;
    let db: LocalDB;
    let vs: VaultSync;
    let ct: ChangeTracker;
    let leaves: FakeLeaf[];
    let gate: CompositionGate;

    beforeEach(() => {
        vault = new FakeVaultIO();
        events = new FakeVaultEvents();
        db = new LocalDB(uniqueDbName());
        db.open();
        leaves = [];
        reloadOnModify(vault, leaves, events);
        gate = new CompositionGate(new FakeCompositionTracker());
        gate.start();
        const writer = new EditorAwareVaultWriter(makeFakeApp(leaves), vault, gate, null, null);
        const settings = makeSettings({
            deviceId: "dev-B", syncDebounceMs: DEBOUNCE_MS, syncMinIntervalMs: 0,
        });
        vs = new VaultSync(vault, db, () => settings, writer);
        ct = new ChangeTracker(events, vault, vs, () => settings);
        writer.setWriteIgnore(ct);
        vs.setPendingProbe(ct);
        ct.start();
    });

    afterEach(async () => {
        ct.stop();
        gate.stop();
        await db.destroy();
    });

    async function integrated(text: string): Promise<FileDoc> {
        vault.addFile(PATH, text);
        await vs.fileToDb(PATH);
        return await db.get(makeFileId(PATH)) as FileDoc;
    }

    /** Open a pane on PATH, as Obsidian shows the file's text. */
    function openPane(): FakeLeaf {
        const disk = vault.readText(PATH);
        const leaf = makeLeaf(PATH, disk, disk);
        leaf.view.saveDelayMs = SAVE_DELAY_MS;
        leaves.push(leaf);
        return leaf;
    }

    async function pull(base: FileDoc, text: string, vclock: Record<string, number>): Promise<FileDoc> {
        const buf = enc.encode(text).buffer;
        const chunks = await splitIntoChunks(buf);
        const doc: FileDoc = { ...base, chunks: chunks.map((c) => c._id), size: buf.byteLength, vclock };
        await db.runWriteTx({ chunks: chunks as unknown as CouchSyncDoc[] });
        const applyPullWrite = (d: FileDoc) => vs.dbToFile(d);
        await new PullWriter({
            localDb: db,
            events: new SyncEvents(),
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

    it("shows the pulled version once in a CRLF note, keeps CRLF, and pushes nothing", async () => {
        const v0 = await integrated("line 1\r\nline 2\r\nline 3\r\n");
        const pane = openPane();

        const r1 = await pull(v0, "line 1 DEV\r\nline 2\r\nline 3\r\n", { ...v0.vclock, "dev-A": 1 });
        await wait(SAVE_DELAY_MS + DEBOUNCE_MS * 5);

        expect(pane.view.editor.cm.text()).toBe("line 1 DEV\nline 2\nline 3\n");
        expect(pane.view.merges).toBe(0);
        expect(vault.readText(PATH)).toBe("line 1 DEV\r\nline 2\r\nline 3\r\n");
        const doc = await db.get(makeFileId(PATH)) as FileDoc;
        expect(doc.chunks).toEqual(r1.chunks);
        expect(doc.vclock).toEqual(r1.vclock);
        expect(ct.hasPending(PATH)).toBe(false);
    });

    it("pushes Obsidian's merge of input typed while the version was written", async () => {
        const v0 = await integrated("a\nb\n");
        const pane = openPane();
        let typed = false;
        const write = vault.writeBinary;
        vault.writeBinary = async (p, d) => {
            if (!typed) { typed = true; pane.view.editor.cm.type("a\nb\nmine\n"); }
            await write(p, d);
        };

        const r1 = await pull(v0, "A\nb\n", { ...v0.vclock, "dev-A": 1 });
        await wait(SAVE_DELAY_MS + DEBOUNCE_MS * 5);

        expect(pane.view.merges).toBe(1);
        expect(vault.readText(PATH)).toBe("A\nb\nmine\n");
        const merged = await splitIntoChunks(enc.encode("A\nb\nmine\n").buffer);
        const doc = await db.get(makeFileId(PATH)) as FileDoc;
        expect(doc.chunks).toEqual(merged.map((c) => c._id));
        expect(doc.vclock).toEqual({ ...r1.vclock, "dev-B": (r1.vclock["dev-B"] ?? 0) + 1 });
    });
});
