/**
 * Regression: PR-B silent-loss race — pull-delete arrives during the
 * ChangeTracker debounce window for a fresh user edit.
 *
 * Pre-PR-B `hasUnpushedChanges` compared `localDoc.vclock` against
 * `lastSynced.vclock`. Those two are kept in lockstep by `fileToDb` /
 * `dbToFile`, so the function effectively always returned false. A user
 * edit landing on disk before the debounce fires (= LocalDB doc still
 * at the prior vclock) was invisible to the check, and a remote
 * tombstone arriving during that window would silently delete the
 * vault file along with the user's unpushed work.
 *
 * Post-PR-B the check is chunks-aware (vault disk vs `lastSynced.chunks`)
 * AND consults the `IPendingProbe` for a debounced sync. Either signal
 * makes the pull-delete query return true, routing the deletion to the
 * concurrent-conflict modal instead of silently overwriting.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { VaultSync } from "../../src/sync/vault-sync.ts";
import type { VaultWriter, WriteResult } from "../../src/sync/vault-writer.ts";
import { LocalDB } from "../../src/db/local-db.ts";
import { FakeVaultIO } from "../helpers/fake-vault-io.ts";
import { makeSettings } from "../helpers/settings-factory.ts";
import { makeFileId } from "../../src/types/doc-id.ts";

let counter = 0;
function uniqueDbName() { return `pull-delete-debounce-${Date.now()}-${counter++}`; }

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

describe("regression: PR-B pull-delete vs debounce silent loss", () => {
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

    it("vault edit during debounce is detected by hasUnpushedChanges (chunks path)", async () => {
        const path = "notes/race.md";
        // Steady state: vault and lastSynced aligned at v0.
        vault.addFile(path, "v0 content");
        await vs.fileToDb(path);
        await vs.loadLastSyncedVclocks();
        expect(await vs.hasUnpushedChanges(path)).toBe(false);

        // User edits the vault. ChangeTracker would schedule a fileToDb
        // in `syncDebounceMs` ms but hasn't fired yet. LocalDB FileDoc
        // still holds v0; lastSynced still holds v0. Pre-PR-B this
        // looked like "no unpushed work" (vclock equal). Post-PR-B the
        // chunks comparison catches it.
        vault.addFile(path, "v1 user just edited", { size: 19 });

        expect(await vs.hasUnpushedChanges(path)).toBe(true);
    });

    it("vault edit during debounce is detected via the pending probe (size unchanged)", async () => {
        const path = "notes/race-probe.md";
        vault.addFile(path, "abcde");
        await vs.fileToDb(path);
        await vs.loadLastSyncedVclocks();

        // Wire a fake probe to simulate ChangeTracker reporting that a
        // debounced sync is scheduled. Even with the disk content
        // unchanged, the probe alone is enough to defer a deletion.
        vs.setPendingProbe({
            hasPending: (p: string) => p === path,
        });

        expect(await vs.hasUnpushedChanges(path)).toBe(true);
    });

    it("end-to-end: pull-delete query returns true during a vault drift", async () => {
        // Simulates the main.ts:217 query handler decision shape end to
        // end. Wired directly here without SyncEngine to keep the test
        // focused on the VaultSync primitive.
        const path = "notes/contended.md";
        vault.addFile(path, "v0");
        await vs.fileToDb(path);
        await vs.loadLastSyncedVclocks();

        // Steady state: deletion would be applied.
        let queryResult = await vs.hasUnpushedChanges(path);
        expect(queryResult).toBe(false);

        // User edits the vault. Now the deletion query must report a
        // conflict instead of silently overwriting.
        vault.addFile(path, "user-edit-during-debounce", { size: 25 });
        queryResult = await vs.hasUnpushedChanges(path);
        expect(queryResult).toBe(true);
    });

    it("legacy lastSynced (chunks: undefined) returns false (pre-PR-B behaviour)", async () => {
        // Backwards compat: legacy entries pre-`{chunks,size}` extension
        // can't run the chunks comparison. PR-B falls back to "no
        // pending" rather than panicking. PR5 of the prior plan
        // upgrades these entries on the next reconcile pass.
        const path = "notes/legacy.md";
        vault.addFile(path, "v0");
        await vs.fileToDb(path);

        // Strip chunks/size from the meta to simulate legacy shape.
        const fileDoc = (await db.get(makeFileId(path))) as any;
        await db.runWriteTx({
            vclocks: [{ path, op: "set", clock: fileDoc.vclock ?? {} }],
        });
        await vs.loadLastSyncedVclocks();
        expect(vs.getLastSynced(path)?.chunks).toBeUndefined();

        // Vault drifts after the legacy meta is in place, but without
        // the baseline chunks we can't tell. Conservative false.
        vault.addFile(path, "v1 different", { size: 12 });
        expect(await vs.hasUnpushedChanges(path)).toBe(false);
    });
});
