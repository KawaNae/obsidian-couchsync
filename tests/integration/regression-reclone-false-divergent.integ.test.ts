/**
 * Regression: re-clone leaves pulled content with no integration baseline,
 * causing a self-vclock stamp and a FALSE concurrent on the source device's
 * next edit (incident 2026-06-02).
 *
 * Root cause: `dbToFile`'s "content already on disk" early-return
 * (vault-sync.ts) returned `{applied:true}` WITHOUT establishing
 * `lastSynced`. After a re-clone of a device whose vault still held the
 * (now-remote-authored) content, those paths had NO integration baseline.
 * The post-clone reconcile then treated them as needing a push and
 * `fileToDb` stamped this device's vclock onto remote-authored content.
 * When the original author edited again, the pull classified the change as
 * `true-divergent` (concurrent) instead of `remote-edit` (clean take-remote)
 * — surfacing a conflict modal that, when closed (= keep-local), overwrote
 * the remote with the stale local copy.
 *
 * Fix: the early-return now adopts `fileDoc.vclock` as the integration
 * baseline (Invariant 3: chunks-equal ⇒ fileDoc is the vclock authority),
 * exactly like `adoptDocVclock` / the normal write path. So every cloned
 * file carries `lastSynced == fileDoc.vclock`, the reconcile classifies it
 * `identical`, and the author's later edit fast-forwards as `remote-edit`.
 *
 * These tests assert the FIXED behavior; they fail against the pre-fix code
 * (lastSynced undefined → push + stamp + false concurrent).
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
import { compareVC } from "../../src/sync/vector-clock.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";

let counter = 0;
function uniqueDbName() { return `reclone-divergent-${Date.now()}-${counter++}`; }

/** A VaultWriter that always applies (no IME skip) — so take-remote lands. */
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

function makeFakeOrchestrator() {
    const calls = { edit: [] as string[], deletion: [] as string[] };
    const orch = {
        async handleDivergentLocalEdit(filePath: string) { calls.edit.push(filePath); },
        async handleDivergentLocalDelete(filePath: string) { calls.deletion.push(filePath); },
    };
    return { orch, calls };
}

/** Build a FileDoc whose chunks encode `content` and persist its chunks. */
async function seedRemoteDoc(
    db: LocalDB,
    path: string,
    content: string,
    vclock: Record<string, number>,
): Promise<FileDoc> {
    const buf = new TextEncoder().encode(content).buffer;
    const chunks = await splitIntoChunks(buf);
    const doc: FileDoc = {
        _id: makeFileId(path),
        type: "file",
        chunks: chunks.map((c) => c._id),
        mtime: Date.now(),
        ctime: Date.now(),
        size: buf.byteLength,
        vclock,
    };
    await db.runWriteTx({
        chunks: chunks as unknown as CouchSyncDoc[],
        docs: [{ doc: doc as unknown as CouchSyncDoc }],
    });
    return doc;
}

describe("regression: re-clone false-divergent (incident 2026-06-02)", () => {
    let vault: FakeVaultIO;
    let db: LocalDB;
    let vs: VaultSync;
    let settings: ReturnType<typeof makeSettings>;

    beforeEach(() => {
        vault = new FakeVaultIO();
        db = new LocalDB(uniqueDbName());
        db.open();
        settings = makeSettings({ deviceId: "dev-B" });
        vs = new VaultSync(vault, db, () => settings, new ApplyingVaultWriter(vault));
    });

    afterEach(async () => {
        await db.destroy();
    });

    it("dbToFile establishes lastSynced when the pulled content is already on disk", async () => {
        const path = "Periodic/DailyNotes/2026-05-31.md";
        // Offline device's vault still holds v0; the same content was pulled
        // from the remote (authored by dev-A) into the DB during a re-clone.
        vault.addFile(path, "v0 body\n");
        const remoteDoc = await seedRemoteDoc(db, path, "v0 body\n", { "dev-A": 1 });

        // Pre-fix: no baseline exists yet.
        expect(vs.getLastSynced(path)).toBeUndefined();

        const result = await vs.dbToFile(remoteDoc);
        expect(result.applied).toBe(true);

        // FIX: the integration baseline now equals the remote doc's vclock —
        // NOT empty, and crucially NOT stamped with dev-B.
        const ls = vs.getLastSynced(path);
        expect(ls).toBeDefined();
        expect(ls!.vclock).toEqual({ "dev-A": 1 });
        expect(ls!.chunks).toEqual(remoteDoc.chunks);
        expect(ls!.size).toBe(remoteDoc.size);
    });

    it("post-clone reconcile does NOT push or stamp the cloning device's vclock", async () => {
        const path = "Periodic/DailyNotes/2026-05-31.md";
        vault.addFile(path, "v0 body\n");
        const remoteDoc = await seedRemoteDoc(db, path, "v0 body\n", { "dev-A": 1 });
        // Simulate the clone's dbToFile pass (content already on disk).
        await vs.dbToFile(remoteDoc);

        const reconciler = new Reconciler(
            { getFiles: () => vault.getFiles() } as any,
            db, vs, () => settings,
        );
        const { orch, calls } = makeFakeOrchestrator();
        reconciler.setConflictOrchestrator(orch as any);

        await reconciler.reconcile("setup");

        // The doc must remain authored solely by dev-A — no self-stamp.
        const doc = await db.get(makeFileId(path)) as FileDoc;
        expect(doc.vclock).toEqual({ "dev-A": 1 });
        expect(Object.keys(doc.vclock ?? {})).not.toContain("dev-B");
        expect(calls.edit).toHaveLength(0);
    });

    it("the source device's later edit fast-forwards as remote-edit (clean take-remote), not concurrent", async () => {
        const path = "Periodic/DailyNotes/2026-05-31.md";
        vault.addFile(path, "v0 body\n");
        const v0Doc = await seedRemoteDoc(db, path, "v0 body\n", { "dev-A": 1 });
        await vs.dbToFile(v0Doc); // clone re-apply → baseline established by fix

        // dev-A edits the file again: the DB doc advances to v1 (vclock
        // dominates v0), vault still holds v0, lastSynced still at v0.
        const v1Doc = await seedRemoteDoc(db, path, "v1 body — author edit\n", { "dev-A": 2 });

        const reconciler = new Reconciler(
            { getFiles: () => vault.getFiles() } as any,
            db, vs, () => settings,
        );
        const { orch, calls } = makeFakeOrchestrator();
        reconciler.setConflictOrchestrator(orch as any);

        // Classifier verdict: with the baseline at v0 (matching disk), a
        // dominating remote is a pure remote-edit, never true-divergent.
        const relation = await vs.classifyFileVsDoc(v1Doc, path, (await vault.stat(path))!);
        expect(relation).toBe("remote-edit");

        await reconciler.reconcile("paused");

        // No conflict surfaced; vault converged to the author's v1.
        expect(calls.edit).toHaveLength(0);
        expect(vault.readText(path)).toBe("v1 body — author edit\n");

        // Baseline advanced to v1; still no dev-B stamp anywhere.
        const ls = vs.getLastSynced(path);
        expect(ls!.vclock).toEqual({ "dev-A": 2 });
        const doc = await db.get(makeFileId(path)) as FileDoc;
        expect(compareVC(doc.vclock ?? {}, { "dev-A": 2 })).toBe("equal");
    });
});
