/**
 * Regression: delete → recreate at the same path wedged the path unpushable
 * forever (incident 2026-06-07, `Periodic/WeeklyNotes/2026-W24.md`).
 *
 * Root cause (Invariant 7 — deletion is an integration event):
 *   - `markDeleted` ERASED the integration baseline (`lastSynced.delete`),
 *     destroying the causal record "I integrated this deletion".
 *   - On recreate, `fileToDb`'s divergent guard classified the LocalDB
 *     tombstone with `leftVC={}` (no baseline) → `dominated` →
 *     `remote-edit` → push skipped. Pull was already converged and the
 *     reconciler's Case C blind-forwarded into the same guard: no exit.
 *   - Bonus wedge (derived bug A): `markDeleted` spreads the prior doc, so
 *     the tombstone RETAINS the deleted content's chunks; recreating the
 *     file with identical content matched the chunksEqual short-circuit
 *     ("already on disk") and never reached the classifier at all.
 *
 * Fix shape asserted here:
 *   - deletion (push and pull side) establishes a DELETED baseline
 *     (`{vclock: tombstoneVC, chunks: [], size: 0, deleted: true}`);
 *   - recreate classifies `local-edit` (vclock equal vs the integrated
 *     tombstone) and pushes an alive doc dominating the tombstone;
 *   - the already-wedged state (file + tombstone + NO baseline — devices
 *     that hit the bug before this fix) routes to
 *     `handleDivergentRecreate` instead of silently skipping/restoring;
 *   - a pull-applied deletion leaves a deleted baseline, so a later remote
 *     recreate classifies as a restore, not a false conflict (derived
 *     bug C).
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
import { splitIntoChunks } from "../../src/db/chunker.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";

let counter = 0;
function uniqueDbName() { return `tombstone-recreate-${Date.now()}-${counter++}`; }

class ApplyingVaultWriter implements VaultWriter {
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

const DEV = "dev-A";

describe("regression: tombstone recreate (incident 2026-06-07 W24)", () => {
    let vault: FakeVaultIO;
    let db: LocalDB;
    let vs: VaultSync;
    let settings: ReturnType<typeof makeSettings>;

    beforeEach(() => {
        vault = new FakeVaultIO();
        db = new LocalDB(uniqueDbName());
        db.open();
        settings = makeSettings({ deviceId: DEV });
        vs = new VaultSync(vault, db, () => settings, new ApplyingVaultWriter(vault));
    });

    afterEach(async () => {
        await db.destroy();
    });

    /** Run create → push → delete, leaving the path in the post-deletion
     *  state (tombstone + deleted baseline). Returns the tombstone. */
    async function createPushDelete(path: string, content: string): Promise<FileDoc> {
        vault.addFile(path, content);
        await vs.fileToDb(path);
        await vault.delete(path);
        await vs.markDeleted(path);
        const tomb = await db.get(makeFileId(path)) as FileDoc;
        expect(tomb.deleted).toBe(true);
        return tomb;
    }

    it("markDeleted establishes the deleted baseline (not an erased one)", async () => {
        const tomb = await createPushDelete("w24.md", "v1 body\n");
        expect(tomb.vclock).toEqual({ [DEV]: 2 });
        expect(vs.getLastSynced("w24.md")).toEqual({
            vclock: { [DEV]: 2 }, chunks: [], size: 0, deleted: true,
        });
    });

    it("recreate with NEW content pushes an alive doc dominating the tombstone", async () => {
        await createPushDelete("w24.md", "v1 body\n");

        vault.addFile("w24.md", "v2 recreated\n");
        await vs.fileToDb("w24.md");

        const doc = await db.get(makeFileId("w24.md")) as FileDoc;
        expect(doc.deleted ?? false).toBe(false);
        expect(doc.vclock).toEqual({ [DEV]: 3 });
        const ls = vs.getLastSynced("w24.md");
        expect(ls?.deleted).toBeUndefined();
        expect(ls?.vclock).toEqual({ [DEV]: 3 });
    });

    it("recreate with IDENTICAL content pushes (derived bug A: retained-chunks short-circuit)", async () => {
        const tomb = await createPushDelete("w24.md", "v1 body\n");
        // The wild tombstone retains the deleted content's chunks — the
        // exact shape that used to satisfy the "already on disk" check.
        expect(tomb.chunks.length).toBeGreaterThan(0);

        vault.addFile("w24.md", "v1 body\n"); // identical content
        await vs.fileToDb("w24.md");

        const doc = await db.get(makeFileId("w24.md")) as FileDoc;
        expect(doc.deleted ?? false).toBe(false);
        expect(doc.vclock).toEqual({ [DEV]: 3 });
    });

    it("recreate with an EMPTY file pushes and hasUnpushedChanges sees it", async () => {
        await createPushDelete("w24.md", "v1 body\n");

        vault.addFile("w24.md", "");
        // Empty-file fingerprint (chunks [], size 0) coincides with the
        // normalized deleted baseline — the deleted flag must disambiguate.
        expect(await vs.hasUnpushedChanges("w24.md")).toBe(true);

        await vs.fileToDb("w24.md");
        const doc = await db.get(makeFileId("w24.md")) as FileDoc;
        expect(doc.deleted ?? false).toBe(false);
        expect(doc.vclock).toEqual({ [DEV]: 3 });
    });

    it("already-wedged state (no baseline — pre-fix devices) routes to handleDivergentRecreate", async () => {
        await createPushDelete("w24.md", "v1 body\n");
        // Reproduce the wedged fleet state: the pre-fix markDeleted erased
        // the baseline.
        await db.runWriteTx({ vclocks: [{ path: "w24.md", op: "delete" }] });
        (vs as any).lastSynced.delete("w24.md");
        vault.addFile("w24.md", "v2 recreated while wedged\n");

        // fileToDb still refuses (true-divergent) — no silent self-stamp.
        await vs.fileToDb("w24.md");
        let doc = await db.get(makeFileId("w24.md")) as FileDoc;
        expect(doc.deleted).toBe(true);

        // Reconcile routes Case C → true-divergent → orchestrator.
        const recreateCalls: Array<{ path: string; tombVC: any }> = [];
        const reconciler = new Reconciler(
            { getFiles: () => vault.getFiles() } as any,
            db, vs, () => settings,
        );
        reconciler.setConflictOrchestrator({
            async handleDivergentRecreate(filePath: string, tombstoneDoc: FileDoc) {
                recreateCalls.push({ path: filePath, tombVC: tombstoneDoc.vclock });
            },
        } as any);
        await reconciler.reconcile("manual");

        expect(recreateCalls).toEqual([{ path: "w24.md", tombVC: { [DEV]: 2 } }]);
        // Still no silent change to either side.
        doc = await db.get(makeFileId("w24.md")) as FileDoc;
        expect(doc.deleted).toBe(true);
        expect(await vault.exists("w24.md")).toBe(true);

        // keep-local resolution (what the user picks to rescue the file):
        // forceLocalEdit merges the tombstone vclock and commits alive.
        await vs.forceLocalEdit("w24.md", doc.vclock ?? {});
        doc = await db.get(makeFileId("w24.md")) as FileDoc;
        expect(doc.deleted ?? false).toBe(false);
        expect(doc.vclock).toEqual({ [DEV]: 3 });
    });

    it("pull-applied deletion establishes the deleted baseline (derived bug C) and a remote recreate restores without conflict", async () => {
        const path = "note.md";
        // Local file integrated normally.
        vault.addFile(path, "v1\n");
        await vs.fileToDb(path);

        // A remote tombstone (another device deleted) is applied via dbToFile.
        const localDoc = await db.get(makeFileId(path)) as FileDoc;
        const remoteTomb: FileDoc = {
            ...localDoc,
            chunks: [], size: 0, deleted: true,
            vclock: { ...localDoc.vclock, "dev-B": 1 },
        };
        await db.runWriteTx({ docs: [{ doc: remoteTomb as unknown as CouchSyncDoc }] });
        const res = await vs.dbToFile(remoteTomb);
        expect(res.applied).toBe(true);
        expect(await vault.exists(path)).toBe(false);
        // Symmetric with markDeleted: deleted baseline, not a stale alive one.
        expect(vs.getLastSynced(path)).toEqual({
            vclock: remoteTomb.vclock, chunks: [], size: 0, deleted: true,
        });

        // dev-B recreates the path; the alive doc dominates the tombstone.
        const buf = new TextEncoder().encode("v2 from dev-B\n").buffer;
        const chunks = await splitIntoChunks(buf);
        const recreated: FileDoc = {
            _id: makeFileId(path), type: "file",
            chunks: chunks.map((c) => c._id),
            mtime: Date.now(), ctime: Date.now(), size: buf.byteLength,
            vclock: { ...remoteTomb.vclock, "dev-B": 2 },
        };
        await db.runWriteTx({
            chunks: chunks as unknown as CouchSyncDoc[],
            docs: [{ doc: recreated as unknown as CouchSyncDoc }],
        });

        // Case D with a deleted baseline: dominating alive doc = legitimate
        // recreate → restore, NOT a divergent-local-delete conflict.
        const conflictCalls: string[] = [];
        const reconciler = new Reconciler(
            { getFiles: () => vault.getFiles() } as any,
            db, vs, () => settings,
        );
        reconciler.setConflictOrchestrator({
            async handleDivergentLocalDelete(filePath: string) { conflictCalls.push(filePath); },
            async handleDivergentRecreate(filePath: string) { conflictCalls.push(filePath); },
        } as any);
        const report = await reconciler.reconcile("manual");

        expect(conflictCalls).toEqual([]);
        expect(report.restored).toEqual([path]);
        expect(await vault.exists(path)).toBe(true);
        const ls = vs.getLastSynced(path);
        expect(ls?.deleted).toBeUndefined();
        expect(ls?.vclock).toEqual(recreated.vclock);
    });

    it("rename leaves a deleted baseline at the OLD path so recreating it pushes", async () => {
        const oldPath = "old.md";
        vault.addFile(oldPath, "v1\n");
        await vs.fileToDb(oldPath);

        // Rename = create at new path + tombstone at old path.
        await vault.delete(oldPath);
        vault.addFile("new.md", "v1\n");
        await vs.fileToDb("new.md");
        await vs.handleRename("new.md", oldPath);

        const oldDoc = await db.get(makeFileId(oldPath)) as FileDoc;
        expect(oldDoc?.deleted).toBe(true);
        expect(vs.getLastSynced(oldPath)?.deleted).toBe(true);

        // Recreating the old path is a normal recreate push.
        vault.addFile(oldPath, "fresh content at old path\n");
        await vs.fileToDb(oldPath);
        const doc = await db.get(makeFileId(oldPath)) as FileDoc;
        expect(doc.deleted ?? false).toBe(false);
    });
});
