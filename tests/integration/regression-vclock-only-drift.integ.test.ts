/**
 * Regression: PR3 classifier-driven reconcile dispatch.
 *
 * Two shapes covered:
 *
 * 1. **vclock-only-drift on vault scan** — vault content matches FileDoc
 *    content but the vclocks have drifted (e.g., another device pushed an
 *    identical-content rev with its own deviceId). Pre-PR3 the legacy
 *    `compareFileToDoc` would have classified this as "identical" only
 *    when the chunks matched (size+chunk equality short-circuit), but
 *    the post-classifier branch now also exercises `adoptDocVclock`
 *    when the disk and FileDoc happen to disagree on size while sharing
 *    chunks — the classifier sees this and routes to merge. Asserts that
 *    no fileToDb / dbToFile is emitted (no content change).
 *
 * 2. **local-edit branch divergent guard** — historically the
 *    reconciler's "local-unpushed" branch had NO divergent guard (the
 *    guard lived on the "remote-pending" branch only). PR3's classifier
 *    folds the guard into `classifySyncRelation`, so a vault that
 *    diverged from baseline AND the FileDoc that diverged in a way the
 *    classifier reads as "right dominates" routes to true-divergent.
 *    Asserts the conflict orchestrator is called instead of fileToDb.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { VaultSync } from "../../src/sync/vault-sync.ts";
import { Reconciler } from "../../src/sync/reconciler.ts";
import type { VaultWriter, WriteResult } from "../../src/sync/vault-writer.ts";
import { LocalDB } from "../../src/db/local-db.ts";
import { FakeVaultIO } from "../helpers/fake-vault-io.ts";
import { makeSettings } from "../helpers/settings-factory.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import { toPathKey } from "../../src/utils/path.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";
import { splitIntoChunks } from "../../src/db/chunker.ts";

let counter = 0;
function uniqueDbName() { return `vclock-drift-${Date.now()}-${counter++}`; }

class PassthroughWriter implements VaultWriter {
    constructor(private io: FakeVaultIO) {}
    async applyRemoteContent(path: string, content: ArrayBuffer): Promise<WriteResult> {
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

function makeFakeOrchestrator() {
    const calls: { editPaths: string[]; deletionPaths: string[] } = {
        editPaths: [],
        deletionPaths: [],
    };
    return {
        calls,
        orch: {
            async handleDivergentLocalEdit(filePath: string, _remoteDoc: FileDoc) {
                calls.editPaths.push(filePath);
            },
            async handleDivergentLocalDelete(filePath: string, _remoteDoc: FileDoc) {
                calls.deletionPaths.push(filePath);
            },
        },
    };
}

describe("regression: PR3 classifier reconcile dispatch", () => {
    let vault: FakeVaultIO;
    let db: LocalDB;
    let vs: VaultSync;
    let writer: PassthroughWriter;
    let settings: ReturnType<typeof makeSettings>;

    beforeEach(async () => {
        vault = new FakeVaultIO();
        db = new LocalDB(uniqueDbName());
        await db.open();
        settings = makeSettings({ deviceId: "dev-self" });
        writer = new PassthroughWriter(vault);
        vs = new VaultSync(vault, db, () => settings, writer);
    });

    afterEach(async () => {
        await vs.teardown();
        await db.destroy();
    });

    it("vclock-only-drift: silent merge, no content write", async () => {
        const path = "notes/shared.md";
        vault.addFile(path, "shared content");
        await vs.fileToDb(path);
        await vs.loadLastSyncedVclocks();

        // Synthesize: another device pushed an identical-content rev with
        // its own device counter. Pull would land it as a FileDoc whose
        // vclock dominates lastSynced but whose chunks/size match exactly.
        const stat = (await vault.stat(path))!;
        const localChunkIds = (await splitIntoChunks(await vault.readBinary(path))).map((c) => c._id);
        const driftedDoc: FileDoc = {
            _id: makeFileId(path),
            type: "file",
            chunks: localChunkIds,
            mtime: stat.mtime,
            ctime: stat.ctime,
            size: stat.size,
            vclock: { "dev-self": 1, "dev-other": 1 },
        };
        await db.runWriteTx({
            docs: [{ doc: driftedDoc as unknown as CouchSyncDoc }],
        });

        const relation = await vs.classifyFileVsDoc(driftedDoc, path, stat);
        expect(relation).toBe("vclock-only-drift");

        // Reconciler exercise: silent merge updates lastSynced.vclock and
        // counts the file as inSync.
        const fakeOrch = makeFakeOrchestrator();
        const reconciler = new Reconciler(
            vault,
            db,
            vs,
            () => settings,
            () => {},
        );
        reconciler.setConflictOrchestrator(fakeOrch.orch as never);

        const report = await reconciler.reconcile("manual");
        expect(report.inSync).toBe(1);
        expect(report.localWins).toEqual([]);
        expect(report.remoteWins).toEqual([]);
        expect(fakeOrch.calls.editPaths).toEqual([]);

        // lastSynced.vclock advances to merged set.
        const advanced = vs.getLastSynced(path)!;
        expect(advanced.vclock).toEqual({ "dev-self": 1, "dev-other": 1 });
    });

    it("right-dominates-with-local-drift routes to conflict orchestrator (was: silent overwrite)", async () => {
        // Pre-PR3 the reconciler's "remote-pending" branch had a divergent
        // guard, but the "local-unpushed" branch did not. PR3 unifies via
        // the classifier so any drift-from-baseline + remote-dominate combo
        // surfaces as true-divergent.
        const path = "notes/contested.md";
        vault.addFile(path, "v0 baseline");
        await vs.fileToDb(path);
        await vs.loadLastSyncedVclocks();

        // Remote advanced the doc (different content + vclock dominates).
        const remoteDoc: FileDoc = {
            _id: makeFileId(path),
            type: "file",
            chunks: ["chunk:remote-side"],
            mtime: Date.now() + 1000,
            ctime: 1,
            size: 99,
            vclock: { "dev-self": 1, "dev-other": 5 },
        };
        await db.runWriteTx({
            docs: [{ doc: remoteDoc as unknown as CouchSyncDoc }],
        });

        // User edited the vault to a third state (drift from baseline).
        vault.addFile(path, "v_user user diverged", { size: 21 });

        const relation = await vs.classifyFileVsDoc(remoteDoc, path, (await vault.stat(path))!);
        expect(relation).toBe("true-divergent");

        const fakeOrch = makeFakeOrchestrator();
        const reconciler = new Reconciler(
            vault,
            db,
            vs,
            () => settings,
            () => {},
        );
        reconciler.setConflictOrchestrator(fakeOrch.orch as never);

        const report = await reconciler.reconcile("manual");
        expect(fakeOrch.calls.editPaths).toEqual([path]);
        // Reconciler reports under remoteWins for conflict-edit.
        expect(report.remoteWins).toEqual([path]);
        expect(report.localWins).toEqual([]);
    });

    it("local-edit (vclock-equal + chunks differ) routes to fileToDb push", async () => {
        // Sanity: the classic "user edited locally, hasn't pushed yet" case
        // still routes to push under PR3.
        const path = "notes/local.md";
        vault.addFile(path, "v0");
        await vs.fileToDb(path);
        await vs.loadLastSyncedVclocks();

        // User edits the vault.
        vault.addFile(path, "v1 user edit", { size: 12 });

        const doc = (await db.get(makeFileId(path))) as FileDoc;
        const relation = await vs.classifyFileVsDoc(doc, path, (await vault.stat(path))!);
        expect(relation).toBe("local-edit");

        const reconciler = new Reconciler(
            vault,
            db,
            vs,
            () => settings,
            () => {},
        );
        const fakeOrch = makeFakeOrchestrator();
        reconciler.setConflictOrchestrator(fakeOrch.orch as never);

        const report = await reconciler.reconcile("manual");
        expect(report.localWins).toEqual([path]);
        expect(fakeOrch.calls.editPaths).toEqual([]);
    });
});
