/**
 * A pull must not write over a vault change that has not been synced.
 *
 * Shape of the reported case:
 *   1. The file is integrated (vault == LocalDB, baseline recorded).
 *   2. A pull advances the LocalDB doc, but the vault write is declined
 *      (IME composition) — LocalDB is ahead of the vault.
 *   3. The user edits the file. fileToDb's divergent guard refuses to push
 *      it, and reconcile reports the path as a vault-side conflict.
 *   4. Before the user answers, the other device edits the file again and a
 *      pull delivers that newer version.
 *
 * The newer doc dominates the LocalDB doc, so the pull accepts it and hands
 * it to dbToFile. dbToFile must see that the disk no longer holds the
 * baseline and leave the file alone; the reconcile then offers the user's
 * edit against the newest version.
 *
 * The other cases are the same rule on the other ways a pull reaches the
 * vault: a deletion, a recreate over the user's deletion, a change still in
 * the push debounce window, and the PendingApply retry.
 *
 * A file this device has no baseline for (made here before its first push,
 * or come into the filters) holds content never synced: a pulled version
 * with other content is offered as a conflict, the same content only
 * records the baseline.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { VaultSync } from "../../src/sync/vault-sync.ts";
import { Reconciler } from "../../src/sync/reconciler.ts";
import type { VaultWriter, WriteResult } from "../../src/sync/vault-writer.ts";
import { LocalDB } from "../../src/db/local-db.ts";
import { PullWriter } from "../../src/db/sync/pull-writer.ts";
import { EchoTracker } from "../../src/db/sync/echo-tracker.ts";
import { SyncEvents } from "../../src/db/sync/sync-events.ts";
import { Checkpoints } from "../../src/db/sync/checkpoints.ts";
import type { PendingApply } from "../../src/db/sync/pending-apply.ts";
import { ConflictResolver } from "../../src/conflict/conflict-resolver.ts";
import { FakeVaultIO } from "../helpers/fake-vault-io.ts";
import { makeSettings } from "../helpers/settings-factory.ts";
import { makePendingApply } from "../helpers/pending-apply.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import { splitIntoChunks } from "../../src/db/chunker.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";
import { FILE_SCHEMA_VERSION } from "../../src/types.ts";

let counter = 0;
function uniqueDbName() { return `pull-over-vault-conflict-${Date.now()}-${counter++}`; }

class ToggleVaultWriter implements VaultWriter {
    skip = false;
    constructor(private io: FakeVaultIO) {}
    async applyRemoteContent(path: string, content: ArrayBuffer): Promise<WriteResult> {
        if (this.skip) return { applied: false, reason: "composing" };
        await this.io.writeBinary(path, content);
        return { applied: true };
    }
    async applyRemoteDeletion(path: string): Promise<void> {
        if (await this.io.exists(path)) await this.io.delete(path);
    }
    async createFile(path: string, content: ArrayBuffer): Promise<void> {
        await this.io.createBinary(path, content);
    }
    flushAll(): void {}
}

const PATH = "note.md";
const enc = new TextEncoder();
const dec = new TextDecoder();

describe("regression: pull over a vault change not yet synced", () => {
    let vault: FakeVaultIO;
    let db: LocalDB;
    let vs: VaultSync;
    let writer: ToggleVaultWriter;
    let reported: { edit: string[]; delete: string[]; recreate: string[] };
    let reconciler: Reconciler;
    let settings: ReturnType<typeof makeSettings>;

    beforeEach(() => {
        vault = new FakeVaultIO();
        db = new LocalDB(uniqueDbName());
        db.open();
        writer = new ToggleVaultWriter(vault);
        settings = makeSettings({ deviceId: "dev-B" });
        vs = new VaultSync(vault, db, () => settings, writer);
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
        await db.destroy();
    });

    async function remoteVersion(
        base: FileDoc, text: string, vclock: Record<string, number>,
        opts: { deleted?: boolean } = {},
    ) {
        const buf = enc.encode(text).buffer;
        const chunks = await splitIntoChunks(buf);
        const doc: FileDoc = {
            ...base,
            chunks: chunks.map((c) => c._id),
            size: buf.byteLength,
            vclock,
            ...(opts.deleted ? { deleted: true } : {}),
        };
        return { doc, chunks: chunks as unknown as CouchSyncDoc[] };
    }

    function makePullWriter(pendingApply?: PendingApply): PullWriter {
        const applyPullWrite = (doc: FileDoc) => vs.dbToFile(doc);
        return new PullWriter({
            localDb: db,
            events: new SyncEvents(),
            echoes: new EchoTracker(),
            checkpoints: new Checkpoints(db),
            getConflictResolver: () => new ConflictResolver(),
            ensureChunks: async () => {},
            pendingApply: pendingApply ?? makePendingApply(db, { write: applyPullWrite }),
            getRemoteDoc: async () => null,
            applyPullWrite,
            probeUnpushed: async () => false,
        });
    }

    async function pull(doc: FileDoc, seq: string, pendingApply?: PendingApply): Promise<void> {
        await makePullWriter(pendingApply).apply({
            results: [{ id: doc._id, seq, doc: doc as unknown as CouchSyncDoc }],
            last_seq: seq,
        });
    }

    async function integrated(text: string): Promise<FileDoc> {
        vault.addFile(PATH, text);
        await vs.fileToDb(PATH);
        return await db.get(makeFileId(PATH)) as FileDoc;
    }

    /** A pull advances LocalDB while the vault write is declined (IME). */
    async function localDbAhead(v0: FileDoc): Promise<FileDoc> {
        const r1 = await remoteVersion(v0, "remote 1\n", { ...v0.vclock, "dev-A": 1 });
        await db.runWriteTx({ chunks: r1.chunks, docs: [{ doc: r1.doc as unknown as CouchSyncDoc }] });
        writer.skip = true;
        expect((await vs.dbToFile(r1.doc)).applied).toBe(false);
        writer.skip = false;
        return r1.doc;
    }

    it("keeps the user's vault edit when a newer remote version is pulled", async () => {
        // 1. integrated
        const v0 = await integrated("v0\n");

        // 2. pull advances LocalDB, vault write declined
        const r1 = await localDbAhead(v0);

        // 3. user edits; push refused; reconcile reports the conflict
        vault.addFile(PATH, "user edit\n");
        await vs.fileToDb(PATH);
        expect(((await db.get(makeFileId(PATH))) as FileDoc).vclock).toEqual(r1.vclock);
        await reconciler.reconcile("manual");
        expect(reported.edit).toEqual([PATH]);
        expect(dec.decode(await vault.readBinary(PATH))).toBe("user edit\n");

        // 4. the other device edits again; the pull delivers it
        const r2 = await remoteVersion(v0, "remote 2\n", { ...r1.vclock, "dev-A": 2 });
        await db.runWriteTx({ chunks: r2.chunks });
        await pull(r2.doc, "2");

        expect(dec.decode(await vault.readBinary(PATH))).toBe("user edit\n");
        // The newer version is kept in LocalDB and offered against the edit.
        expect(((await db.get(makeFileId(PATH))) as FileDoc).chunks).toEqual(r2.doc.chunks);
        await reconciler.reconcile("manual");
        expect(reported.edit).toEqual([PATH, PATH]);
    });

    it("keeps an edit still waiting for its push when a newer version is pulled", async () => {
        // The modify event's debounced fileToDb has not run yet: LocalDB
        // still equals the baseline, and the pulled doc dominates it.
        const v0 = await integrated("v0\n");
        vault.addFile(PATH, "typing\n");
        const r1 = await remoteVersion(v0, "remote 1\n", { ...v0.vclock, "dev-A": 1 });
        await db.runWriteTx({ chunks: r1.chunks });

        await pull(r1.doc, "1");

        expect(dec.decode(await vault.readBinary(PATH))).toBe("typing\n");
        // The debounced push then runs and declines; the reconcile offers it.
        expect(await vs.fileToDb(PATH)).toBe(false);
        await reconciler.reconcile("manual");
        expect(reported.edit).toEqual([PATH]);
    });

    it("keeps an edited file when a remote deletion is pulled", async () => {
        const v0 = await integrated("v0\n");
        vault.addFile(PATH, "typing\n");
        const tomb = await remoteVersion(v0, "v0\n", { ...v0.vclock, "dev-A": 1 }, { deleted: true });

        await pull(tomb.doc, "1");

        expect(dec.decode(await vault.readBinary(PATH))).toBe("typing\n");
        expect(vs.getLastSynced(PATH)?.deleted).toBeUndefined();
        await reconciler.reconcile("manual");
        expect(reported.recreate).toEqual([PATH]);
    });

    it("does not recreate a file the user deleted while LocalDB was ahead", async () => {
        const v0 = await integrated("v0\n");
        const r1 = await localDbAhead(v0);

        // The user deletes the file; markDeleted refuses (pending pull).
        vault.files.delete(PATH);
        await vs.markDeleted(PATH);
        expect(((await db.get(makeFileId(PATH))) as FileDoc).deleted).toBeUndefined();

        const r2 = await remoteVersion(v0, "remote 2\n", { ...r1.vclock, "dev-A": 2 });
        await db.runWriteTx({ chunks: r2.chunks });
        await pull(r2.doc, "2");

        expect(vault.files.has(PATH)).toBe(false);
        await reconciler.reconcile("manual");
        expect(reported.delete).toEqual([PATH]);
    });

    it("the PendingApply retry does not write over an edit made meanwhile", async () => {
        const v0 = await integrated("v0\n");
        const applyPullWrite = (doc: FileDoc) => vs.dbToFile(doc);
        const pendingApply = makePendingApply(db, { write: applyPullWrite });

        // The pull lands the doc but its chunks are missing: recorded.
        const r1 = await remoteVersion(v0, "remote 1\n", { ...v0.vclock, "dev-A": 1 });
        await pull(r1.doc, "1", pendingApply);
        expect(await pendingApply.has(r1.doc._id)).toBe(true);

        // The user edits; then the chunks arrive and the retry runs.
        vault.addFile(PATH, "user edit\n");
        await db.runWriteTx({ chunks: r1.chunks });
        await pendingApply.drain();

        expect(dec.decode(await vault.readBinary(PATH))).toBe("user edit\n");
        await reconciler.reconcile("manual");
        expect(reported.edit).toEqual([PATH]);
    });

    it("writes the pulled version when the vault still holds the baseline", async () => {
        const v0 = await integrated("v0\n");
        const r1 = await localDbAhead(v0);
        const r2 = await remoteVersion(v0, "remote 2\n", { ...r1.vclock, "dev-A": 2 });
        await db.runWriteTx({ chunks: r2.chunks });

        await pull(r2.doc, "2");

        expect(dec.decode(await vault.readBinary(PATH))).toBe("remote 2\n");
        expect(vs.getLastSynced(PATH)?.chunks).toEqual(r2.doc.chunks);
    });

    describe("a file this device has no baseline for", () => {
        /** Another device's version of `path`, never seen here. */
        async function foreignDoc(path: string, text: string) {
            const base: FileDoc = {
                _id: makeFileId(path), schemaVersion: FILE_SCHEMA_VERSION, type: "file",
                chunks: [], mtime: 1, ctime: 1, size: 0, vclock: {},
            };
            return remoteVersion(base, text, { "dev-A": 1 });
        }

        it("keeps a file made here before its first push and offers it against the pulled one", async () => {
            vault.addFile(PATH, "made here\n");
            const theirs = await foreignDoc(PATH, "made there\n");
            await db.runWriteTx({ chunks: theirs.chunks });

            await pull(theirs.doc, "1");

            expect(dec.decode(await vault.readBinary(PATH))).toBe("made here\n");
            expect(vs.getLastSynced(PATH)).toBeUndefined();
            // The debounced push then declines; the reconcile offers it.
            expect(await vs.fileToDb(PATH)).toBe(false);
            await reconciler.reconcile("manual");
            expect(reported.edit).toEqual([PATH]);
            expect(dec.decode(await vault.readBinary(PATH))).toBe("made here\n");
        });

        it("records the baseline when the pulled version has the same content", async () => {
            vault.addFile(PATH, "same\n");
            const theirs = await foreignDoc(PATH, "same\n");
            await db.runWriteTx({ chunks: theirs.chunks });

            await pull(theirs.doc, "1");

            expect(vs.getLastSynced(PATH)?.vclock).toEqual(theirs.doc.vclock);
            expect(await vs.fileToDb(PATH)).toBe(false);
            const report = await reconciler.reconcile("manual");
            expect(reported).toEqual({ edit: [], delete: [], recreate: [] });
            expect(report.inSync).toBe(1);
            expect(((await db.get(makeFileId(PATH))) as FileDoc).vclock).toEqual(theirs.doc.vclock);
        });

        it("asks nothing about filtered paths, and asks only about differing content once they come in", async () => {
            settings.syncFilter = "^notes/";
            const paths = {
                differs: "inbox/differs.md",
                same: "inbox/same.md",
                remoteOnly: "inbox/remote-only.md",
                localOnly: "inbox/local-only.md",
            };
            vault.addFile(paths.differs, "mine\n");
            vault.addFile(paths.same, "same\n");
            vault.addFile(paths.localOnly, "only here\n");
            const docs = [
                await foreignDoc(paths.differs, "theirs\n"),
                await foreignDoc(paths.same, "same\n"),
                await foreignDoc(paths.remoteOnly, "only there\n"),
            ];
            for (const [i, d] of docs.entries()) {
                await db.runWriteTx({ chunks: d.chunks });
                await pull(d.doc, String(i + 1));
            }

            // Filtered: the pull wrote nothing and the reconcile asks nothing.
            await reconciler.reconcile("manual");
            expect(reported).toEqual({ edit: [], delete: [], recreate: [] });
            expect(vault.readText(paths.differs)).toBe("mine\n");
            expect(vault.files.has(paths.remoteOnly)).toBe(false);

            // The filter widens: only the differing file is a conflict.
            settings.syncFilter = "";
            await reconciler.reconcile("manual");
            expect(reported).toEqual({ edit: [paths.differs], delete: [], recreate: [] });
            expect(vault.readText(paths.differs)).toBe("mine\n");
            expect(vs.getLastSynced(paths.same)?.vclock).toEqual(docs[1].doc.vclock);
            expect(vault.readText(paths.remoteOnly)).toBe("only there\n");
            expect(((await db.get(makeFileId(paths.localOnly))) as FileDoc).vclock).toEqual({ "dev-B": 1 });
        });
    });
});
