/**
 * Regression: PR5 stale-bookkeeping recovery + legacy lastSynced upgrade.
 *
 * Two scenarios covered:
 *
 * 1. **Legacy upgrade**: a path's `lastSynced` entry exists in the older
 *    pre-`{chunks,size}` shape (only `vclock`). When reconciler scans and
 *    finds the path identical with the FileDoc, `alignLastSyncedToDoc`
 *    fills in chunks/size from the FileDoc. After one run, every entry
 *    is in the new shape.
 *
 * 2. **Stale-bookkeeping recovery**: defensive — `lastSynced.{chunks,size}`
 *    drifted from the actual integrated content (e.g., PR1 invariant
 *    violation in a crash window, or external tool wrote disk). When
 *    classifier confirms disk == fileDoc (= identical), recovery aligns
 *    `lastSynced` to the doc's fingerprint.
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

let counter = 0;
function uniqueDbName() { return `stale-bk-${Date.now()}-${counter++}`; }

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

describe("regression: PR5 stale-bookkeeping recovery", () => {
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

    it("legacy lastSynced (chunks: undefined) is upgraded on identical reconcile", async () => {
        // Set up: a real fileDoc + matching disk content + a legacy
        // lastSynced entry (vclock only, no chunks/size).
        const path = "notes/legacy.md";
        vault.addFile(path, "stable content");
        await vs.fileToDb(path);
        await vs.loadLastSyncedVclocks();

        // Synthesize a legacy entry by writing the meta with vclock only
        // (no chunks/size).
        const fileDoc = (await db.get(makeFileId(path))) as FileDoc;
        await db.runWriteTx({
            vclocks: [{ path, op: "set", clock: fileDoc.vclock ?? {} }],
        });
        // Reload lastSynced from disk so the in-memory cache reflects the
        // legacy shape.
        await vs.loadLastSyncedVclocks();
        const before = vs.getLastSynced(path)!;
        expect(before.chunks).toBeUndefined();
        expect(before.size).toBeUndefined();

        const result = await vs.alignLastSyncedToDoc(path, fileDoc);
        expect(result).toBe("upgraded-legacy");

        const after = vs.getLastSynced(path)!;
        expect(after.chunks).toEqual(fileDoc.chunks);
        expect(after.size).toBe(fileDoc.size);
        expect(after.vclock).toEqual(fileDoc.vclock);
    });

    it("stale lastSynced.chunks is recovered when classifier returns identical", async () => {
        const path = "notes/recover.md";
        vault.addFile(path, "the real content");
        await vs.fileToDb(path);
        await vs.loadLastSyncedVclocks();

        // Force a stale state: lastSynced records different chunks/size
        // than the integrated FileDoc actually has. Simulates PR1 invariant
        // violation aftermath.
        const fileDoc = (await db.get(makeFileId(path))) as FileDoc;
        await db.runWriteTx({
            vclocks: [{
                path, op: "set",
                clock: fileDoc.vclock ?? {},
                chunks: ["chunk:bogus"],
                size: 9999,
            }],
        });
        await vs.loadLastSyncedVclocks();
        const before = vs.getLastSynced(path)!;
        expect(before.chunks).toEqual(["chunk:bogus"]);
        expect(before.size).toBe(9999);

        const result = await vs.alignLastSyncedToDoc(path, fileDoc);
        expect(result).toBe("recovered-stale");

        const after = vs.getLastSynced(path)!;
        expect(after.chunks).toEqual(fileDoc.chunks);
        expect(after.size).toBe(fileDoc.size);
    });

    it("aligned lastSynced is unchanged (no-op)", async () => {
        const path = "notes/clean.md";
        vault.addFile(path, "clean content");
        await vs.fileToDb(path);
        await vs.loadLastSyncedVclocks();

        const fileDoc = (await db.get(makeFileId(path))) as FileDoc;
        const result = await vs.alignLastSyncedToDoc(path, fileDoc);
        expect(result).toBe("already-aligned");
    });

    it("reconciler invokes alignment in the identical branch", async () => {
        // End-to-end: a legacy lastSynced exists, reconciler runs, and
        // after the run the entry has been upgraded to {chunks,size}.
        const path = "notes/e2e-legacy.md";
        vault.addFile(path, "end-to-end content");
        await vs.fileToDb(path);
        await vs.loadLastSyncedVclocks();

        const fileDoc = (await db.get(makeFileId(path))) as FileDoc;
        // Roll back lastSynced to legacy shape.
        await db.runWriteTx({
            vclocks: [{ path, op: "set", clock: fileDoc.vclock ?? {} }],
        });
        await vs.loadLastSyncedVclocks();
        expect(vs.getLastSynced(path)!.chunks).toBeUndefined();

        const reconciler = new Reconciler(
            vault,
            db,
            vs,
            () => settings,
            () => {},
        );
        const report = await reconciler.reconcile("manual");
        expect(report.inSync).toBe(1);

        const after = vs.getLastSynced(path)!;
        expect(after.chunks).toEqual(fileDoc.chunks);
        expect(after.size).toBe(fileDoc.size);
    });
});
