/**
 * Regression: runWriteTx の onCommit 呼び出し脱落が検出できることを証明する。
 *
 * 過去実害:
 *   - LocalDB.runWriteTx / DexieStore で onCommit コールバックが
 *     commit 後に呼ばれないバグがあった
 *   - これは pull-path の pullWriter → Checkpoints.commitPullBatch → runWriteTx
 *     で、onCommit の中で events.emitAsync("pull-write", {doc}) が行われ、
 *     その結果 VaultSync.dbToFile が呼ばれて vault に書き込まれる
 *   - onCommit が脱落すると: DB には doc が残るが、vault には書き込まれず、
 *     lastSyncedVclock も更新されない
 *   - 従来のテストは vi.fn() で pull-write の呼び出し回数を検証していたが、
 *     テスト側が自前で emit を発火していた (= how) ため、本体の発火脱落は
 *     外部から不可視だった
 *
 * この回帰テストは「公開 API を叩き、副作用 (vault / db) を検証」する。
 * 意図的に onCommit 呼び出しを削除すると本テストが FAIL する。
 */
import "fake-indexeddb/auto";
import { describe, it, afterEach } from "vitest";
import { createSyncHarness, type SyncHarness } from "../harness/sync-harness.ts";
import { expectVault, expectDb } from "../harness/assertions.ts";
import { PullWriter } from "../../src/db/sync/pull-writer.ts";
import { Checkpoints } from "../../src/db/sync/checkpoints.ts";
import { EchoTracker } from "../../src/db/sync/echo-tracker.ts";
import { SyncEvents } from "../../src/db/sync/sync-events.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";
import type { ChangesResult } from "../../src/db/interfaces.ts";

describe("Regression: onCommit must fire after pull write", () => {
    let h: SyncHarness;

    afterEach(async () => {
        if (h) await h.destroyAll();
    });

    it("pulled FileDoc reaches B's vault AND lastSyncedVclock is persisted", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        const b = h.addDevice("dev-B");

        // Step 1: A creates file + pushes docs + chunks to the shared couch.
        a.vault.addFile("notes/target.md", "Payload from A");
        await a.vs.fileToDb("notes/target.md");
        const fileId = makeFileId("notes/target.md");
        const fileDocA = (await a.db.get(fileId)) as FileDoc;
        const chunksA = await a.db.getChunks(fileDocA.chunks);
        await h.couch.bulkDocs([
            fileDocA as unknown as CouchSyncDoc,
            ...(chunksA as unknown as CouchSyncDoc[]),
        ]);

        // Step 2: build PullWriter on B that wires applyPullWrite → vs.dbToFile.
        // Using B's resolver + B's localDb + a fresh SyncEvents so the wiring
        // is entirely session-scoped (mimics main.ts without engine.start()).
        const events = new SyncEvents();
        const echoes = new EchoTracker();
        const checkpoints = new Checkpoints(b.db);
        await checkpoints.load();
        const pullWriter = new PullWriter({
            localDb: b.db,
            events,
            echoes,
            checkpoints,
            getConflictResolver: () => b.resolver,
            // chunks already shipped via the harness transfer below
            ensureChunks: async () => {},
            applyPullWrite: (doc) => b.vs.dbToFile(doc),
        });

        // Copy chunks from shared couch to B's localDb (ensureChunks is no-op).
        const fetchedChunks = await h.couch.bulkGet<CouchSyncDoc>(fileDocA.chunks);
        await b.db.runWriteTx({ chunks: fetchedChunks });

        // Step 3: craft a ChangesResult as if it came from the couch _changes feed.
        const changes: ChangesResult<CouchSyncDoc> = {
            results: [{ id: fileId, seq: 1, doc: fileDocA as unknown as CouchSyncDoc }],
            last_seq: 1,
        };

        // Step 4: drive the pull path. If onCommit is dropped anywhere
        // under the hood, the pull-write event never fires → vault stays empty.
        await pullWriter.apply(changes);

        // Step 5: verify WHAT (observable side effects) — not HOW (call counts).
        expectVault(b.vault).toHaveFile("notes/target.md").withContent("Payload from A");
        await expectDb(b.db).toHaveFileDoc("notes/target.md").withVclock(fileDocA.vclock ?? {});
        await expectDb(b.db).toHaveLastSyncedVclock("notes/target.md", fileDocA.vclock ?? {});
    });
});
