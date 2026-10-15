/**
 * Keep Local on a conflict found in the vault must keep the vault's version
 * only over the local DB doc the dialog showed.
 *
 * The reconcile offers a conflict when the vault holds a change not synced
 * (an edit, a deletion, or a file made again over a deletion) and the local
 * DB doc has moved past the last sync. While the dialog is open, a pull can
 * move the doc again: the vault is not written, because it holds a change
 * not synced, but the doc is. Keep Local used to commit the vault's version
 * over whatever doc it found, so the newer version from another device was
 * replaced without being shown.
 *
 * Keep Local now writes nothing when the doc is not the one the dialog
 * showed, and the conflict is offered again with the current doc. Take
 * Remote follows the same rule: it wrote the doc shown to the vault over
 * the user's change, though the doc had moved on.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { VaultSync } from "../../src/sync/vault-sync.ts";
import { Reconciler } from "../../src/sync/reconciler.ts";
import type { VaultWriter, WriteResult } from "../../src/sync/vault-writer.ts";
import { LocalDB } from "../../src/db/local-db.ts";
import { ConflictOrchestrator } from "../../src/conflict/conflict-orchestrator.ts";
import { FakeVaultIO } from "../helpers/fake-vault-io.ts";
import { FakeModalPresenter } from "../helpers/fake-modal-presenter.ts";
import { makeSettings } from "../helpers/settings-factory.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import { toPathKey } from "../../src/utils/path.ts";
import { splitIntoChunks } from "../../src/db/chunker.ts";
import { compareVC } from "../../src/sync/vector-clock.ts";
import type { ConflictContent, ConflictModalResult } from "../../src/types/modal-presenter.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";

let counter = 0;
function uniqueDbName() { return `vault-keep-local-stale-${Date.now()}-${counter++}`; }

class PlainWriter implements VaultWriter {
    constructor(private io: FakeVaultIO) {}
    async applyRemoteContent(path: string, content: ArrayBuffer): Promise<WriteResult> {
        await this.io.writeBinary(path, content);
        return { applied: true };
    }
    async applyRemoteDeletion(path: string): Promise<WriteResult> {
        if (await this.io.exists(path)) await this.io.delete(path);
        return { applied: true };
    }
    async createFile(path: string, content: ArrayBuffer): Promise<void> {
        await this.io.createBinary(path, content);
    }
    flushAll(): void {}
}

/** A modal that runs the next queued action while the dialog is open,
 *  before the user's answer is applied. */
class ModalWithActivity extends FakeModalPresenter {
    whileOpen: Array<() => Promise<void>> = [];
    showConflictModal(
        filePath: string,
        content: ConflictContent,
    ): { result: Promise<ConflictModalResult>; dismiss: () => void } {
        const action = this.whileOpen.shift();
        const shown = super.showConflictModal(filePath, content);
        if (!action) return shown;
        return { result: action().then(() => shown.result), dismiss: shown.dismiss };
    }
}

const PATH = "note.md";
const enc = new TextEncoder();
const OLD = Date.now() - 60_000;
const KEEP_LOCAL: ConflictModalResult = { choice: "keep-local", dismissed: false };
const DEFER: ConflictModalResult = { choice: "defer", dismissed: false };
const TAKE_REMOTE: ConflictModalResult = { choice: "take-remote", dismissed: false };

describe("regression: Keep Local on a vault conflict keeps only over the version shown", () => {
    let vault: FakeVaultIO;
    let db: LocalDB;
    let vs: VaultSync;
    let modal: ModalWithActivity;
    let reconciler: Reconciler;

    beforeEach(() => {
        vault = new FakeVaultIO();
        db = new LocalDB(uniqueDbName());
        db.open();
        const settings = makeSettings({ deviceId: "dev-B" });
        vs = new VaultSync(vault, db, () => settings, new PlainWriter(vault));
        modal = new ModalWithActivity();
        reconciler = new Reconciler({ getFiles: () => vault.getFiles() } as any, db, vs, () => settings);
        const orchestrator = new ConflictOrchestrator({
            modal,
            localDb: db,
            replicator: {
                setConflictResolver: () => {},
                events: { on: () => {}, emit: () => {} },
            } as any,
            historyCapture: { saveConflict: async () => {} } as any,
            getSettings: () => settings,
            vault,
            vaultSync: vs,
            requestReconcile: () => { void reconciler.reconcile("paused"); },
            batchDebounceMs: 0,
        });
        orchestrator.register();
        reconciler.setConflictOrchestrator(orchestrator);
    });

    afterEach(async () => {
        await reconciler.settle();
        await db.destroy();
    });

    const docOf = async () => (await db.get(makeFileId(PATH))) as FileDoc;

    /** Commit a version of `base` to the local DB the way a pull does. */
    async function pull(base: FileDoc, text: string | null, vclock: Record<string, number>): Promise<FileDoc> {
        if (text === null) {
            const tomb = { ...base, deleted: true as const, vclock };
            await db.runWriteTx({ docs: [{ doc: tomb as unknown as CouchSyncDoc }] });
            return tomb;
        }
        const buf = enc.encode(text).buffer;
        const chunks = await splitIntoChunks(buf);
        const doc: FileDoc = { ...base, chunks: chunks.map((c) => c._id), size: buf.byteLength, vclock };
        await db.runWriteTx({
            chunks: chunks as unknown as CouchSyncDoc[],
            docs: [{ doc: doc as unknown as CouchSyncDoc }],
        });
        return doc;
    }

    /** The file is synced, then a pull moved the doc while the vault holds
     *  the synced content still. */
    async function pulledOverSynced(): Promise<{ synced: FileDoc; shown: FileDoc }> {
        vault.addFile(PATH, "v0\n", { mtime: OLD });
        await vs.fileToDb(PATH);
        const synced = await docOf();
        const shown = await pull(synced, "pulled v1\n", { ...synced.vclock, "dev-A": 1 });
        return { synced, shown };
    }

    /** A pull lands while the dialog is open. */
    function pullWhileOpen(shown: FileDoc, text: string | null): { moved: Promise<FileDoc> } {
        let done!: (d: FileDoc) => void;
        const moved = new Promise<FileDoc>((res) => { done = res; });
        modal.whileOpen.push(async () => {
            done(await pull(shown, text, { ...shown.vclock, "dev-A": (shown.vclock["dev-A"] ?? 0) + 1 }));
        });
        return { moved };
    }

    const shownText = (i: number, side: "local" | "remote") => {
        const c = modal.conflictCalls[i].content;
        if (c.kind !== "text") throw new Error("expected a text conflict");
        return side === "local" ? c.localText : c.remoteText;
    };

    describe("an edit in the vault", () => {
        it("writes nothing and asks again when a pull moved the doc while the dialog was open", async () => {
            const { synced, shown } = await pulledOverSynced();
            vault.addFile(PATH, "user edit\n");
            const { moved } = pullWhileOpen(shown, "pulled v2\n");
            modal.conflictResponses.push(KEEP_LOCAL, DEFER);

            await reconciler.reconcile("manual");

            const now = await moved;
            expect((await docOf()).vclock).toEqual(now.vclock);
            expect(vs.getLastSynced(PATH)?.vclock).toEqual(synced.vclock);
            expect(vault.readText(PATH)).toBe("user edit\n");
            await vi.waitFor(() => expect(modal.conflictCalls).toHaveLength(2));
            expect(shownText(1, "local")).toBe("user edit\n");
            expect(shownText(1, "remote")).toBe("pulled v2\n");
        });

        it("Take Remote writes nothing and asks again when a pull moved the doc while the dialog was open", async () => {
            const { synced, shown } = await pulledOverSynced();
            vault.addFile(PATH, "user edit\n");
            const { moved } = pullWhileOpen(shown, "pulled v2\n");
            modal.conflictResponses.push(TAKE_REMOTE, DEFER);

            await reconciler.reconcile("manual");

            const now = await moved;
            expect((await docOf()).vclock).toEqual(now.vclock);
            expect(vs.getLastSynced(PATH)?.vclock).toEqual(synced.vclock);
            expect(vault.readText(PATH)).toBe("user edit\n");
            await vi.waitFor(() => expect(modal.conflictCalls).toHaveLength(2));
            expect(shownText(1, "local")).toBe("user edit\n");
            expect(shownText(1, "remote")).toBe("pulled v2\n");
        });

        it("keeps the vault's version over the doc shown", async () => {
            const { shown } = await pulledOverSynced();
            vault.addFile(PATH, "user edit\n");
            modal.conflictResponses.push(KEEP_LOCAL);

            await reconciler.reconcile("manual");

            const kept = await docOf();
            expect(compareVC(kept.vclock, shown.vclock)).toBe("dominates");
            expect(kept.size).toBe(enc.encode("user edit\n").byteLength);
            expect(vs.getLastSynced(PATH)?.vclock).toEqual(kept.vclock);
            await reconciler.settle();
            expect(modal.conflictCalls).toHaveLength(1);
        });
    });

    describe("a deletion in the vault", () => {
        it("writes nothing and asks again when a pull moved the doc while the dialog was open", async () => {
            const { synced, shown } = await pulledOverSynced();
            await vault.delete(PATH);
            const { moved } = pullWhileOpen(shown, "pulled v2\n");
            modal.conflictResponses.push(KEEP_LOCAL, DEFER);

            await reconciler.reconcile("manual");

            const now = await moved;
            const doc = await docOf();
            expect(doc.deleted ?? false).toBe(false);
            expect(doc.vclock).toEqual(now.vclock);
            expect(vs.getLastSynced(PATH)?.vclock).toEqual(synced.vclock);
            await vi.waitFor(() => expect(modal.conflictCalls).toHaveLength(2));
            expect(shownText(1, "remote")).toBe("pulled v2\n");
        });

        it("keeps the deletion over the doc shown", async () => {
            const { shown } = await pulledOverSynced();
            await vault.delete(PATH);
            modal.conflictResponses.push(KEEP_LOCAL);

            await reconciler.reconcile("manual");

            const kept = await docOf();
            expect(kept.deleted).toBe(true);
            expect(compareVC(kept.vclock, shown.vclock)).toBe("dominates");
            expect(vs.getLastSynced(PATH)).toMatchObject({ deleted: true, vclock: kept.vclock });
            await reconciler.settle();
            expect(modal.conflictCalls).toHaveLength(1);
        });
    });

    describe("a file made again over a deletion", () => {
        /** A tombstone with no record of the deletion in the vault, and
         *  the file made again there. */
        async function recreatedOverTombstone(): Promise<FileDoc> {
            vault.addFile(PATH, "v0\n", { mtime: OLD });
            await vs.fileToDb(PATH);
            const synced = await docOf();
            const tomb = await pull(synced, null, { ...synced.vclock, "dev-A": 1 });
            await db.runWriteTx({ vclocks: [{ path: PATH, op: "delete" }] });
            (vs as any).lastSynced.delete(toPathKey(PATH));
            vault.addFile(PATH, "made again\n");
            return tomb;
        }

        it("writes nothing and asks again when a pull moved the doc while the dialog was open", async () => {
            const shown = await recreatedOverTombstone();
            const { moved } = pullWhileOpen(shown, null);
            modal.conflictResponses.push(KEEP_LOCAL, DEFER);

            await reconciler.reconcile("manual");

            const now = await moved;
            const doc = await docOf();
            expect(doc.deleted).toBe(true);
            expect(doc.vclock).toEqual(now.vclock);
            expect(vs.getLastSynced(PATH)).toBeUndefined();
            await vi.waitFor(() => expect(modal.conflictCalls).toHaveLength(2));
            expect(shownText(1, "local")).toBe("made again\n");
        });

        it("Take Remote writes nothing and asks again when a pull moved the doc while the dialog was open", async () => {
            const shown = await recreatedOverTombstone();
            const { moved } = pullWhileOpen(shown, null);
            modal.conflictResponses.push(TAKE_REMOTE, DEFER);

            await reconciler.reconcile("manual");

            const now = await moved;
            expect((await docOf()).vclock).toEqual(now.vclock);
            expect(vault.readText(PATH)).toBe("made again\n");
            await vi.waitFor(() => expect(modal.conflictCalls).toHaveLength(2));
        });

        it("keeps the file over the tombstone shown", async () => {
            const shown = await recreatedOverTombstone();
            modal.conflictResponses.push(KEEP_LOCAL);

            await reconciler.reconcile("manual");

            const kept = await docOf();
            expect(kept.deleted ?? false).toBe(false);
            expect(compareVC(kept.vclock, shown.vclock)).toBe("dominates");
            expect(vs.getLastSynced(PATH)?.vclock).toEqual(kept.vclock);
            await reconciler.settle();
            expect(modal.conflictCalls).toHaveLength(1);
        });
    });

    it("commits a restored version over the current doc, whatever it is", async () => {
        // A version restored from the history has no conflict dialog
        // behind it: the user asked for the vault's content to win.
        const { shown } = await pulledOverSynced();
        vault.addFile(PATH, "restored\n");

        expect(await vs.forceLocalEdit(PATH)).toBe("written");

        const doc = await docOf();
        expect(compareVC(doc.vclock, shown.vclock)).toBe("dominates");
        expect(doc.size).toBe(enc.encode("restored\n").byteLength);
        expect(vs.getLastSynced(PATH)?.vclock).toEqual(doc.vclock);
    });
});
