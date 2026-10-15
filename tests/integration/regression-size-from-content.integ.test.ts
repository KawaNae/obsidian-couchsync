/**
 * A FileDoc's `size` and a baseline's `size` are the size of the content
 * they describe.
 *
 * Shape of the reported case:
 *   1. The sending device took `size` from a stat, then read the file. The
 *      editor saved the note again in between, so the doc carried the
 *      earlier save's size (321) and the later save's chunks (339 bytes).
 *   2. The receiving device wrote the 339 bytes and recorded 321 as the
 *      baseline's size. The disk no longer matched the baseline by size,
 *      so every later version was declined as an unsynced vault change, and
 *      the reconcile offered the device's own synced content as a conflict.
 *
 * The sender now takes the size from the bytes it read; the receiver
 * records the size of the bytes it wrote and judges content by chunks.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { VaultSync } from "../../src/sync/vault-sync.ts";
import { FilesystemVaultWriter } from "../../src/sync/vault-writer.ts";
import { Reconciler } from "../../src/sync/reconciler.ts";
import { LocalDB } from "../../src/db/local-db.ts";
import { PullWriter } from "../../src/db/sync/pull-writer.ts";
import { EchoTracker } from "../../src/db/sync/echo-tracker.ts";
import { SyncEvents } from "../../src/db/sync/sync-events.ts";
import { Checkpoints } from "../../src/db/sync/checkpoints.ts";
import { ConflictResolver } from "../../src/conflict/conflict-resolver.ts";
import { FakeVaultIO } from "../helpers/fake-vault-io.ts";
import { makeSettings } from "../helpers/settings-factory.ts";
import { makePendingApply } from "../helpers/pending-apply.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import { splitIntoChunks } from "../../src/db/chunker.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";
import { FILE_SCHEMA_VERSION } from "../../src/types.ts";

let counter = 0;
function uniqueDbName() { return `size-from-content-${Date.now()}-${counter++}`; }

const enc = new TextEncoder();
const dec = new TextDecoder();
const PATH = "note.md";

/** A vault where the editor saves a file again between a stat and the
 *  next read of it. */
class ResavingVaultIO extends FakeVaultIO {
    private resaves = new Map<string, string>();

    resaveBeforeNextRead(path: string, text: string): void {
        this.resaves.set(path, text);
    }

    override async readBinary(path: string): Promise<ArrayBuffer> {
        const text = this.resaves.get(path);
        if (text !== undefined) {
            this.resaves.delete(path);
            const stat = (await this.stat(path))!;
            this.addFile(path, text, { mtime: stat.mtime + 2000, ctime: stat.ctime });
        }
        return super.readBinary(path);
    }
}

describe("regression: a doc's size is its content's", () => {
    describe("sending device", () => {
        let vault: ResavingVaultIO;
        let db: LocalDB;
        let vs: VaultSync;

        beforeEach(() => {
            vault = new ResavingVaultIO();
            db = new LocalDB(uniqueDbName());
            db.open();
            const settings = makeSettings({ deviceId: "dev-A" });
            vs = new VaultSync(vault, db, () => settings, new FilesystemVaultWriter(vault));
        });

        afterEach(async () => {
            await db.destroy();
        });

        async function expectSizeOfContent(path: string): Promise<void> {
            const doc = await db.get(makeFileId(path)) as FileDoc;
            const bytes = enc.encode(vault.readText(path)).byteLength;
            expect(doc.size).toBe(bytes);
            expect(vs.getLastSynced(path)?.size).toBe(bytes);
        }

        it("fileToDb takes the size from the bytes it read", async () => {
            vault.addFile(PATH, "first save", { mtime: 1000 });
            vault.resaveBeforeNextRead(PATH, "first save, then a longer second save");

            expect(await vs.fileToDb(PATH)).toBe(true);
            await expectSizeOfContent(PATH);
            // The stamp is the pre-read stat's mtime: older than the content,
            // so the next stat misses the cache and the file is hashed.
            expect(vs.getLastSynced(PATH)?.mtime).toBe(1000);
        });

        it("forceLocalEdit takes the size from the bytes it read", async () => {
            vault.addFile(PATH, "first save", { mtime: 1000 });
            vault.resaveBeforeNextRead(PATH, "first save, then a longer second save");

            expect(await vs.forceLocalEdit(PATH)).toBe("written");
            await expectSizeOfContent(PATH);
        });

        it("handleRename takes the size from the bytes it read", async () => {
            vault.addFile("old.md", "first save", { mtime: 1000 });
            await vs.fileToDb("old.md");
            const entry = vault.files.get("old.md")!;
            vault.files.delete("old.md");
            vault.files.set(PATH, entry);
            vault.resaveBeforeNextRead(PATH, "first save, then a longer second save");

            await vs.handleRename(PATH, "old.md");
            await expectSizeOfContent(PATH);
        });
    });

    describe("receiving device", () => {
        let vault: FakeVaultIO;
        let db: LocalDB;
        let vs: VaultSync;
        let reconciler: Reconciler;
        let reported: string[];

        beforeEach(() => {
            vault = new FakeVaultIO();
            db = new LocalDB(uniqueDbName());
            db.open();
            const settings = makeSettings({ deviceId: "dev-B" });
            vs = new VaultSync(vault, db, () => settings, new FilesystemVaultWriter(vault));
            reported = [];
            reconciler = new Reconciler(
                { getFiles: () => vault.getFiles() } as any,
                db, vs, () => settings,
            );
            reconciler.setConflictOrchestrator({
                async handleDivergentLocalEdit(p: string) { reported.push(p); },
                async handleDivergentLocalDelete(p: string) { reported.push(p); },
                async handleDivergentRecreate(p: string) { reported.push(p); },
            } as any);
        });

        afterEach(async () => {
            await db.destroy();
        });

        /** A version from dev-A whose `size` is `size` when given. */
        async function version(text: string, n: number, size?: number): Promise<FileDoc> {
            const buf = enc.encode(text).buffer;
            const chunks = await splitIntoChunks(buf);
            await db.runWriteTx({ chunks: chunks as unknown as CouchSyncDoc[] });
            return {
                _id: makeFileId(PATH), schemaVersion: FILE_SCHEMA_VERSION, type: "file",
                chunks: chunks.map((c) => c._id), mtime: 1, ctime: 1,
                size: size ?? buf.byteLength, vclock: { "dev-A": n },
            };
        }

        async function pull(doc: FileDoc, seq: string): Promise<void> {
            const applyPullWrite = (d: FileDoc) => vs.dbToFile(d);
            await new PullWriter({
                localDb: db,
                events: new SyncEvents(),
                echoes: new EchoTracker(),
                checkpoints: new Checkpoints(db),
                getConflictResolver: () => new ConflictResolver(),
                ensureChunks: async () => {},
                pendingApply: makePendingApply(db, { write: applyPullWrite }),
                getRemoteDoc: async () => null,
                applyPullWrite,
                probeUnpushed: async () => false,
            }).apply({
                results: [{ id: doc._id, seq, doc: doc as unknown as CouchSyncDoc }],
                last_seq: seq,
            });
        }

        const MISSTATED = "the second save, longer than the first";

        it("records the size of the bytes written, and takes the next version", async () => {
            await pull(await version("v1", 1), "1");
            await pull(await version(MISSTATED, 2, 5), "2");
            expect(vault.readText(PATH)).toBe(MISSTATED);
            expect(vs.getLastSynced(PATH)?.size).toBe(enc.encode(MISSTATED).byteLength);

            await pull(await version("v3", 3), "3");
            expect(vault.readText(PATH)).toBe("v3");
        });

        it("the reconcile neither pushes nor offers a conflict around a doc whose size is misstated", async () => {
            await pull(await version("v1", 1), "1");
            const misstated = await version(MISSTATED, 2, 5);
            await pull(misstated, "2");

            await reconciler.reconcile("manual");
            expect(reported).toEqual([]);
            const doc = await db.get(makeFileId(PATH)) as FileDoc;
            expect(doc.vclock).toEqual(misstated.vclock);

            await pull(await version("v3", 3), "3");
            await reconciler.reconcile("manual");
            expect(reported).toEqual([]);
            expect(vault.readText(PATH)).toBe("v3");
        });

        it("a baseline already recorded with a misstated size does not hold back the next version", async () => {
            await pull(await version("v1", 1), "1");
            const misstated = await version(MISSTATED, 2, 5);
            await pull(misstated, "2");
            // The record an earlier version left: the doc's size, not the disk's.
            await db.runWriteTx({
                vclocks: [{
                    path: PATH, op: "set", clock: misstated.vclock,
                    chunks: misstated.chunks, size: misstated.size,
                }],
            });
            await vs.loadLastSyncedVclocks();

            await reconciler.reconcile("manual");
            expect(reported).toEqual([]);
            await pull(await version("v3", 3), "3");
            expect(vault.readText(PATH)).toBe("v3");
        });
    });
});
