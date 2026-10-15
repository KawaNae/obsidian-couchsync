import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ConflictOrchestrator } from "../src/conflict/conflict-orchestrator.ts";
import { LocalDB } from "../src/db/local-db.ts";
import { FakeModalPresenter } from "./helpers/fake-modal-presenter.ts";
import { makeSettings } from "./helpers/settings-factory.ts";
import { makeFileId } from "../src/types/doc-id.ts";
import { splitIntoChunks } from "../src/db/chunker.ts";
import {
    pendingConflictKey,
    loadAllPendingConflict,
} from "../src/db/sync/pending-conflict.ts";
import type { FileDoc, CouchSyncDoc, ChunkDoc } from "../src/types.ts";
import type { DbToFileOptions } from "../src/sync/vault-sync.ts";
import { incrementVC, mergeVC } from "../src/sync/vector-clock.ts";

/**
 * Serve the docs' chunks from memory. The orchestrator reads both sides'
 * chunks before it queues a conflict, and the drain timer starts at the
 * first queued conflict. Reads through fake-indexeddb cross macrotasks, so
 * under load a read can finish after a 0 ms timer and a burst splits into
 * several groups. Reads that resolve as microtasks all finish before any
 * timer, so the burst is queued whole, as a test of batching needs.
 */
async function serveChunksFromMemory(db: LocalDB, docs: FileDoc[]): Promise<void> {
    const ids = [...new Set(docs.flatMap((d) => d.chunks))];
    const byId = new Map((await db.getChunks(ids)).map((c) => [c._id, c]));
    (db as any).getChunks = (want: string[]) =>
        Promise.resolve(want.map((id) => byId.get(id)).filter((c) => c !== undefined));
}

let counter = 0;
function uniqueDbName() { return `conflict-orch-test-${Date.now()}-${counter++}`; }

/** Create a FileDoc with real chunks in the DB. */
async function seedFileDoc(
    db: LocalDB,
    path: string,
    content: string | Uint8Array,
    vclock: Record<string, number>,
): Promise<FileDoc> {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const chunks = await splitIntoChunks(buf);
    const fileDoc: FileDoc = {
        _id: makeFileId(path),
        type: "file",
        chunks: chunks.map((c) => c._id),
        mtime: Date.now(),
        ctime: Date.now(),
        size: buf.byteLength,
        vclock,
    };
    await db.runWriteTx({
        docs: [{ doc: fileDoc as unknown as CouchSyncDoc }],
        chunks: chunks as unknown as CouchSyncDoc[],
    });
    return fileDoc;
}

describe("ConflictOrchestrator", () => {
    let db: LocalDB;
    let modal: FakeModalPresenter;
    let settings: ReturnType<typeof makeSettings>;
    /** The docs the stubbed VaultSync wrote to the vault (its dbToFile
     *  calls), and the options of each write. */
    let dbToFileCalls: FileDoc[];
    let dbToFileOpts: Array<DbToFileOptions | undefined>;
    let saveConflictCalls: any[];
    /** What the stubbed VaultSync.keepLocalDoc answers, and its calls. */
    let keepLocalAnswer: "written" | "stale";
    let keepLocalCalls: Array<[string, Record<string, number>, Record<string, number>]>;
    /** Runs when the stubbed keepLocalDoc answers "written", to play the
     *  commit VaultSync makes. */
    let onKeepLocalWritten: ((path: string, seen: Record<string, number>, remote: Record<string, number>) => Promise<void>) | null;
    /** What the stubbed take-remote writes of VaultSync answer, and their
     *  expected vclocks. "written" plays the write: takeRemoteDoc commits
     *  the doc and both write it to the vault. */
    let takeRemoteAnswer: "written" | "stale";
    let takeRemoteExpected: Array<Record<string, number>>;
    const vaultSyncStub = () => ({
        takeRemoteDoc: async (_path: string, seen: Record<string, number>, taken: FileDoc) => {
            takeRemoteExpected.push(seen);
            if (takeRemoteAnswer === "written") {
                await db.runWriteTx({ docs: [{ doc: taken as unknown as CouchSyncDoc }] });
                dbToFileCalls.push(taken);
                dbToFileOpts.push(undefined);
            }
            return takeRemoteAnswer;
        },
        takeDocToVault: async (path: string, seen: Record<string, number>) => {
            takeRemoteExpected.push(seen);
            if (takeRemoteAnswer === "written") {
                dbToFileCalls.push((await db.get(makeFileId(path))) as FileDoc);
                dbToFileOpts.push({ overwriteVaultChange: true });
            }
            return takeRemoteAnswer;
        },
        keepLocalDoc: async (path: string, seen: Record<string, number>, remote: Record<string, number>) => {
            keepLocalCalls.push([path, seen, remote]);
            if (keepLocalAnswer === "written" && onKeepLocalWritten) {
                await onKeepLocalWritten(path, seen, remote);
            }
            return keepLocalAnswer;
        },
    });

    /** Minimal SyncEngine stub */
    function makeReplicator() {
        const cbs: Record<string, Array<(p: any) => void | Promise<void>>> = {};
        const on = (type: string, cb: (p: any) => void | Promise<void>) => {
            (cbs[type] ??= []).push(cb);
        };
        const emit = (type: string, payload: any) => {
            for (const cb of cbs[type] ?? []) cb(payload);
        };
        // Test helper: fire and await any handler promise so assertions
        // see the post-handler DB state. ConflictOrchestrator returns the
        // handleConcurrent promise from its `on` subscriber so this works.
        const emitAndSettle = async (type: string, payload: any) => {
            await Promise.all(
                (cbs[type] ?? []).map(async (cb) => {
                    try {
                        const r = cb(payload);
                        if (r && typeof (r as any).then === "function") await r;
                    } catch { /* match production: log & swallow */ }
                }),
            );
        };
        return {
            setConflictResolver: vi.fn(),
            events: {
                on,
                emit,
            },
            ensureFileChunks: vi.fn().mockResolvedValue(undefined),
            fireConcurrent: (path: string, local: CouchSyncDoc, remote: CouchSyncDoc) =>
                emitAndSettle("concurrent", { filePath: path, localDoc: local, remoteDoc: remote }),
            fireAutoResolve: (path: string) =>
                emitAndSettle("auto-resolve", { filePath: path }),
        };
    }

    beforeEach(() => {
        db = new LocalDB(uniqueDbName());
        db.open();
        modal = new FakeModalPresenter();
        settings = makeSettings({ deviceId: "dev-A" });
        dbToFileCalls = [];
        dbToFileOpts = [];
        saveConflictCalls = [];
        keepLocalAnswer = "written";
        keepLocalCalls = [];
        onKeepLocalWritten = null;
        takeRemoteAnswer = "written";
        takeRemoteExpected = [];
    });

    afterEach(async () => {
        await db.destroy();
    });

    function createOrchestrator(
        replicator: ReturnType<typeof makeReplicator>,
        vaultContent: string | Uint8Array = "",
    ) {
        const vaultBytes = typeof vaultContent === "string"
            ? new TextEncoder().encode(vaultContent)
            : vaultContent;
        const historyCapture = {
            saveConflict: async (...args: any[]) => { saveConflictCalls.push(args); },
        };
        const orch = new ConflictOrchestrator({
            modal,
            localDb: db as any,
            replicator: replicator as any,
            historyCapture: historyCapture as any,
            vault: { readBinary: async () => vaultBytes.slice().buffer } as any,
            vaultSync: vaultSyncStub() as any,
            requestReconcile: () => {},
            getSettings: () => settings,
            // Drain on the next macrotask so single-conflict tests don't wait
            // the production debounce; a synchronous burst still coalesces.
            batchDebounceMs: 0,
        });
        orch.register();
        return orch;
    }

    it("keep-local keeps the local DB doc the modal showed, through VaultSync", async () => {
        const replicator = makeReplicator();
        createOrchestrator(replicator);

        const localDoc = await seedFileDoc(db, "a.md", "local text", { "dev-A": 2 });
        const remoteDoc = await seedFileDoc(db, "a.md", "remote text", { "dev-B": 1 });

        modal.conflictResponses.push({ choice: "keep-local", dismissed: false });

        await replicator.fireConcurrent("a.md", localDoc, remoteDoc);

        expect(keepLocalCalls).toEqual([["a.md", { "dev-A": 2 }, { "dev-B": 1 }]]);
        // The orchestrator writes no doc itself and no remote version.
        expect(((await db.get(makeFileId("a.md"))) as FileDoc).vclock).toEqual({ "dev-B": 1 });
        expect(dbToFileCalls).toHaveLength(0);

        // History recorded
        expect(saveConflictCalls).toHaveLength(1);
        expect(saveConflictCalls[0][3]).toBe("local"); // winner
    });

    it("keep-local of a version replaced meanwhile keeps the record and asks again", async () => {
        const replicator = makeReplicator();
        createOrchestrator(replicator);

        const localDoc = await seedFileDoc(db, "a.md", "local text", { "dev-A": 2 });
        const remoteDoc = await seedFileDoc(db, "a.md", "remote text", { "dev-B": 1 });
        // The local DB doc moved past what the modal showed.
        await seedFileDoc(db, "a.md", "local edited", { "dev-A": 3 });
        await db.runWriteTx({
            meta: [{
                op: "put",
                key: pendingConflictKey(makeFileId("a.md")),
                value: { addedAt: Date.now(), kind: "edit-vs-edit" },
            }],
        });
        keepLocalAnswer = "stale";
        modal.conflictResponses.push(
            { choice: "keep-local", dismissed: false },
            { choice: "defer", dismissed: false },
        );

        await replicator.fireConcurrent("a.md", localDoc, remoteDoc);

        expect(saveConflictCalls).toHaveLength(0);
        expect(await loadAllPendingConflict(db as any)).toHaveLength(1);
        await vi.waitFor(() => expect(modal.conflictCalls).toHaveLength(2));
        expect(modal.conflictCalls[1].content).toEqual({
            kind: "text", localText: "local edited", remoteText: "remote text",
        });
    });

    describe("a remote version that arrives while its conflict is open", () => {
        /** Commit the kept local content with the remote clock merged in,
         *  as VaultSync does for Keep Local. */
        function keepLocalCommits(content: string): void {
            onKeepLocalWritten = async (path, seen, remote) => {
                await seedFileDoc(db, path, content, incrementVC(mergeVC(remote, seen), "dev-A"));
            };
        }

        /** Open the modal for (local, remote), deliver `arriving` while it is
         *  open, answer `choice`, and let the re-check run. */
        async function resolveWithArrival(
            replicator: ReturnType<typeof makeReplicator>,
            localDoc: FileDoc,
            remoteDoc: FileDoc,
            arriving: FileDoc,
            choice: "keep-local" | "take-remote",
        ): Promise<void> {
            const first = replicator.fireConcurrent("a.md", localDoc, remoteDoc);
            await vi.waitFor(() => expect(modal.conflictCalls).toHaveLength(1));
            await replicator.fireConcurrent("a.md", localDoc, arriving);
            modal.answerConflict("a.md", choice);
            await first;
            await new Promise((r) => setTimeout(r, 20));
        }

        it("is not offered again after Keep Local took the same remote in", async () => {
            const replicator = makeReplicator();
            createOrchestrator(replicator);
            const remoteDoc = await seedFileDoc(db, "a.md", "remote text", { "dev-B": 1 });
            const localDoc = await seedFileDoc(db, "a.md", "local text", { "dev-A": 2 });
            keepLocalCommits("local text");

            await resolveWithArrival(replicator, localDoc, remoteDoc, remoteDoc, "keep-local");

            expect(modal.conflictCalls).toHaveLength(1);
            expect(keepLocalCalls).toHaveLength(1);
            expect(dbToFileCalls).toHaveLength(0);
            expect(((await db.get(makeFileId("a.md"))) as FileDoc).vclock)
                .toEqual({ "dev-A": 3, "dev-B": 1 });
        });

        it("is not offered again after Take Remote adopted it", async () => {
            const replicator = makeReplicator();
            createOrchestrator(replicator);
            const remoteDoc = await seedFileDoc(db, "a.md", "remote text", { "dev-B": 1 });
            const localDoc = await seedFileDoc(db, "a.md", "local text", { "dev-A": 2 });

            await resolveWithArrival(replicator, localDoc, remoteDoc, remoteDoc, "take-remote");

            expect(modal.conflictCalls).toHaveLength(1);
            expect(dbToFileCalls).toHaveLength(1);
        });

        it("is offered again when it is newer than what Keep Local took in", async () => {
            const replicator = makeReplicator();
            createOrchestrator(replicator);
            const remoteDoc = await seedFileDoc(db, "a.md", "remote text", { "dev-B": 1 });
            const newerRemote = await seedFileDoc(db, "a.md", "remote newer", { "dev-B": 2 });
            const localDoc = await seedFileDoc(db, "a.md", "local text", { "dev-A": 2 });
            keepLocalCommits("local text");

            await resolveWithArrival(replicator, localDoc, remoteDoc, newerRemote, "keep-local");

            await vi.waitFor(() => expect(modal.conflictCalls).toHaveLength(2));
            expect(modal.conflictCalls[1].content).toEqual({
                kind: "text", localText: "local text", remoteText: "remote newer",
            });
        });

        it("is offered again when it is a remote deletion and the local edit was kept", async () => {
            // A pulled hard-deletion arrives as a tombstone with an empty
            // vclock, which says nothing about what the deleting device saw.
            const replicator = makeReplicator();
            createOrchestrator(replicator);
            const remoteDoc = await seedFileDoc(db, "a.md", "remote text", { "dev-B": 1 });
            const localDoc = await seedFileDoc(db, "a.md", "local text", { "dev-A": 2 });
            keepLocalCommits("local text");
            const deletion: FileDoc = {
                _id: localDoc._id, type: "file", chunks: [], mtime: localDoc.mtime,
                ctime: localDoc.ctime, size: 0, deleted: true, vclock: {},
            };

            await resolveWithArrival(replicator, localDoc, remoteDoc, deletion, "keep-local");

            await vi.waitFor(() => expect(modal.conflictCalls).toHaveLength(2));
        });
    });

    it("take-remote of a version replaced meanwhile keeps the record and asks again", async () => {
        const replicator = makeReplicator();
        createOrchestrator(replicator);

        const localDoc = await seedFileDoc(db, "a.md", "local text", { "dev-A": 2 });
        const remoteDoc = await seedFileDoc(db, "a.md", "remote text", { "dev-B": 1 });
        // The local DB doc moved past what the modal showed.
        await seedFileDoc(db, "a.md", "local edited", { "dev-A": 3 });
        await db.runWriteTx({
            meta: [{
                op: "put",
                key: pendingConflictKey(makeFileId("a.md")),
                value: { addedAt: Date.now(), kind: "edit-vs-edit" },
            }],
        });
        takeRemoteAnswer = "stale";
        modal.conflictResponses.push(
            { choice: "take-remote", dismissed: false },
            { choice: "defer", dismissed: false },
        );

        await replicator.fireConcurrent("a.md", localDoc, remoteDoc);

        expect(takeRemoteExpected[0]).toEqual({ "dev-A": 2 });
        expect(saveConflictCalls).toHaveLength(0);
        expect(await loadAllPendingConflict(db as any)).toHaveLength(1);
        await vi.waitFor(() => expect(modal.conflictCalls).toHaveLength(2));
        expect(modal.conflictCalls[1].content).toEqual({
            kind: "text", localText: "local edited", remoteText: "remote text",
        });
    });

    it("take-remote writes remote doc to vault", async () => {
        const replicator = makeReplicator();
        createOrchestrator(replicator);

        const localDoc = await seedFileDoc(db, "a.md", "local text", { "dev-A": 1 });
        const remoteDoc = await seedFileDoc(db, "a.md", "remote text", { "dev-B": 1 });

        modal.conflictResponses.push({ choice: "take-remote", dismissed: false });

        await replicator.fireConcurrent("a.md", localDoc, remoteDoc);

        // dbToFile should have been called with the remote doc.
        // Chunks-equal vclock authority: non-deletion take-remote adopts remote vclock
        // verbatim — no self-component added, no merge with local.
        expect(dbToFileCalls).toHaveLength(1);
        expect(dbToFileCalls[0].vclock).toEqual({ "dev-B": 1 });

        // History recorded
        expect(saveConflictCalls).toHaveLength(1);
        expect(saveConflictCalls[0][3]).toBe("remote"); // winner
    });

    it("take-remote of a pull conflict does not replace a vault change", async () => {
        // The modal compared the local DB doc with the remote, not the
        // vault's version: dbToFile keeps a vault change and the reconcile
        // offers it.
        const replicator = makeReplicator();
        createOrchestrator(replicator);
        const localDoc = await seedFileDoc(db, "a.md", "local text", { "dev-A": 1 });
        const remoteDoc = await seedFileDoc(db, "a.md", "remote text", { "dev-B": 1 });
        modal.conflictResponses.push({ choice: "take-remote", dismissed: false });

        await replicator.fireConcurrent("a.md", localDoc, remoteDoc);

        expect(dbToFileCalls).toHaveLength(1);
        expect(dbToFileOpts[0]?.overwriteVaultChange).toBeUndefined();
    });

    describe("take-remote of a conflict with the vault's version", () => {
        async function answerTakeRemote(run: () => Promise<void>): Promise<void> {
            modal.conflictResponses.push({ choice: "take-remote", dismissed: false });
            await run();
        }

        it("replaces the vault's edit (divergent edit)", async () => {
            const orch = createOrchestrator(makeReplicator(), "my edit");
            const remoteDoc = await seedFileDoc(db, "a.md", "remote text", { "dev-B": 1 });

            await answerTakeRemote(() => orch.handleDivergentLocalEdit("a.md", remoteDoc));

            expect(dbToFileCalls.map((d) => d._id)).toEqual([remoteDoc._id]);
            expect(dbToFileOpts[0]).toEqual({ overwriteVaultChange: true });
        });

        it("restores over the vault's deletion (divergent delete)", async () => {
            const orch = createOrchestrator(makeReplicator());
            const remoteDoc = await seedFileDoc(db, "a.md", "remote text", { "dev-B": 1 });

            await answerTakeRemote(() => orch.handleDivergentLocalDelete("a.md", remoteDoc));

            expect(dbToFileOpts[0]).toEqual({ overwriteVaultChange: true });
        });

        it("deletes the vault's recreated file (divergent recreate)", async () => {
            const orch = createOrchestrator(makeReplicator(), "made again");
            const tombstone = {
                ...(await seedFileDoc(db, "a.md", "old", { "dev-B": 1 })),
                deleted: true,
            } as FileDoc;

            await answerTakeRemote(() => orch.handleDivergentRecreate("a.md", tombstone));

            expect(dbToFileOpts[0]).toEqual({ overwriteVaultChange: true });
        });
    });

    it("suppresses a duplicate concurrent modal while one is already in flight (re-emit dedup)", async () => {
        const replicator = makeReplicator();
        createOrchestrator(replicator);

        const localDoc = await seedFileDoc(db, "a.md", "local edit", { "dev-A": 2 });
        const remoteDoc = await seedFileDoc(db, "a.md", "remote", { "dev-B": 1 });

        // Fire #1 with NO response queued → its modal stays open (in flight).
        const p1 = replicator.fireConcurrent("a.md", localDoc, remoteDoc);
        await new Promise((r) => setTimeout(r, 10)); // let the modal open + inFlight set

        // A fresh sync session's pending-conflict drain (or a reconnect) re-emits
        // the SAME conflict while the first modal is still open. Without the
        // in-flight guard this stacked a second modal (observed live: 33 modals).
        await replicator.fireConcurrent("a.md", localDoc, remoteDoc);
        expect(modal.conflictCalls.filter((c) => c.filePath === "a.md")).toHaveLength(1);

        // Resolve the open modal → the in-flight guard releases.
        modal.dismissConflict("a.md");
        await p1;

        // A later re-emit (after resolution) is allowed to surface again.
        replicator.fireConcurrent("a.md", localDoc, remoteDoc);
        await new Promise((r) => setTimeout(r, 10));
        expect(modal.conflictCalls.filter((c) => c.filePath === "a.md").length).toBeGreaterThanOrEqual(2);
    });

    it("defer applies nothing and KEEPS the durable pending-conflict record", async () => {
        const replicator = makeReplicator();
        createOrchestrator(replicator);

        const localDoc = await seedFileDoc(db, "a.md", "local text", { "dev-A": 2 });
        const remoteDoc = await seedFileDoc(db, "a.md", "remote text", { "dev-B": 1 });

        // The pull writer persisted this edit-vs-edit conflict with the cursor advance.
        await db.runWriteTx({
            meta: [{
                op: "put",
                key: pendingConflictKey(makeFileId("a.md")),
                value: { addedAt: Date.now(), kind: "edit-vs-edit" },
            }],
        });

        // User closes the modal without choosing (× / Esc / Later) → defer.
        modal.conflictResponses.push({ choice: "defer", dismissed: false });
        await replicator.fireConcurrent("a.md", localDoc, remoteDoc);

        // NOTHING applied: no vault write, no history, no vclock change.
        expect(dbToFileCalls).toHaveLength(0);
        expect(saveConflictCalls).toHaveLength(0);
        const result = await db.get(makeFileId("a.md")) as FileDoc;
        expect(result.vclock).toEqual({ "dev-B": 1 }); // unchanged from last seed

        // The durable record SURVIVES so the pull drain re-presents it.
        const pending = await loadAllPendingConflict(db as any);
        expect(pending).toHaveLength(1);
        expect(pending[0].entry.kind).toBe("edit-vs-edit");
    });

    it("keep-local CLEARS the durable pending-conflict record", async () => {
        const replicator = makeReplicator();
        createOrchestrator(replicator);

        const localDoc = await seedFileDoc(db, "a.md", "local text", { "dev-A": 2 });
        const remoteDoc = await seedFileDoc(db, "a.md", "remote text", { "dev-B": 1 });
        await db.runWriteTx({
            meta: [{
                op: "put",
                key: pendingConflictKey(makeFileId("a.md")),
                value: { addedAt: Date.now(), kind: "edit-vs-edit" },
            }],
        });

        modal.conflictResponses.push({ choice: "keep-local", dismissed: false });
        await replicator.fireConcurrent("a.md", localDoc, remoteDoc);

        // Resolved → durable record dropped.
        const pending = await loadAllPendingConflict(db as any);
        expect(pending).toHaveLength(0);
    });

    it("auto-dismiss does not apply choice", async () => {
        const replicator = makeReplicator();
        createOrchestrator(replicator);

        const localDoc = await seedFileDoc(db, "a.md", "local", { "dev-A": 1 });
        const remoteDoc = await seedFileDoc(db, "a.md", "remote", { "dev-B": 1 });

        // Don't queue a response — let the dismiss resolve it.
        // fireConcurrent runs async; we need to let the modal open first.
        const concurrentPromise = replicator.fireConcurrent("a.md", localDoc, remoteDoc);

        // Yield to let handleConcurrent reach the modal.showConflictModal await
        await new Promise((r) => setTimeout(r, 10));

        // Simulate auto-resolve from another device
        modal.dismissConflict("a.md");

        await concurrentPromise;

        // No choice applied, no history saved
        expect(dbToFileCalls).toHaveLength(0);
        expect(saveConflictCalls).toHaveLength(0);
    });

    it("batches ≥ threshold conflicts into a SINGLE modal (no stacking)", async () => {
        const replicator = makeReplicator();
        // Lower the threshold so the test stays small.
        const historyCapture = { saveConflict: async (...a: any[]) => { saveConflictCalls.push(a); } };
        const orch = new ConflictOrchestrator({
            modal, localDb: db as any, replicator: replicator as any,
            historyCapture: historyCapture as any,
            vaultSync: vaultSyncStub() as any,
            getSettings: () => settings,
            batchDebounceMs: 0,
            batchThreshold: 3,
        });
        orch.register();

        // Seed 4 concurrent file conflicts.
        const docs: Array<{ local: FileDoc; remote: FileDoc; path: string }> = [];
        for (let i = 0; i < 4; i++) {
            const path = `n${i}.md`;
            const local = await seedFileDoc(db, path, `local ${i}`, { "dev-A": 2 });
            const remote = await seedFileDoc(db, path, `remote ${i}`, { "dev-B": 1 });
            docs.push({ local, remote, path });
        }

        await serveChunksFromMemory(db, docs.flatMap((d) => [d.local, d.remote]));

        // Batch decision: take all remote (with confirm).
        modal.batchResponses.push({ kind: "all-take-remote" });
        modal.confirmResponses.push(true);

        // Fire all 4 in a synchronous burst (as emitConcurrent does).
        await Promise.all(docs.map((d) =>
            replicator.fireConcurrent(d.path, d.local, d.remote)));

        // Exactly ONE batch modal, ZERO individual modals.
        expect(modal.batchCalls).toHaveLength(1);
        expect(modal.batchCalls[0]).toHaveLength(4);
        expect(modal.conflictCalls).toHaveLength(0);
        // Destructive bulk gated behind a confirm.
        expect(modal.confirmCalls).toHaveLength(1);
        // All 4 applied take-remote (dbToFile called per item).
        expect(dbToFileCalls).toHaveLength(4);
    });

    it("batch all-defer applies nothing and keeps every durable record", async () => {
        const replicator = makeReplicator();
        const historyCapture = { saveConflict: async (...a: any[]) => { saveConflictCalls.push(a); } };
        const orch = new ConflictOrchestrator({
            modal, localDb: db as any, replicator: replicator as any,
            historyCapture: historyCapture as any,
            vaultSync: vaultSyncStub() as any,
            getSettings: () => settings,
            batchDebounceMs: 0,
            batchThreshold: 3,
        });
        orch.register();

        const docs: Array<{ local: FileDoc; remote: FileDoc; path: string }> = [];
        for (let i = 0; i < 4; i++) {
            const path = `d${i}.md`;
            const local = await seedFileDoc(db, path, `local ${i}`, { "dev-A": 2 });
            const remote = await seedFileDoc(db, path, `remote ${i}`, { "dev-B": 1 });
            await db.runWriteTx({
                meta: [{
                    op: "put", key: pendingConflictKey(makeFileId(path)),
                    value: { addedAt: Date.now(), kind: "edit-vs-edit" },
                }],
            });
            docs.push({ local, remote, path });
        }
        await serveChunksFromMemory(db, docs.flatMap((d) => [d.local, d.remote]));
        modal.batchResponses.push({ kind: "all-defer" });
        // Fire all 4 in a synchronous burst so they coalesce into one batch.
        await Promise.all(docs.map((d) =>
            replicator.fireConcurrent(d.path, d.local, d.remote)));

        expect(modal.batchCalls).toHaveLength(1);
        expect(dbToFileCalls).toHaveLength(0);
        expect(saveConflictCalls).toHaveLength(0);
        // Every durable record survives → re-presented next session.
        const pending = await loadAllPendingConflict(db as any);
        expect(pending).toHaveLength(4);
    });

    it("batch all-keep-local keeps each local DB doc through VaultSync", async () => {
        const replicator = makeReplicator();
        const orch = new ConflictOrchestrator({
            modal, localDb: db as any, replicator: replicator as any,
            historyCapture: { saveConflict: async (...a: any[]) => { saveConflictCalls.push(a); } } as any,
            vaultSync: vaultSyncStub() as any,
            getSettings: () => settings,
            vault: {} as any,
            vaultSync: vaultSyncStub() as any,
            requestReconcile: () => {},
            batchDebounceMs: 0,
            batchThreshold: 3,
        });
        orch.register();

        const docs: Array<{ local: FileDoc; remote: FileDoc; path: string }> = [];
        for (let i = 0; i < 3; i++) {
            const path = `k${i}.md`;
            const local = await seedFileDoc(db, path, `local ${i}`, { "dev-A": 2 });
            const remote = await seedFileDoc(db, path, `remote ${i}`, { "dev-B": 1 });
            docs.push({ local, remote, path });
        }
        await serveChunksFromMemory(db, docs.flatMap((d) => [d.local, d.remote]));
        modal.batchResponses.push({ kind: "all-keep-local" });

        await Promise.all(docs.map((d) =>
            replicator.fireConcurrent(d.path, d.local, d.remote)));

        expect(modal.batchCalls).toHaveLength(1);
        expect(keepLocalCalls.map((c) => c[0]).sort()).toEqual(["k0.md", "k1.md", "k2.md"]);
        expect(dbToFileCalls).toHaveLength(0);
        expect(saveConflictCalls.map((c) => c[3])).toEqual(["local", "local", "local"]);
    });

    describe("binary conflicts are offered like text ones", () => {
        /** Not UTF-8 text: a NUL byte makes the sniff say binary. */
        const binary = (n: number, fill: number) => {
            const b = new Uint8Array(n).fill(fill);
            b[0] = 0;
            return b;
        };

        it("shows the modal with both sizes and applies the user's choice", async () => {
            const replicator = makeReplicator();
            createOrchestrator(replicator);
            const localDoc = await seedFileDoc(db, "img.png", binary(10, 1), { "dev-A": 1 });
            const remoteDoc = await seedFileDoc(db, "img.png", binary(2000, 2), { "dev-B": 1 });
            modal.conflictResponses.push({ choice: "take-remote", dismissed: false });

            await replicator.fireConcurrent("img.png", localDoc, remoteDoc);

            expect(modal.conflictCalls).toEqual([{
                filePath: "img.png",
                content: { kind: "binary", localSize: 10, remoteSize: 2000 },
            }]);
            expect(dbToFileCalls.map((d) => d.vclock)).toEqual([{ "dev-B": 1 }]);
            expect(saveConflictCalls).toEqual([["img.png", "", "", "remote"]]);
        });

        it("defers a binary conflict the user closes, keeping the vault's version", async () => {
            const orch = createOrchestrator(makeReplicator(), binary(10, 1));
            const remoteDoc = await seedFileDoc(db, "img.png", binary(20, 2), { "dev-B": 1 });
            modal.conflictResponses.push({ choice: "defer", dismissed: false });

            await orch.handleDivergentLocalEdit("img.png", remoteDoc);

            expect(modal.conflictCalls.map((c) => c.content)).toEqual([
                { kind: "binary", localSize: 10, remoteSize: 20 },
            ]);
            expect(dbToFileCalls).toHaveLength(0);
            expect(saveConflictCalls).toHaveLength(0);
        });

        it("lists a binary conflict in the batch with its sizes", async () => {
            const replicator = makeReplicator();
            const orch = new ConflictOrchestrator({
                modal, localDb: db as any, replicator: replicator as any,
                historyCapture: { saveConflict: async () => {} } as any,
                vaultSync: vaultSyncStub() as any,
                getSettings: () => settings,
                batchDebounceMs: 0,
                batchThreshold: 2,
            } as any);
            orch.register();
            const textLocal = await seedFileDoc(db, "t.md", "local", { "dev-A": 1 });
            const textRemote = await seedFileDoc(db, "t.md", "remote", { "dev-B": 1 });
            const binLocal = await seedFileDoc(db, "b.png", binary(3, 1), { "dev-A": 1 });
            const binRemote = await seedFileDoc(db, "b.png", binary(4, 2), { "dev-B": 1 });
            await serveChunksFromMemory(db, [textLocal, textRemote, binLocal, binRemote]);
            modal.batchResponses.push({ kind: "all-defer" });

            await Promise.all([
                replicator.fireConcurrent("t.md", textLocal, textRemote),
                replicator.fireConcurrent("b.png", binLocal, binRemote),
            ]);

            expect(modal.batchCalls).toHaveLength(1);
            const byPath = new Map(modal.batchCalls[0].map((it) => [it.filePath, it.content]));
            expect(byPath.get("t.md")).toEqual({ kind: "text", localText: "local", remoteText: "remote" });
            expect(byPath.get("b.png")).toEqual({ kind: "binary", localSize: 3, remoteSize: 4 });
        });
    });

    it("non-FileDoc conflict merges vclocks and keeps local", async () => {
        const replicator = makeReplicator();
        createOrchestrator(replicator);

        // ConfigDoc-like objects (not isFileDoc)
        const localDoc = { _id: "config:.obsidian/app.json", type: "config", data: "a", vclock: { "dev-A": 1 } };
        const remoteDoc = { _id: "config:.obsidian/app.json", type: "config", data: "b", vclock: { "dev-B": 1 } };

        await db.runWriteTx({ docs: [{ doc: localDoc as any }] });

        await replicator.fireConcurrent(".obsidian/app.json", localDoc as any, remoteDoc as any);

        const result = await db.get("config:.obsidian/app.json") as any;
        // mergeVC + incrementVC: dev-A gets bumped by 1 from merge+increment
        expect(result.vclock["dev-A"]).toBe(2);
        expect(result.vclock["dev-B"]).toBe(1);
    });
});
