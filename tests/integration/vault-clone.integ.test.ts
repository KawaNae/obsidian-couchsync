/**
 * Clone writes the server's version of every path into the vault, replacing
 * the vault's file at the same path, as its confirmation tells the user —
 * including a file changed since this device last synced it, which a pull
 * would leave alone.
 *
 * Init goes the other way: it sends the vault and writes nothing to it, so
 * a vault this device never synced raises no conflict there either.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, afterEach } from "vitest";
import { VaultSync } from "../../src/sync/vault-sync.ts";
import { FilesystemVaultWriter } from "../../src/sync/vault-writer.ts";
import { SetupService } from "../../src/sync/setup.ts";
import { Reconciler } from "../../src/sync/reconciler.ts";
import { LocalDB } from "../../src/db/local-db.ts";
import { FakeVaultIO } from "../helpers/fake-vault-io.ts";
import { makeSettings } from "../helpers/settings-factory.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import { splitIntoChunks } from "../../src/db/chunker.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";
import { FILE_SCHEMA_VERSION } from "../../src/types.ts";

let counter = 0;
function uniqueDbName() { return `vault-clone-${Date.now()}-${counter++}`; }

describe("Clone over a changed vault", () => {
    let db: LocalDB;

    afterEach(async () => {
        await db.destroy();
    });

    it("replaces a file edited since the last sync, and deletes one deleted on the server", async () => {
        const vault = new FakeVaultIO();
        db = new LocalDB(uniqueDbName());
        db.open();
        const vs = new VaultSync(
            vault, db, () => makeSettings({ deviceId: "dev-B" }), new FilesystemVaultWriter(vault),
        );
        vault.addFile("a.md", "synced");
        vault.addFile("gone.md", "synced");
        await vs.fileToDb("a.md");
        await vs.fileToDb("gone.md");
        vault.addFile("a.md", "edited here", { mtime: Date.now() + 1000 });
        vault.addFile("gone.md", "edited here too", { mtime: Date.now() + 1000 });

        const buf = new TextEncoder().encode("server").buffer;
        const chunks = await splitIntoChunks(buf);
        const serverDocs: FileDoc[] = [
            {
                _id: makeFileId("a.md"), schemaVersion: FILE_SCHEMA_VERSION, type: "file",
                chunks: chunks.map((c) => c._id), mtime: 1, ctime: 1,
                size: buf.byteLength, vclock: { "dev-A": 3 },
            },
            {
                _id: makeFileId("gone.md"), schemaVersion: FILE_SCHEMA_VERSION, type: "file",
                chunks: [], mtime: 1, ctime: 1, size: 0, vclock: { "dev-A": 4 }, deleted: true,
            },
        ];
        const remoteOps = {
            pullAll: async () => {
                await db.runWriteTx({
                    chunks: chunks as unknown as CouchSyncDoc[],
                    docs: serverDocs.map((d) => ({ doc: d as unknown as CouchSyncDoc })),
                });
                return serverDocs.length;
            },
        };
        const setup = new SetupService(
            vault, db, remoteOps as any, vs, { reconcile: async () => ({}) } as any,
        );

        const result = await setup.clone(() => {});

        expect(vault.readText("a.md")).toBe("server");
        expect(vault.files.has("gone.md")).toBe(false);
        expect(result.vaultFiles).toBe(1);
    });

    /** A real reconcile whose conflict entries only record the paths. */
    function recordingReconciler(vault: FakeVaultIO, vs: VaultSync) {
        const asked: string[] = [];
        const reconciler = new Reconciler(
            { getFiles: () => vault.getFiles() } as any,
            db, vs, () => makeSettings({ deviceId: "dev-B" }),
        );
        reconciler.setConflictOrchestrator({
            async handleDivergentLocalEdit(p: string) { asked.push(p); },
            async handleDivergentLocalDelete(p: string) { asked.push(p); },
            async handleDivergentRecreate(p: string) { asked.push(p); },
        } as any);
        return { reconciler, asked };
    }

    it("replaces files this device never synced, and the reconcile after it asks nothing", async () => {
        // A new device whose vault already holds files: no baselines.
        const vault = new FakeVaultIO();
        db = new LocalDB(uniqueDbName());
        db.open();
        const vs = new VaultSync(
            vault, db, () => makeSettings({ deviceId: "dev-B" }), new FilesystemVaultWriter(vault),
        );
        vault.addFile("differs.md", "local copy");
        vault.addFile("same.md", "server");
        vault.addFile("local-only.md", "only here");

        const buf = new TextEncoder().encode("server").buffer;
        const chunks = await splitIntoChunks(buf);
        const serverDoc = (path: string): FileDoc => ({
            _id: makeFileId(path), schemaVersion: FILE_SCHEMA_VERSION, type: "file",
            chunks: chunks.map((c) => c._id), mtime: 1, ctime: 1,
            size: buf.byteLength, vclock: { "dev-A": 1 },
        });
        const serverDocs = [serverDoc("differs.md"), serverDoc("same.md")];
        const remoteOps = {
            pullAll: async () => {
                await db.runWriteTx({
                    chunks: chunks as unknown as CouchSyncDoc[],
                    docs: serverDocs.map((d) => ({ doc: d as unknown as CouchSyncDoc })),
                });
                return serverDocs.length;
            },
        };
        const { reconciler, asked } = recordingReconciler(vault, vs);
        const setup = new SetupService(vault, db, remoteOps as any, vs, reconciler);

        await setup.clone(() => {});

        expect(vault.readText("differs.md")).toBe("server");
        expect(vault.readText("same.md")).toBe("server");
        expect(vault.readText("local-only.md")).toBe("only here");
        expect(asked).toEqual([]);
        expect(vs.getLastSynced("differs.md")?.chunks).toEqual(serverDocs[0].chunks);
        // The file the server lacks is pushed by the reconcile.
        expect(await db.get(makeFileId("local-only.md"))).not.toBeNull();
    });
});

describe("Init over a vault this device never synced", () => {
    let db: LocalDB;

    afterEach(async () => {
        await db.destroy();
    });

    it("sends every file and the reconcile after it asks nothing", async () => {
        const vault = new FakeVaultIO();
        db = new LocalDB(uniqueDbName());
        db.open();
        const settings = () => makeSettings({ deviceId: "dev-B" });
        const vs = new VaultSync(vault, db, settings, new FilesystemVaultWriter(vault));
        vault.addFile("a.md", "one");
        vault.addFile("b.md", "two");
        const asked: string[] = [];
        const reconciler = new Reconciler({ getFiles: () => vault.getFiles() } as any, db, vs, settings);
        reconciler.setConflictOrchestrator({
            async handleDivergentLocalEdit(p: string) { asked.push(p); },
            async handleDivergentLocalDelete(p: string) { asked.push(p); },
            async handleDivergentRecreate(p: string) { asked.push(p); },
        } as any);
        const remoteOps = { recreateRemote: async () => {}, pushAll: async () => 0 };
        const setup = new SetupService(vault, db, remoteOps as any, vs, reconciler);

        const result = await setup.init(() => {}, async () => {});

        expect(result.vaultFiles).toBe(2);
        expect(asked).toEqual([]);
        expect(vault.readText("a.md")).toBe("one");
        expect(vs.getLastSynced("b.md")?.chunks).toEqual(
            ((await db.get(makeFileId("b.md"))) as FileDoc).chunks,
        );
    });
});
