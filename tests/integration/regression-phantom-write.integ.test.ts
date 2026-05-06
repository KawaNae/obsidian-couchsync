/**
 * Regression: phantom-write guard.
 *
 * Reproduces the rev 197 production phantom-write shape against a real
 * LocalDB + FakeVaultIO + VaultSync, and verifies that:
 *
 *   1. `fileToDb` refuses to push when LocalDB.doc.vclock dominates
 *      lastSyncedVclock (= pull arrived but vault write was declined,
 *      e.g. IME composition divergence).
 *   2. `markDeleted` refuses to produce a tombstone in the same divergent
 *      state.
 *   3. `dbToFile` returns `{applied:false, reason}` when the VaultWriter
 *      declines, so PullWriter can account skips and emit `pull-skipped`
 *      for the supervisor to schedule a reconcile retry.
 *
 * Production trigger: 2026-05-05 23:38 desktop edit of
 * `Obsidian-task-viewer.md` (rev 196) was overwritten 12h later by iPad's
 * rev 197 (chunks matching rev 193, vclock dominating rev 196). Manual
 * reproduction on Android emulator + dev vault on 2026-05-06 confirmed
 * the structural fingerprint:
 *
 *   - LocalDB.doc: { chunks: [h_new], vclock: V_new }     ← committed by pull
 *   - Vault content: matches h_old                         ← stale
 *   - lastSyncedVclock: V_old                              ← stale
 *   - modify event → fileToDb → push doc { chunks: [h_old], vclock: V_new + self++ }
 *
 * The guard turns step 5 into a no-op + warn log.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { VaultSync } from "../../src/sync/vault-sync.ts";
import type { VaultWriter, WriteResult } from "../../src/sync/vault-writer.ts";
import { LocalDB } from "../../src/db/local-db.ts";
import { FakeVaultIO } from "../helpers/fake-vault-io.ts";
import { makeSettings } from "../helpers/settings-factory.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import { toPathKey } from "../../src/utils/path.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";

let counter = 0;
function uniqueDbName() { return `phantom-test-${Date.now()}-${counter++}`; }

/** A toggleable VaultWriter that simulates IME composition skip / disk write. */
class ToggleVaultWriter implements VaultWriter {
    skip = false;
    skipReason = "test-injected-skip";
    constructor(private io: FakeVaultIO) {}
    async applyRemoteContent(path: string, content: ArrayBuffer): Promise<WriteResult> {
        if (this.skip) return { applied: false, reason: this.skipReason };
        await this.io.writeBinary(path, content);
        return { applied: true };
    }
    async applyRemoteDeletion(path: string): Promise<void> {
        if (await this.io.exists(path)) await this.io.delete(path);
    }
    async createFile(path: string, content: ArrayBuffer): Promise<void> {
        await this.io.createBinary(path, content);
    }
    flushAll(): void { /* no-op */ }
}

describe("regression: phantom-write guard", () => {
    let vault: FakeVaultIO;
    let db: LocalDB;
    let vs: VaultSync;
    let writer: ToggleVaultWriter;
    let settings: ReturnType<typeof makeSettings>;

    beforeEach(() => {
        vault = new FakeVaultIO();
        db = new LocalDB(uniqueDbName());
        db.open();
        settings = makeSettings({ deviceId: "dev-B" });
        writer = new ToggleVaultWriter(vault);
        vs = new VaultSync(vault, db, () => settings, writer);
    });

    afterEach(async () => {
        await db.destroy();
    });

    /**
     * Drive the system into the rev 197 divergent shape. Returns the
     * pulled doc so callers can compare against post-attempt state.
     */
    async function induceDivergent(path: string, oldContent: string, newContent: string) {
        // Put the device into the "post-pull" state: LocalDB has the
        // remote doc at V_new, vault still holds the v0 content, and
        // lastSyncedVclock reflects V_old (= the last successfully
        // applied pull's vclock).
        vault.addFile(path, oldContent);

        // Step 1: simulate a successful initial sync where lastSynced=V_old.
        await vs.fileToDb(path);
        const oldDoc = await db.get(makeFileId(path)) as FileDoc;
        // After fileToDb, lastSynced == doc.vclock = {dev-B: 1}.

        // Step 2: simulate a remote pull that arrives with vclock dominating
        // the local state. We commit the remote doc directly (= what
        // PullWriter.commit does inside the atomic tx) then attempt
        // dbToFile with the writer toggled to skip — this is exactly the
        // sequence that produces divergent state in production.
        const newChunks = await vault.readBinary(path).then(async () => {
            // Re-chunkify the new content (different from old).
            vault.addFile(path + ".tmp", newContent);
            const tmpId = makeFileId(path + ".tmp");
            await vs.fileToDb(path + ".tmp");
            const tmpDoc = await db.get(tmpId) as FileDoc;
            // Cleanup the helper file.
            await vault.delete(path + ".tmp");
            await db.runWriteTx({ deletes: [tmpId] });
            return tmpDoc.chunks;
        });

        // Restore vault to old content (cleanup helper above modified mtime).
        vault.addFile(path, oldContent);

        // Now commit a remote doc that dominates the local vclock.
        const remoteDoc: FileDoc = {
            ...oldDoc,
            chunks: newChunks,
            size: new TextEncoder().encode(newContent).byteLength,
            vclock: { ...(oldDoc.vclock ?? {}), "dev-A": 1 }, // adds foreign progression
        };
        await db.runWriteTx({
            docs: [{ doc: remoteDoc as unknown as CouchSyncDoc }],
        });

        // Attempt dbToFile with skip injection — this leaves lastSynced
        // unchanged at V_old while LocalDB now has V_new.
        writer.skip = true;
        const writeResult = await vs.dbToFile(remoteDoc);
        writer.skip = false;

        return { oldDoc, remoteDoc, writeResult };
    }

    it("dbToFile reports applied:false when VaultWriter declines (pull-skipped surfacing)", async () => {
        const path = "test.md";
        const { writeResult } = await induceDivergent(path, "v0\n", "v1 — remote\n");

        expect(writeResult).toEqual({ applied: false, reason: "test-injected-skip" });
    });

    it("fileToDb refuses to push when LocalDB.doc.vclock dominates lastSyncedVclock", async () => {
        const path = "test.md";
        const { remoteDoc } = await induceDivergent(path, "v0\n", "v1 — remote\n");

        // Sanity: divergent state established.
        const docBefore = await db.get(makeFileId(path)) as FileDoc;
        expect(docBefore.vclock).toEqual(remoteDoc.vclock);
        expect(vs["lastSyncedVclock"].get(toPathKey(path))).toEqual({ "dev-B": 1 });

        // Trigger a modify event by re-emitting fileToDb. The guard must
        // refuse to construct a phantom doc.
        await vs.fileToDb(path);

        const docAfter = await db.get(makeFileId(path)) as FileDoc;
        // Doc unchanged: no phantom-write produced.
        expect(docAfter.vclock).toEqual(docBefore.vclock);
        expect(docAfter.chunks).toEqual(docBefore.chunks);
        // lastSynced still at the pre-divergent value (recovery hasn't fired yet).
        expect(vs["lastSyncedVclock"].get(toPathKey(path))).toEqual({ "dev-B": 1 });
    });

    it("markDeleted refuses to produce a tombstone in divergent state", async () => {
        const path = "test.md";
        const { remoteDoc } = await induceDivergent(path, "v0\n", "v1 — remote\n");

        const docBefore = await db.get(makeFileId(path)) as FileDoc;
        expect(docBefore.deleted).toBeFalsy();

        // Simulate user deleting the file while divergent.
        await vault.delete(path);
        await vs.markDeleted(path);

        const docAfter = await db.get(makeFileId(path)) as FileDoc;
        // No phantom-tombstone: doc still alive with the same vclock.
        expect(docAfter.deleted).toBeFalsy();
        expect(docAfter.vclock).toEqual(docBefore.vclock);
    });

    it("recovery: when VaultWriter is restored, dbToFile retry succeeds and lastSynced advances", async () => {
        const path = "test.md";
        const { remoteDoc } = await induceDivergent(path, "v0\n", "v1 — remote\n");

        // Reconciler routes through dbToFile with the writer no longer
        // skipping (= pull-skipped → reconcile schedule path on the next
        // cycle, when applyRemoteContent succeeds).
        writer.skip = false;
        const result = await vs.dbToFile(remoteDoc);

        expect(result).toEqual({ applied: true });
        expect(vs["lastSyncedVclock"].get(toPathKey(path))).toEqual(remoteDoc.vclock);
        // Vault now matches the remote content.
        const vaultBytes = await vault.readBinary(path);
        const vaultText = new TextDecoder().decode(vaultBytes);
        expect(vaultText).toBe("v1 — remote\n");
    });

    it("non-divergent push proceeds normally (fileToDb consistent state)", async () => {
        const path = "test.md";
        // Initial sync: vault==doc, lastSynced==doc.vclock.
        vault.addFile(path, "hello");
        await vs.fileToDb(path);
        const docInitial = await db.get(makeFileId(path)) as FileDoc;
        expect(docInitial.vclock).toEqual({ "dev-B": 1 });

        // User edits — still consistent (lastSynced == existing.vclock).
        vault.addFile(path, "hello world");
        await vs.fileToDb(path);

        const docAfter = await db.get(makeFileId(path)) as FileDoc;
        expect(docAfter.vclock).toEqual({ "dev-B": 2 });
        expect(docAfter.size).toBeGreaterThan(docInitial.size);
    });

    it("new file push (no existing doc) is unaffected by guard", async () => {
        const path = "fresh.md";
        vault.addFile(path, "fresh content");
        await vs.fileToDb(path);
        const doc = await db.get(makeFileId(path)) as FileDoc;
        expect(doc.vclock).toEqual({ "dev-B": 1 });
    });
});

describe("regression: pull-skipped event triggers reconcile schedule", () => {
    /**
     * PullWriter integration: when applyPullWrite returns applied:false
     * for any doc in the batch, the writer must emit "pull-skipped" with
     * the count, so the supervisor (main.ts) can fire reconcile.
     *
     * Without this trigger, idle longpoll persists divergent state
     * indefinitely (verified 2026-05-06: 90s of idle yielded no
     * spontaneous reconciler activity).
     */
    it("emits pull-skipped event when applyPullWrite returns applied:false", async () => {
        const { PullWriter } = await import("../../src/db/sync/pull-writer.ts");
        const { SyncEvents } = await import("../../src/db/sync/sync-events.ts");
        const { Checkpoints } = await import("../../src/db/sync/checkpoints.ts");
        const { EchoTracker } = await import("../../src/db/sync/echo-tracker.ts");

        const localDb = new LocalDB(uniqueDbName());
        localDb.open();
        const events = new SyncEvents();
        const checkpoints = new Checkpoints(localDb);
        const echoes = new EchoTracker();

        const skippedEvents: Array<{ count: number }> = [];
        events.on("pull-skipped", (payload) => skippedEvents.push(payload));

        const writer = new PullWriter({
            localDb,
            events,
            echoes,
            checkpoints,
            getConflictResolver: () => undefined,
            ensureChunks: async () => {},
            applyPullWrite: async () => ({ applied: false, reason: "test-skip" }),
        });

        const fileId = makeFileId("a.md");
        const remoteDoc: FileDoc = {
            _id: fileId,
            type: "file",
            chunks: ["chunk:abc"],
            vclock: { "dev-A": 1 },
            mtime: 1, ctime: 1, size: 3,
        };

        await writer.apply({
            results: [{ id: fileId, seq: 1, doc: remoteDoc as unknown as CouchSyncDoc }],
            last_seq: 1,
        });

        expect(skippedEvents).toEqual([{ count: 1 }]);

        await localDb.destroy();
    });

    it("does NOT emit pull-skipped when all writes succeed", async () => {
        const { PullWriter } = await import("../../src/db/sync/pull-writer.ts");
        const { SyncEvents } = await import("../../src/db/sync/sync-events.ts");
        const { Checkpoints } = await import("../../src/db/sync/checkpoints.ts");
        const { EchoTracker } = await import("../../src/db/sync/echo-tracker.ts");

        const localDb = new LocalDB(uniqueDbName());
        localDb.open();
        const events = new SyncEvents();
        const checkpoints = new Checkpoints(localDb);
        const echoes = new EchoTracker();

        const skippedEvents: Array<{ count: number }> = [];
        events.on("pull-skipped", (payload) => skippedEvents.push(payload));

        const writer = new PullWriter({
            localDb,
            events,
            echoes,
            checkpoints,
            getConflictResolver: () => undefined,
            ensureChunks: async () => {},
            applyPullWrite: async () => ({ applied: true }),
        });

        const fileId = makeFileId("a.md");
        const remoteDoc: FileDoc = {
            _id: fileId,
            type: "file",
            chunks: ["chunk:abc"],
            vclock: { "dev-A": 1 },
            mtime: 1, ctime: 1, size: 3,
        };

        await writer.apply({
            results: [{ id: fileId, seq: 1, doc: remoteDoc as unknown as CouchSyncDoc }],
            last_seq: 1,
        });

        expect(skippedEvents).toEqual([]);

        await localDb.destroy();
    });
});
