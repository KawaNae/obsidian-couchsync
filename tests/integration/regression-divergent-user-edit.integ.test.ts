/**
 * Regression A: divergent user-edit during a phantom-suppression window.
 *
 * Setup:
 *   1. Initial sync — vault has v0, lastSynced records {vclock, chunks, size}
 *      at v0.
 *   2. A pull arrives advancing the LocalDB doc to v_remote, but
 *      VaultWriter.applyRemoteContent declines (e.g., IME composition).
 *      LocalDB has v_remote chunks; vault still has v0; lastSynced unchanged.
 *      → divergent state.
 *   3. User edits the vault to v_user (different from both v0 and v_remote).
 *      `fileToDb`'s divergent guard skips the push (phantom-write suppression
 *      from acee9bd).
 *   4. Reconcile fires.
 *
 * Without the fix, the reconciler's `remote-pending` branch would call
 * `dbToFile` again, which (now that VaultWriter accepts) overwrites the
 * user's v_user with v_remote — silent data loss.
 *
 * With the fix, the reconciler detects vault-drift via lastSynced.chunks
 * (or the size fast-path) and routes to ConflictOrchestrator.handleDivergentLocalEdit
 * instead. The user gets a modal and decides take-remote vs keep-local.
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
function uniqueDbName() { return `divergent-edit-${Date.now()}-${counter++}`; }

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

interface FakeConflictOrchestratorCalls {
    edit: Array<{ path: string; remoteVclock: any }>;
    deletion: Array<{ path: string; remoteVclock: any }>;
}

function makeFakeOrchestrator() {
    const calls: FakeConflictOrchestratorCalls = { edit: [], deletion: [] };
    const orch = {
        async handleDivergentLocalEdit(filePath: string, remoteDoc: FileDoc) {
            calls.edit.push({ path: filePath, remoteVclock: remoteDoc.vclock });
        },
        async handleDivergentLocalDelete(filePath: string, remoteDoc: FileDoc) {
            calls.deletion.push({ path: filePath, remoteVclock: remoteDoc.vclock });
        },
    };
    return { orch, calls };
}

describe("regression: divergent user-edit", () => {
    let vault: FakeVaultIO;
    let db: LocalDB;
    let vs: VaultSync;
    let writer: ToggleVaultWriter;
    let settings: ReturnType<typeof makeSettings>;
    let reconciler: Reconciler;
    let orchCalls: FakeConflictOrchestratorCalls;

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

    /** Drive vault+DB into the divergent shape and return the remote doc. */
    async function induceDivergent(path: string, oldContent: string, userContent: string) {
        // Phase 1: initial sync (vault==DB; lastSynced=v_old)
        vault.addFile(path, oldContent);
        await vs.fileToDb(path);
        const oldDoc = await db.get(makeFileId(path)) as FileDoc;

        // Phase 2: synthesize a remote doc with chunks for v_remote and a
        // dominating vclock. Commit it to LocalDB the same way PullWriter would.
        const remoteContent = "REMOTE\n" + oldContent + "REMOTE\n";
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
        const writeResult = await vs.dbToFile(remoteDoc);
        writer.skip = false;
        expect(writeResult.applied).toBe(false);

        // Phase 4: user edits vault while in divergent state.
        vault.addFile(path, userContent);
        // fileToDb's divergent guard refuses the push.
        await vs.fileToDb(path);
        const docAfterPush = await db.get(makeFileId(path)) as FileDoc;
        expect(docAfterPush.vclock).toEqual(remoteDoc.vclock); // unchanged

        return { remoteDoc };
    }

    it("reconciler routes divergent vault-edit to ConflictOrchestrator instead of dbToFile", async () => {
        const path = "test.md";
        const { remoteDoc } = await induceDivergent(path, "v0\n", "v_user-edited\n");

        // Sanity: lastSynced still has the integration baseline (v0 chunks).
        const lastSynced = vs.getLastSynced(path);
        expect(lastSynced).toBeDefined();
        expect(lastSynced!.chunks).toBeDefined();
        expect(lastSynced!.chunks!.length).toBeGreaterThan(0);

        // Vault still has user's edit (v_user); doc has v_remote.
        const vaultText = await vault.readBinary(path).then(b => new TextDecoder().decode(b));
        expect(vaultText).toBe("v_user-edited\n");

        // Run reconcile.
        await reconciler.reconcile("paused");

        // The conflict orchestrator was invoked exactly once.
        expect(orchCalls.edit).toHaveLength(1);
        expect(orchCalls.edit[0].path).toBe(path);
        expect(orchCalls.edit[0].remoteVclock).toEqual(remoteDoc.vclock);
        expect(orchCalls.deletion).toHaveLength(0);

        // CRITICAL: vault was NOT overwritten with remote content.
        const vaultTextAfter = await vault.readBinary(path).then(b => new TextDecoder().decode(b));
        expect(vaultTextAfter).toBe("v_user-edited\n");
    });

    it("size fast-path: divergent edit with different size short-circuits without chunk computation", async () => {
        const path = "test.md";
        // v_user-edited has different byte length from v_remote.
        const { remoteDoc } = await induceDivergent(path, "v0\n", "different-length-edit\n");
        // Sanity check that sizes actually differ.
        const lastSynced = vs.getLastSynced(path);
        const vaultStat = await vault.stat(path);
        expect(vaultStat!.size).not.toBe(lastSynced!.size);
        // Reconcile detects via size fast-path.
        await reconciler.reconcile("paused");
        expect(orchCalls.edit).toHaveLength(1);
        expect(orchCalls.edit[0].remoteVclock).toEqual(remoteDoc.vclock);
    });

    it("pure stale (vault unchanged from baseline) still goes through dbToFile", async () => {
        const path = "test.md";
        // Setup divergent state but DON'T edit the vault.
        vault.addFile(path, "v0\n");
        await vs.fileToDb(path);
        const oldDoc = await db.get(makeFileId(path)) as FileDoc;
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
        writer.skip = true;
        await vs.dbToFile(remoteDoc);
        writer.skip = false;

        // Vault still at v0 (matches lastSynced.chunks).
        // Reconcile should call dbToFile (NOT conflict).
        await reconciler.reconcile("paused");
        expect(orchCalls.edit).toHaveLength(0);
        // Vault should now have the remote content (recovery applied).
        const vaultText = await vault.readBinary(path).then(b => new TextDecoder().decode(b));
        expect(vaultText).toBe("v_remote\n");
        // lastSynced advanced.
        expect(vs.getLastSynced(path)?.vclock).toEqual(remoteDoc.vclock);
    });

    it("legacy lastSynced (pre-extension, no chunks) skips the divergent guard", async () => {
        // Legacy entries on disk have raw VectorClock value (no chunks/size).
        // Reconciler should NOT route them to conflict — fall back to
        // legacy dbToFile behavior until the next push/pull rewrites the
        // entry in full shape.
        const path = "legacy.md";
        vault.addFile(path, "v_user-content\n");
        // Seed a legacy lastSynced entry directly (raw VectorClock value).
        await db.runWriteTx({
            meta: [{
                op: "put",
                key: "_local/vclock/" + toPathKey(path),
                value: { "dev-B": 1 } as any,
            }],
        });
        await vs.loadLastSyncedVclocks();

        // Synthesize a remote doc dominating the legacy vclock, with chunks
        // matching the vault's CURRENT content (so the size fast-path
        // wouldn't catch divergence even if it ran).
        const remoteContent = "v_remote\n";
        const remoteBuf = new TextEncoder().encode(remoteContent).buffer;
        const remoteChunks = await splitIntoChunks(remoteBuf);
        const remoteDoc: FileDoc = {
            _id: makeFileId(path),
            type: "file",
            chunks: remoteChunks.map((c) => c._id),
            mtime: Date.now(),
            ctime: Date.now(),
            size: remoteBuf.byteLength,
            vclock: { "dev-B": 1, "dev-A": 1 },
        };
        await db.runWriteTx({
            chunks: remoteChunks as unknown as CouchSyncDoc[],
            docs: [{ doc: remoteDoc as unknown as CouchSyncDoc }],
        });

        await reconciler.reconcile("paused");

        // Legacy entry → no conflict routing, legacy dbToFile runs.
        expect(orchCalls.edit).toHaveLength(0);
    });
});
