/**
 * Regression: case-only / NFC-variant renames permanently reverted
 * (2026-06-07 bug hunt, MEDIUM).
 *
 * Old handleRename desugared into fileToDb(new) + markDeleted(old):
 *   1. fileToDb minted the new doc at {self:1} (old vclock discarded) and
 *      clobbered the SHARED PathKey baseline (toPathKey folds case+NFC);
 *   2. markDeleted's divergent guard saw the old doc dominate the clobbered
 *      baseline → false "pending pull integration" → tombstone never made;
 *   3. reconcile Case F picked the old doc (causal dominator) as canonical
 *      and physically reverted the rename — every retry hit the same loop.
 *
 * Fixed shape asserted here: rename is ONE WriteTransaction committing the
 * new doc (old causality inherited, newVC ≻ tombVC strictly — equal vclocks
 * would converge to fleet-wide deletion via Case D's "stale bookkeeping"
 * branch), the old tombstone, and the correct baselines (one alive entry
 * when the PathKey is shared).
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
function uniqueDbName() { return `case-rename-${Date.now()}-${counter++}`; }

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

function makeRig(opts: { caseInsensitive?: boolean } = {}) {
    const vault = new FakeVaultIO(opts);
    const db = new LocalDB(uniqueDbName());
    db.open();
    const settings = makeSettings({ deviceId: DEV });
    const vs = new VaultSync(vault, db, () => settings, new ApplyingVaultWriter(vault));
    const reconciler = new Reconciler(
        { getFiles: () => vault.getFiles() } as any,
        db, vs, () => settings,
    );
    return { vault, db, vs, settings, reconciler };
}

/** Simulate the disk side of a rename (Obsidian has already moved the file
 *  when the rename event fires). */
function diskRename(vault: FakeVaultIO, oldPath: string, newPath: string): void {
    const content = vault.readText(oldPath);
    vault.files.delete(oldPath);
    vault.addFile(newPath, content);
}

describe("regression: case-only rename revert", () => {
    let rig: ReturnType<typeof makeRig>;
    afterEach(async () => { await rig.db.destroy(); });

    describe("sender side", () => {
        beforeEach(() => { rig = makeRig(); });

        it("case-only rename: ONE tx commits tombstone + new doc with strict domination", async () => {
            const { vault, db, vs } = rig;
            vault.addFile("Note.md", "body v1\n");
            await vs.fileToDb("Note.md");
            const oldDoc = await db.get(makeFileId("Note.md")) as FileDoc;
            expect(oldDoc.vclock).toEqual({ [DEV]: 1 });

            diskRename(vault, "Note.md", "note.md");
            await vs.handleRename("note.md", "Note.md");

            const tomb = await db.get(makeFileId("Note.md")) as FileDoc;
            const newDoc = await db.get(makeFileId("note.md")) as FileDoc;
            // Old doc is a tombstone inheriting the old causality.
            expect(tomb.deleted).toBe(true);
            expect(compareVC(tomb.vclock!, oldDoc.vclock!)).toBe("dominates");
            // newVC strictly dominates tombVC (equal would converge to
            // fleet-wide deletion on case-insensitive receivers).
            expect(newDoc.deleted ?? false).toBe(false);
            expect(compareVC(newDoc.vclock!, tomb.vclock!)).toBe("dominates");
            // Shared PathKey ⇒ exactly the alive baseline survives.
            const ls = vs.getLastSynced("note.md");
            expect(ls?.deleted).toBeUndefined();
            expect(ls?.vclock).toEqual(newDoc.vclock);
        });

        it("reconcile right after the rename is a no-op (no revert loop)", async () => {
            const { vault, db, vs, reconciler } = rig;
            vault.addFile("Note.md", "body v1\n");
            await vs.fileToDb("Note.md");
            diskRename(vault, "Note.md", "note.md");
            await vs.handleRename("note.md", "Note.md");

            const before = await db.get(makeFileId("note.md")) as FileDoc;
            const report = await reconciler.reconcile("manual");

            // No push/pull/delete churn; the renamed file stays.
            expect(report.pushed).toEqual([]);
            expect(report.deleted).toEqual([]);
            expect(report.restored).toEqual([]);
            expect(await vault.exists("note.md")).toBe(true);
            expect(vault.getFiles().map((f) => f.path)).toEqual(["note.md"]);
            const after = await db.get(makeFileId("note.md")) as FileDoc;
            expect(after.vclock).toEqual(before.vclock);
        });

        it("renaming back is idempotent (no vclock explosion, converges each time)", async () => {
            const { vault, db, vs } = rig;
            vault.addFile("Note.md", "body\n");
            await vs.fileToDb("Note.md");
            diskRename(vault, "Note.md", "note.md");
            await vs.handleRename("note.md", "Note.md");
            diskRename(vault, "note.md", "Note.md");
            await vs.handleRename("Note.md", "note.md");

            const docA = await db.get(makeFileId("Note.md")) as FileDoc;
            const docB = await db.get(makeFileId("note.md")) as FileDoc;
            expect(docA.deleted ?? false).toBe(false);
            expect(docB.deleted).toBe(true);
            expect(compareVC(docA.vclock!, docB.vclock!)).toBe("dominates");
            expect(vs.getLastSynced("Note.md")?.deleted).toBeUndefined();
        });

        it("NFC/NFD variant rename behaves like case-only (shared PathKey)", async () => {
            const { vault, db, vs } = rig;
            // 「ぽ」 decomposes under NFD (po → ho + handakuten) — unlike
            // katakana メモ, which is NFD-stable and would degenerate into a
            // same-path no-op rename.
            const nfd = "ぽえむ".normalize("NFD") + ".md";
            const nfc = "ぽえむ".normalize("NFC") + ".md";
            expect(nfd).not.toBe(nfc); // sanity: a real NFD/NFC variant pair
            vault.addFile(nfd, "body\n");
            await vs.fileToDb(nfd);
            diskRename(vault, nfd, nfc);
            await vs.handleRename(nfc, nfd);

            const tomb = await db.get(makeFileId(nfd)) as FileDoc;
            const newDoc = await db.get(makeFileId(nfc)) as FileDoc;
            expect(tomb.deleted).toBe(true);
            expect(compareVC(newDoc.vclock!, tomb.vclock!)).toBe("dominates");
            expect(vs.getLastSynced(nfc)?.deleted).toBeUndefined();
        });

        it("rename combined with an edit carries the NEW content", async () => {
            const { vault, db, vs } = rig;
            vault.addFile("Note.md", "old content\n");
            await vs.fileToDb("Note.md");
            // Edit landed on disk just before the rename event is handled.
            vault.files.delete("Note.md");
            vault.addFile("note.md", "edited during rename\n");
            await vs.handleRename("note.md", "Note.md");

            const newDoc = await db.get(makeFileId("note.md")) as FileDoc;
            const buf = new TextEncoder().encode("edited during rename\n").buffer;
            const chunks = await splitIntoChunks(buf);
            expect(newDoc.chunks).toEqual(chunks.map((c) => c._id));
        });

        it("normal rename (different PathKey) writes alive@new + deleted@old baselines", async () => {
            const { vault, db, vs } = rig;
            vault.addFile("alpha.md", "body\n");
            await vs.fileToDb("alpha.md");
            diskRename(vault, "alpha.md", "beta.md");
            await vs.handleRename("beta.md", "alpha.md");

            const tomb = await db.get(makeFileId("alpha.md")) as FileDoc;
            expect(tomb.deleted).toBe(true);
            expect(vs.getLastSynced("alpha.md")).toMatchObject({ deleted: true });
            expect(vs.getLastSynced("beta.md")?.deleted).toBeUndefined();
        });

        it("divergent old doc degrades: new path committed, old doc untouched", async () => {
            const { vault, db, vs } = rig;
            vault.addFile("alpha.md", "local body\n");
            await vs.fileToDb("alpha.md");
            // Simulate a pull advancing the old doc past our baseline
            // (pending integration) — markDeleted's guard shape.
            const oldDoc = await db.get(makeFileId("alpha.md")) as FileDoc;
            const advanced = { ...oldDoc, vclock: { ...oldDoc.vclock, "dev-B": 1 } };
            await db.runWriteTx({ docs: [{ doc: advanced as unknown as CouchSyncDoc }] });

            diskRename(vault, "alpha.md", "beta.md");
            await vs.handleRename("beta.md", "alpha.md");

            // Old doc must NOT be tombstoned (the other device's edit is
            // pending integration); the new path is committed.
            const after = await db.get(makeFileId("alpha.md")) as FileDoc;
            expect(after.deleted ?? false).toBe(false);
            expect(after.vclock).toEqual(advanced.vclock);
            const newDoc = await db.get(makeFileId("beta.md")) as FileDoc;
            expect(newDoc.deleted ?? false).toBe(false);
        });

        it("rename of a never-synced file: new path only, no stray tombstone", async () => {
            const { vault, db, vs } = rig;
            // No fileToDb — the file was created and renamed before the
            // debounce fired.
            vault.addFile("draft.md", "body\n");
            diskRename(vault, "draft.md", "final.md");
            await vs.handleRename("final.md", "draft.md");

            expect(await db.get(makeFileId("draft.md"))).toBeNull();
            const newDoc = await db.get(makeFileId("final.md")) as FileDoc;
            expect(newDoc.deleted ?? false).toBe(false);
            expect(newDoc.vclock).toEqual({ [DEV]: 1 });
        });
    });

    describe("receiver side (pull-applied rename, convergence matrix)", () => {
        /** Build the sender's two docs for `Note.md → note.md`. */
        async function senderDocs() {
            const buf = new TextEncoder().encode("body v1\n").buffer;
            const chunks = await splitIntoChunks(buf);
            const tomb: FileDoc = {
                _id: makeFileId("Note.md"), type: "file",
                chunks: chunks.map((c) => c._id),
                mtime: 1, ctime: 1, size: buf.byteLength,
                deleted: true, vclock: { [DEV]: 2 },
            };
            const newDoc: FileDoc = {
                _id: makeFileId("note.md"), type: "file",
                chunks: chunks.map((c) => c._id),
                mtime: 2, ctime: 1, size: buf.byteLength,
                vclock: { [DEV]: 3 }, // newVC ≻ tombVC
            };
            return { tomb, newDoc, chunks };
        }

        /** Seed a receiver that had integrated Note.md at {dev-A:1}. */
        async function seedReceiver(rig2: ReturnType<typeof makeRig>) {
            const { vault, db, vs } = rig2;
            vault.addFile("Note.md", "body v1\n");
            const buf = new TextEncoder().encode("body v1\n").buffer;
            const chunks = await splitIntoChunks(buf);
            const doc: FileDoc = {
                _id: makeFileId("Note.md"), type: "file",
                chunks: chunks.map((c) => c._id),
                mtime: 1, ctime: 1, size: buf.byteLength,
                vclock: { [DEV]: 1 },
            };
            await db.runWriteTx({
                chunks: chunks as unknown as CouchSyncDoc[],
                docs: [{ doc: doc as unknown as CouchSyncDoc }],
            });
            await vs.dbToFile(doc); // establishes the baseline
        }

        for (const caseInsensitive of [false, true]) {
            for (const tombstoneFirst of [false, true]) {
                const fsLabel = caseInsensitive ? "case-insensitive" : "case-sensitive";
                const orderLabel = tombstoneFirst ? "tombstone first" : "new doc first";
                it(`${fsLabel} FS, ${orderLabel}: converges to the new case`, async () => {
                    rig = makeRig({ caseInsensitive });
                    const { vault, db, vs, reconciler } = rig;
                    await seedReceiver(rig);
                    const { tomb, newDoc, chunks } = await senderDocs();

                    // Pull lands both docs in LocalDB (replication layer),
                    // then dbToFile applies them in the given order.
                    await db.runWriteTx({
                        chunks: chunks as unknown as CouchSyncDoc[],
                        docs: [
                            { doc: tomb as unknown as CouchSyncDoc },
                            { doc: newDoc as unknown as CouchSyncDoc },
                        ],
                    });
                    const order = tombstoneFirst ? [tomb, newDoc] : [newDoc, tomb];
                    for (const doc of order) await vs.dbToFile(doc);

                    // Reconcile settles whatever churn the order produced.
                    // (Worst case — insensitive FS, new doc first — needs the
                    // delete→restore pass; run twice to reach steady state.)
                    await reconciler.reconcile("manual");
                    await reconciler.reconcile("manual");

                    // Converged: exactly one physical file, under some case
                    // variant, with the new doc alive and the old doc dead.
                    const files = vault.getFiles().map((f) => f.path);
                    expect(files).toHaveLength(1);
                    expect(files[0].toLowerCase()).toBe("note.md");
                    const dNew = await db.get(makeFileId("note.md")) as FileDoc;
                    const dOld = await db.get(makeFileId("Note.md")) as FileDoc;
                    expect(dNew.deleted ?? false).toBe(false);
                    expect(dOld.deleted).toBe(true);
                });
            }
        }
    });
});
