/**
 * Clone writes the server's version of every path into the vault, replacing
 * the vault's file at the same path, as its confirmation tells the user —
 * including a file changed since this device last synced it, which a pull
 * would leave alone.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, afterEach } from "vitest";
import { VaultSync } from "../../src/sync/vault-sync.ts";
import { FilesystemVaultWriter } from "../../src/sync/vault-writer.ts";
import { SetupService } from "../../src/sync/setup.ts";
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
});
