/**
 * Regression B: divergent user-delete during a phantom-suppression window.
 *
 * Setup:
 *   1. Initial sync — vault has F, lastSynced records the integration point.
 *   2. A pull arrives advancing the LocalDB doc beyond integration baseline,
 *      but applyRemoteContent declines. → divergent state.
 *   3. User deletes F from the vault.
 *      `markDeleted`'s divergent guard skips the tombstone (phantom-write
 *      suppression from acee9bd).
 *   4. Reconcile fires.
 *
 * Without the fix, two reconcile cycles produce a silent restore:
 *   - cycle 1: classifyMissingFromVault sees path in manifest → "delete"
 *     → markDeleted hits the divergent guard → no-op. Manifest is then
 *     updated to remove F.
 *   - cycle 2: vault no F, doc alive, manifest no F → "restore" → dbToFile
 *     restores F. User's deletion intent is silently undone (Regression B).
 *
 * With the fix, the reconciler intercepts in Case D: when lastSynced exists
 * AND doc.vclock dominates lastSynced.vclock, route to
 * ConflictOrchestrator.handleDivergentLocalDelete on the first cycle. User
 * picks keep-deletion (force tombstone) or take-remote (restore).
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
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";
import { splitIntoChunks } from "../../src/db/chunker.ts";

let counter = 0;
function uniqueDbName() { return `divergent-delete-${Date.now()}-${counter++}`; }

class ToggleVaultWriter implements VaultWriter {
    skip = false;
    constructor(private io: FakeVaultIO) {}
    async applyRemoteContent(path: string, content: ArrayBuffer): Promise<WriteResult> {
        if (this.skip) return { applied: false, reason: "test-injected-skip" };
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

interface FakeOrchCalls {
    edit: Array<{ path: string }>;
    deletion: Array<{ path: string; remoteVclock: any }>;
}

function makeFakeOrchestrator() {
    const calls: FakeOrchCalls = { edit: [], deletion: [] };
    const orch = {
        async handleDivergentLocalEdit(filePath: string, _remoteDoc: FileDoc) {
            calls.edit.push({ path: filePath });
        },
        async handleDivergentLocalDelete(filePath: string, remoteDoc: FileDoc) {
            calls.deletion.push({ path: filePath, remoteVclock: remoteDoc.vclock });
        },
    };
    return { orch, calls };
}

describe("regression: divergent user-delete", () => {
    let vault: FakeVaultIO;
    let db: LocalDB;
    let vs: VaultSync;
    let writer: ToggleVaultWriter;
    let settings: ReturnType<typeof makeSettings>;
    let reconciler: Reconciler;
    let orchCalls: FakeOrchCalls;

    beforeEach(() => {
        vault = new FakeVaultIO();
        db = new LocalDB(uniqueDbName());
        db.open();
        settings = makeSettings({ deviceId: "dev-B" });
        writer = new ToggleVaultWriter(vault);
        vs = new VaultSync(vault, db, () => settings, writer);
        reconciler = new Reconciler(
            { getFiles: () => Array.from(vault.files.entries()).map(([path, e]) => ({
                path, stat: e.stat,
            })) } as any,
            db,
            vs,
            () => settings,
        );
        const { orch, calls } = makeFakeOrchestrator();
        reconciler.setConflictOrchestrator(orch as any);
        orchCalls = calls;
    });

    afterEach(async () => {
        await db.destroy();
    });

    it("intercepts divergent-delete on the first reconcile cycle", async () => {
        const path = "doomed.md";

        // Phase 1: initial sync (vault==DB; lastSynced=v_old)
        vault.addFile(path, "v0\n");
        await vs.fileToDb(path);
        const oldDoc = await db.get(makeFileId(path)) as FileDoc;

        // Phase 2: synthesize a remote doc dominating the local vclock.
        const remoteContent = "v_remote\n";
        const remoteBuf = new TextEncoder().encode(remoteContent).buffer;
        const remoteChunks = await splitIntoChunks(remoteBuf);
        const remoteDoc: FileDoc = {
            ...oldDoc,
            chunks: remoteChunks.map((c) => c._id),
            size: remoteBuf.byteLength,
            vclock: { ...(oldDoc.vclock ?? {}), "dev-A": 1 },
        };
        await db.runWriteTx({
            chunks: remoteChunks as unknown as CouchSyncDoc[],
            docs: [{ doc: remoteDoc as unknown as CouchSyncDoc }],
        });

        // Phase 3: dbToFile with writer skip — leaves divergent state.
        writer.skip = true;
        await vs.dbToFile(remoteDoc);
        writer.skip = false;

        // Phase 4: user deletes the file in vault.
        await vault.delete(path);
        await vs.markDeleted(path);
        // Doc remains alive (markDeleted's divergent guard skipped).
        const docAfterDelete = await db.get(makeFileId(path)) as FileDoc;
        expect(docAfterDelete.deleted).toBeFalsy();

        // Phase 5: reconcile.
        await reconciler.reconcile("paused");

        // Conflict-delete was invoked.
        expect(orchCalls.deletion).toHaveLength(1);
        expect(orchCalls.deletion[0].path).toBe(path);
        expect(orchCalls.deletion[0].remoteVclock).toEqual(remoteDoc.vclock);
        expect(orchCalls.edit).toHaveLength(0);

        // No silent restore.
        expect(vault.files.has(path)).toBe(false);
    });

    it("non-divergent self-delete still goes through markDeleted", async () => {
        // Plain user delete with no pull-divergent — should NOT route to
        // conflict, just mark deleted normally.
        const path = "plain.md";
        vault.addFile(path, "v0\n");
        await vs.fileToDb(path);

        // User deletes (no divergent state).
        await vault.delete(path);
        await vs.markDeleted(path);

        // markDeleted committed the tombstone and established the deleted
        // baseline (Invariant 7: deletion is an integration event — the
        // baseline is kept, not erased, so a later recreate keeps its
        // causal anchor).
        const doc = await db.get(makeFileId(path)) as FileDoc;
        expect(doc.deleted).toBe(true);
        expect(vs.getLastSynced(path)).toEqual({
            vclock: doc.vclock, chunks: [], size: 0, deleted: true,
        });

        // Reconcile is a no-op for this path (Case E).
        await reconciler.reconcile("paused");
        expect(orchCalls.deletion).toHaveLength(0);
        expect(orchCalls.edit).toHaveLength(0);
    });

    it("missing-from-vault without lastSynced (= other-device-created) still restores", async () => {
        // No lastSynced means this device never integrated the path.
        // Should restore from remote (= a new file from another device).
        const path = "fresh.md";
        const remoteContent = "from-other-device\n";
        const remoteBuf = new TextEncoder().encode(remoteContent).buffer;
        const remoteChunks = await splitIntoChunks(remoteBuf);
        const remoteDoc: FileDoc = {
            _id: makeFileId(path),
            type: "file",
            chunks: remoteChunks.map((c) => c._id),
            mtime: Date.now(),
            ctime: Date.now(),
            size: remoteBuf.byteLength,
            vclock: { "dev-A": 1 },
        };
        await db.runWriteTx({
            chunks: remoteChunks as unknown as CouchSyncDoc[],
            docs: [{ doc: remoteDoc as unknown as CouchSyncDoc }],
        });

        // No vault file, no lastSynced.
        expect(vs.getLastSynced(path)).toBeUndefined();

        await reconciler.reconcile("paused");

        // No conflict routing — restored normally.
        expect(orchCalls.deletion).toHaveLength(0);
        expect(vault.files.has(path)).toBe(true);
        const restored = await vault.readBinary(path).then(b => new TextDecoder().decode(b));
        expect(restored).toBe(remoteContent);
    });
});
