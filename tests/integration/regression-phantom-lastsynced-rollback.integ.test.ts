/**
 * Regression: phantom `lastSynced.vclock` rollback (PR-F).
 *
 * 2026-05-10 production main vault DEBUG logs showed `silentReconvergeVclock`
 * firing on ~200+ paths every reconcile in a permanent no-op loop. The shape:
 * `lastSynced.vclock` carried an orphan device stamp (`melchior-main:1`)
 * that was NEVER on the remote FileDoc — likely a legacy migration relic.
 * The pre-fix `mergeVC`-based resolver kept writing the same superset back
 * to lastSynced (because merged === lastSynced.vclock dominated fileDoc),
 * and the next reconcile re-classified as `vclock-only-drift` forever.
 *
 * The fix elevates Invariant 3 to "chunks-equal vclock authority": when
 * the classifier returns `vclock-only-drift`, the resolver adopts
 * `fileDoc.vclock` as the new lastSynced (no mergeVC). Phantom stamps drop
 * in 1 reconcile and the 2nd reconcile sees `identical` — loop terminated.
 *
 * Asymmetry note (verified vs. pull-writer / config-pull-writer): pull
 * pipelines write merged clocks back to doc.vclock and replicate, so
 * remote tracks the merged state. Reconciler vault-scan deliberately
 * keeps the FileDoc untouched (rev-tree inflation across hundreds of
 * paths is unacceptable), so adoption on the lastSynced side is the only
 * convergence path. See `project_phantom_lastsynced_stamp.md` (memory).
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
import type { FileDoc } from "../../src/types.ts";

let counter = 0;
function uniqueDbName() { return `phantom-rollback-${Date.now()}-${counter++}`; }

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

describe("regression: phantom lastSynced rollback (PR-F)", () => {
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

    it("phantom stamp drops in 1 reconcile, 2nd reconcile sees identical", async () => {
        const path = "notes/legacy.md";
        vault.addFile(path, "stable content");
        await vs.fileToDb(path);
        await vs.loadLastSyncedVclocks();

        // Snapshot baseline state: lastSynced and FileDoc agree on
        // {dev-self: 1} (the local push).
        const beforeFileDoc = (await db.get(makeFileId(path))) as FileDoc;
        expect(beforeFileDoc.vclock).toEqual({ "dev-self": 1 });
        expect(vs.getLastSynced(path)?.vclock).toEqual({ "dev-self": 1 });
        const beforeRev = (beforeFileDoc as unknown as { _rev: string })._rev;

        // Inject phantom: a device key that exists ONLY in lastSynced,
        // never on the FileDoc. This is the production-observed shape
        // (memory: project_phantom_lastsynced_stamp.md, melchior-main:1
        // stamp present in ~200+ lastSynced entries but absent from every
        // matching remote FileDoc).
        const phantomVc = { "dev-self": 1, "ghost-device": 1 };
        const lsBefore = vs.getLastSynced(path)!;
        await db.runWriteTx({
            vclocks: [{
                path, op: "set", clock: phantomVc,
                chunks: lsBefore.chunks!, size: lsBefore.size!,
            }],
        });
        // Mirror in-memory map (mimic the production startup load shape).
        await vs.loadLastSyncedVclocks();
        expect(vs.getLastSynced(path)?.vclock).toEqual(phantomVc);

        // Confirm the classifier sees vclock-only-drift (chunks equal,
        // lastSynced dominates fileDoc — the loop trigger condition).
        const stat = (await vault.stat(path))!;
        const fileDoc = (await db.get(makeFileId(path))) as FileDoc;
        const relation = await vs.classifyFileVsDoc(fileDoc, path, stat);
        expect(relation).toBe("vclock-only-drift");

        // Spy on adoptDocVclock to count fires across reconciles.
        let adoptFires = 0;
        const original = vs.adoptDocVclock.bind(vs);
        vs.adoptDocVclock = async (p: string, doc: FileDoc, s?: { mtime: number; size: number }) => {
            adoptFires++;
            return original(p, doc, s);
        };

        const reconciler = new Reconciler(
            vault,
            db,
            vs,
            () => settings,
            () => {},
        );

        // Reconcile #1: should fire once and drop the phantom.
        const r1 = await reconciler.reconcile("phantom-cycle-1");
        expect(adoptFires).toBe(1);
        expect(r1.inSync).toBe(1);
        expect(r1.localWins).toEqual([]);
        expect(r1.remoteWins).toEqual([]);

        // lastSynced.vclock now equals fileDoc.vclock — the ghost stamp
        // is dropped, not merged in.
        const lsAfter = vs.getLastSynced(path)!;
        expect(lsAfter.vclock).toEqual({ "dev-self": 1 });
        expect(lsAfter.vclock).not.toHaveProperty("ghost-device");

        // FileDoc unchanged — no rev bump on remote, no replication echo
        // (the central architectural reason adoption beats merge here).
        const afterFileDoc = (await db.get(makeFileId(path))) as FileDoc;
        const afterRev = (afterFileDoc as unknown as { _rev: string })._rev;
        expect(afterRev).toBe(beforeRev);
        expect(afterFileDoc.vclock).toEqual({ "dev-self": 1 });

        // Reconcile #2: classifier should now see identical, no fires.
        adoptFires = 0;
        const r2 = await reconciler.reconcile("phantom-cycle-2");
        expect(adoptFires).toBe(0);
        expect(r2.inSync).toBe(1);

        const finalRelation = await vs.classifyFileVsDoc(afterFileDoc, path, stat);
        expect(finalRelation).toBe("identical");
    });
});
