/**
 * Keep Local on a pull conflict must leave the vault's baseline in step with
 * the version it keeps.
 *
 * A pull conflict compares the local DB doc L with a concurrent remote
 * version R. Keep Local commits K = increment(merge(L, R)) with L's content.
 * When only the doc moved to K and the baseline (`lastSynced`) stayed at L,
 * the next vault change was judged against L:
 *   - an edit: fileToDb saw the doc K dominate the baseline L and the disk
 *     differ from it, took the path as true-divergent and did not push;
 *   - a deletion: markDeleted saw K dominate L and skipped the tombstone as
 *     a pull not yet integrated;
 *   - the reconcile then offered this device's own earlier version as the
 *     remote side of a conflict.
 *
 * Keep Local now commits the doc and the baseline in one write when the
 * vault holds the kept content, and writes the kept version to the vault
 * otherwise, through the same guard as any doc-to-vault write.
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
import { splitIntoChunks } from "../../src/db/chunker.ts";
import { compareVC } from "../../src/sync/vector-clock.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";

let counter = 0;
function uniqueDbName() { return `keep-local-baseline-${Date.now()}-${counter++}`; }

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

const PATH = "note.md";
const OTHER = "other.md";
const enc = new TextEncoder();
const OLD = Date.now() - 60_000;

/** Replicator stand-in: the orchestrator listens on `events`, and a fired
 *  conflict settles once the orchestrator has applied the choice. */
function makeReplicator() {
    const cbs: Record<string, Array<(p: any) => unknown>> = {};
    return {
        setConflictResolver: () => {},
        ensureFileChunks: async () => ({ stillMissing: [], remoteConsulted: true }),
        events: {
            on: (type: string, cb: (p: any) => unknown) => { (cbs[type] ??= []).push(cb); },
            emit: (type: string, p: any) => { for (const cb of cbs[type] ?? []) void cb(p); },
        },
        async fireConcurrent(filePath: string, localDoc: FileDoc, remoteDoc: FileDoc) {
            await Promise.all((cbs.concurrent ?? []).map((cb) => cb({ filePath, localDoc, remoteDoc })));
        },
    };
}

describe("regression: Keep Local on a pull conflict keeps the baseline in step", () => {
    let vault: FakeVaultIO;
    let db: LocalDB;
    let vs: VaultSync;
    let modal: FakeModalPresenter;
    let replicator: ReturnType<typeof makeReplicator>;
    let reported: { edit: string[]; delete: string[]; recreate: string[] };
    let reconciler: Reconciler;

    beforeEach(() => {
        vault = new FakeVaultIO();
        db = new LocalDB(uniqueDbName());
        db.open();
        const settings = makeSettings({ deviceId: "dev-B" });
        vs = new VaultSync(vault, db, () => settings, new PlainWriter(vault));
        modal = new FakeModalPresenter();
        replicator = makeReplicator();
        new ConflictOrchestrator({
            modal,
            localDb: db,
            replicator: replicator as any,
            historyCapture: { saveConflict: async () => {} } as any,
            dbToFile: (doc, opts) => vs.dbToFile(doc, opts),
            getSettings: () => settings,
            vault,
            vaultSync: vs,
            requestReconcile: () => {},
            batchThreshold: 2,
            batchDebounceMs: 20,
        }).register();
        reported = { edit: [], delete: [], recreate: [] };
        reconciler = new Reconciler({ getFiles: () => vault.getFiles() } as any, db, vs, () => settings);
        reconciler.setConflictOrchestrator({
            async handleDivergentLocalEdit(p: string) { reported.edit.push(p); },
            async handleDivergentLocalDelete(p: string) { reported.delete.push(p); },
            async handleDivergentRecreate(p: string) { reported.recreate.push(p); },
        } as any);
    });

    afterEach(async () => {
        await db.destroy();
    });

    const docOf = async (path: string) => (await db.get(makeFileId(path))) as FileDoc;

    /** A version of `base` with `text`, its chunks stored locally (a pull
     *  fetches them before it reports the conflict). */
    async function version(base: FileDoc, text: string, vclock: Record<string, number>): Promise<FileDoc> {
        const buf = enc.encode(text).buffer;
        const chunks = await splitIntoChunks(buf);
        await db.runWriteTx({ chunks: chunks as unknown as CouchSyncDoc[] });
        return { ...base, chunks: chunks.map((c) => c._id), size: buf.byteLength, vclock };
    }

    /** The file is synced: vault == LocalDB doc == baseline. */
    async function synced(path: string, text: string): Promise<FileDoc> {
        vault.addFile(path, text, { mtime: OLD });
        await vs.fileToDb(path);
        return docOf(path);
    }

    /** Another device's concurrent version of the file. */
    function remote(local: FileDoc, path: string): Promise<FileDoc> {
        return version(local, `remote of ${path}\n`, { "dev-A": 1 });
    }

    async function keepLocal(path: string, local: FileDoc, remoteDoc: FileDoc): Promise<FileDoc> {
        modal.conflictResponses.push({ choice: "keep-local", dismissed: false });
        await replicator.fireConcurrent(path, local, remoteDoc);
        return docOf(path);
    }

    function expectKept(kept: FileDoc, local: FileDoc, remoteDoc: FileDoc): void {
        expect(compareVC(kept.vclock, local.vclock)).toBe("dominates");
        expect(compareVC(kept.vclock, remoteDoc.vclock)).toBe("dominates");
        expect(kept.chunks).toEqual(local.chunks);
    }

    it("pushes an edit made right after Keep Local", async () => {
        const L = await synced(PATH, "local v1\n");
        const R = await remote(L, PATH);
        const K = await keepLocal(PATH, L, R);
        expectKept(K, L, R);
        expect(vs.getLastSynced(PATH)?.vclock).toEqual(K.vclock);

        vault.addFile(PATH, "edit after keep-local\n");
        expect(await vs.fileToDb(PATH)).toBe(true);
        const E = await docOf(PATH);
        expect(compareVC(E.vclock, K.vclock)).toBe("dominates");

        await reconciler.reconcile("manual");
        expect(reported).toEqual({ edit: [], delete: [], recreate: [] });
    });

    it("tombstones a deletion made right after Keep Local", async () => {
        const L = await synced(PATH, "local v1\n");
        const R = await remote(L, PATH);
        const K = await keepLocal(PATH, L, R);

        await vault.delete(PATH);
        await vs.markDeleted(PATH);
        const T = await docOf(PATH);
        expect(T.deleted).toBe(true);
        expect(compareVC(T.vclock, K.vclock)).toBe("dominates");

        await reconciler.reconcile("manual");
        expect(reported).toEqual({ edit: [], delete: [], recreate: [] });
    });

    it("offers no conflict at the next reconcile", async () => {
        const L = await synced(PATH, "local v1\n");
        const R = await remote(L, PATH);
        await keepLocal(PATH, L, R);

        await reconciler.reconcile("manual");
        expect(reported).toEqual({ edit: [], delete: [], recreate: [] });
        expect(vault.readText(PATH)).toBe("local v1\n");
    });

    it("keeps the baseline in step for Keep all local in the dialog for many conflicts", async () => {
        const L1 = await synced(PATH, "local v1\n");
        const L2 = await synced(OTHER, "other v1\n");
        const R1 = await remote(L1, PATH);
        const R2 = await remote(L2, OTHER);
        modal.batchResponses.push({ kind: "all-keep-local" });

        await Promise.all([
            replicator.fireConcurrent(PATH, L1, R1),
            replicator.fireConcurrent(OTHER, L2, R2),
        ]);
        expect(modal.batchCalls).toHaveLength(1);
        expectKept(await docOf(PATH), L1, R1);
        expectKept(await docOf(OTHER), L2, R2);

        vault.addFile(PATH, "edit after keep-local\n");
        expect(await vs.fileToDb(PATH)).toBe(true);
        await vault.delete(OTHER);
        await vs.markDeleted(OTHER);
        expect((await docOf(OTHER)).deleted).toBe(true);
    });

    it("writes the kept version to the vault when the vault does not hold it yet", async () => {
        // The local DB doc is ahead of the vault: a pulled version whose
        // vault write is still to come.
        const v1 = await synced(PATH, "v1\n");
        const L = await version(v1, "pulled v2\n", { ...v1.vclock, "dev-C": 1 });
        await db.runWriteTx({ docs: [{ doc: L as unknown as CouchSyncDoc }] });
        const R = await remote(L, PATH);

        const K = await keepLocal(PATH, L, R);
        expectKept(K, L, R);
        expect(vault.readText(PATH)).toBe("pulled v2\n");
        expect(vs.getLastSynced(PATH)?.vclock).toEqual(K.vclock);
        expect(vs.getLastSynced(PATH)?.chunks).toEqual(K.chunks);

        await reconciler.reconcile("manual");
        expect(reported).toEqual({ edit: [], delete: [], recreate: [] });
    });

    it("leaves a vault change not yet synced and offers it as a conflict", async () => {
        const v1 = await synced(PATH, "v1\n");
        const L = await version(v1, "pulled v2\n", { ...v1.vclock, "dev-C": 1 });
        await db.runWriteTx({ docs: [{ doc: L as unknown as CouchSyncDoc }] });
        const R = await remote(L, PATH);
        // An edit still in the push debounce window.
        vault.addFile(PATH, "user edit\n");

        const K = await keepLocal(PATH, L, R);
        expectKept(K, L, R);
        expect(vault.readText(PATH)).toBe("user edit\n");

        await reconciler.reconcile("manual");
        expect(reported.edit).toEqual([PATH]);
    });

    it("writes nothing when the local version moved after the dialog showed it, and asks again", async () => {
        const L = await synced(PATH, "local v1\n");
        const R = await remote(L, PATH);
        // The user edits while the dialog is open; the edit is pushed.
        vault.addFile(PATH, "edit while the dialog is open\n");
        expect(await vs.fileToDb(PATH)).toBe(true);
        const moved = await docOf(PATH);
        modal.conflictResponses.push(
            { choice: "keep-local", dismissed: false },
            { choice: "defer", dismissed: false },
        );

        await replicator.fireConcurrent(PATH, L, R);

        expect((await docOf(PATH)).vclock).toEqual(moved.vclock);
        expect(vs.getLastSynced(PATH)?.vclock).toEqual(moved.vclock);
        await vi.waitFor(() => expect(modal.conflictCalls).toHaveLength(2));
        const again = modal.conflictCalls[1].content;
        expect(again.kind === "text" && again.localText).toBe("edit while the dialog is open\n");
    });

    it("keeps a local deletion deleted, and pushes the file made again later", async () => {
        const L = await synced(PATH, "local v1\n");
        await vault.delete(PATH);
        await vs.markDeleted(PATH);
        const T = await docOf(PATH);
        expect(T.deleted).toBe(true);
        const R = await remote(L, PATH);

        const K = await keepLocal(PATH, T, R);
        expect(K.deleted).toBe(true);
        expect(compareVC(K.vclock, T.vclock)).toBe("dominates");
        expect(compareVC(K.vclock, R.vclock)).toBe("dominates");
        expect(vs.getLastSynced(PATH)).toMatchObject({ deleted: true, vclock: K.vclock });

        await reconciler.reconcile("manual");
        expect(reported).toEqual({ edit: [], delete: [], recreate: [] });
        expect(vault.files.has(PATH)).toBe(false);

        vault.addFile(PATH, "made again\n");
        expect(await vs.fileToDb(PATH)).toBe(true);
        const again = await docOf(PATH);
        expect(again.deleted).toBeFalsy();
        expect(compareVC(again.vclock, K.vclock)).toBe("dominates");
    });

    it("applies a kept deletion the vault does not hold yet", async () => {
        // The local DB holds a pulled tombstone whose vault deletion is
        // still to come; the vault still holds the synced file.
        const L = await synced(PATH, "local v1\n");
        const T = { ...L, deleted: true as const, vclock: { ...L.vclock, "dev-C": 1 } };
        await db.runWriteTx({ docs: [{ doc: T as unknown as CouchSyncDoc }] });
        const R = await remote(L, PATH);

        const K = await keepLocal(PATH, T, R);
        expect(K.deleted).toBe(true);
        expect(vault.files.has(PATH)).toBe(false);
        expect(vs.getLastSynced(PATH)).toMatchObject({ deleted: true, vclock: K.vclock });
    });
});
