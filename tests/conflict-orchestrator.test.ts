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

let counter = 0;
function uniqueDbName() { return `conflict-orch-test-${Date.now()}-${counter++}`; }

/** Create a FileDoc with real chunks in the DB. */
async function seedFileDoc(
    db: LocalDB,
    path: string,
    content: string,
    vclock: Record<string, number>,
): Promise<FileDoc> {
    const buf = new TextEncoder().encode(content).buffer;
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
    let dbToFileCalls: FileDoc[];
    let saveConflictCalls: any[];

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
        saveConflictCalls = [];
    });

    afterEach(async () => {
        await db.destroy();
    });

    function createOrchestrator(replicator: ReturnType<typeof makeReplicator>) {
        const historyCapture = {
            saveConflict: async (...args: any[]) => { saveConflictCalls.push(args); },
        };
        const orch = new ConflictOrchestrator({
            modal,
            localDb: db as any,
            replicator: replicator as any,
            historyCapture: historyCapture as any,
            dbToFile: async (doc: FileDoc) => { dbToFileCalls.push(doc); return { applied: true }; },
            getSettings: () => settings,
            // Drain on the next macrotask so single-conflict tests don't wait
            // the production debounce; a synchronous burst still coalesces.
            batchDebounceMs: 0,
        });
        orch.register();
        return orch;
    }

    it("keep-local merges vclocks and updates DB", async () => {
        const replicator = makeReplicator();
        createOrchestrator(replicator);

        const localDoc = await seedFileDoc(db, "a.md", "local text", { "dev-A": 2 });
        const remoteDoc = await seedFileDoc(db, "a.md", "remote text", { "dev-B": 1 });

        modal.conflictResponses.push({ choice: "keep-local", dismissed: false });

        await replicator.fireConcurrent("a.md", localDoc, remoteDoc);

        // DB should contain the merged+incremented vclock
        const result = await db.get(makeFileId("a.md")) as FileDoc;
        expect(result.vclock["dev-A"]).toBeGreaterThanOrEqual(2);
        expect(result.vclock["dev-B"]).toBe(1);

        // dbToFile should NOT have been called (keep-local)
        expect(dbToFileCalls).toHaveLength(0);

        // History recorded
        expect(saveConflictCalls).toHaveLength(1);
        expect(saveConflictCalls[0][3]).toBe("local"); // winner
    });

    it("take-remote writes remote doc to vault", async () => {
        const replicator = makeReplicator();
        createOrchestrator(replicator);

        const localDoc = await seedFileDoc(db, "a.md", "local text", { "dev-A": 1 });
        const remoteDoc = await seedFileDoc(db, "a.md", "remote text", { "dev-B": 1 });

        modal.conflictResponses.push({ choice: "take-remote", dismissed: false });

        await replicator.fireConcurrent("a.md", localDoc, remoteDoc);

        // dbToFile should have been called with the remote doc
        expect(dbToFileCalls).toHaveLength(1);
        expect(dbToFileCalls[0].vclock["dev-B"]).toBeDefined();
        expect(dbToFileCalls[0].vclock["dev-A"]).toBe(1); // merged

        // History recorded
        expect(saveConflictCalls).toHaveLength(1);
        expect(saveConflictCalls[0][3]).toBe("remote"); // winner
    });

    it("suppresses a duplicate concurrent modal while one is already in flight (#3 re-emit dedup)", async () => {
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

        // The pull writer persisted this edit-vs-edit conflict (Invariant B).
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
            dbToFile: async (doc: FileDoc) => { dbToFileCalls.push(doc); return { applied: true }; },
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
            dbToFile: async (doc: FileDoc) => { dbToFileCalls.push(doc); return { applied: true }; },
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
