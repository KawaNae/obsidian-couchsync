import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { VaultSync } from "../../src/sync/vault-sync.ts";
import { FilesystemVaultWriter } from "../../src/sync/vault-writer.ts";
import { LocalDB } from "../../src/db/local-db.ts";
import { FakeVaultIO } from "../helpers/fake-vault-io.ts";
import { makeSettings } from "../helpers/settings-factory.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import type { FileDoc } from "../../src/types.ts";

let counter = 0;
function uniqueDbName() { return `vault-sync-test-${Date.now()}-${counter++}`; }

describe("VaultSync", () => {
    let vault: FakeVaultIO;
    let db: LocalDB;
    let vs: VaultSync;
    let settings: ReturnType<typeof makeSettings>;

    beforeEach(() => {
        vault = new FakeVaultIO();
        db = new LocalDB(uniqueDbName());
        db.open();
        settings = makeSettings({ deviceId: "dev-A" });
        const writer = new FilesystemVaultWriter(vault);
        vs = new VaultSync(vault, db, () => settings, writer);
    });

    afterEach(async () => {
        await db.destroy();
    });

    // ── fileToDb ────────────────────────────────────────

    describe("fileToDb", () => {
        it("stores file content as chunks in DB", async () => {
            vault.addFile("hello.md", "Hello, world!");

            await vs.fileToDb("hello.md");

            const fileDoc = await db.get(makeFileId("hello.md")) as FileDoc;
            expect(fileDoc).not.toBeNull();
            expect(fileDoc.type).toBe("file");
            expect(fileDoc.chunks.length).toBeGreaterThan(0);

            // Verify chunks exist
            const chunks = await db.getChunks(fileDoc.chunks);
            expect(chunks.length).toBe(fileDoc.chunks.length);
        });

        it("increments vclock with device ID", async () => {
            vault.addFile("a.md", "content");

            await vs.fileToDb("a.md");

            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            expect(doc.vclock).toEqual({ "dev-A": 1 });
        });

        it("increments existing vclock on second write", async () => {
            vault.addFile("a.md", "v1");
            await vs.fileToDb("a.md");

            // Modify content
            vault.addFile("a.md", "v2");
            await vs.fileToDb("a.md");

            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            expect(doc.vclock["dev-A"]).toBe(2);
        });

        it("skips files exceeding maxFileSizeMB", async () => {
            settings.maxFileSizeMB = 0.001; // ~1 KB
            const bigContent = "x".repeat(2000);
            vault.addFile("big.md", bigContent);

            await vs.fileToDb("big.md");

            const doc = await db.get(makeFileId("big.md"));
            expect(doc).toBeNull();
        });

        it("skips files matching syncIgnore pattern", async () => {
            settings.syncIgnore = "\\.private\\.md$";
            vault.addFile("secret.private.md", "secret");

            await vs.fileToDb("secret.private.md");

            const doc = await db.get(makeFileId("secret.private.md"));
            expect(doc).toBeNull();
        });

        it("skips files not matching syncFilter pattern", async () => {
            settings.syncFilter = "^notes/";
            vault.addFile("outside.md", "content");

            await vs.fileToDb("outside.md");

            const doc = await db.get(makeFileId("outside.md"));
            expect(doc).toBeNull();
        });

        it("does not write when content is unchanged", async () => {
            vault.addFile("a.md", "same");
            await vs.fileToDb("a.md");
            const doc1 = await db.get(makeFileId("a.md")) as FileDoc;

            // Re-push same content
            await vs.fileToDb("a.md");
            const doc2 = await db.get(makeFileId("a.md")) as FileDoc;

            // vclock should NOT have been incremented
            expect(doc2.vclock).toEqual(doc1.vclock);
        });

        it("records stat from vault", async () => {
            vault.addFile("a.md", "content", { mtime: 5000, ctime: 3000 });

            await vs.fileToDb("a.md");

            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            expect(doc.mtime).toBe(5000);
            expect(doc.ctime).toBe(3000);
        });

        it("does nothing when file disappears before read", async () => {
            // Don't add file to vault — stat returns null
            await vs.fileToDb("gone.md");

            const doc = await db.get(makeFileId("gone.md"));
            expect(doc).toBeNull();
        });
    });

    // ── dbToFile ────────────────────────────────────────

    describe("dbToFile", () => {
        it("writes file content to vault", async () => {
            // First push a file to populate DB
            vault.addFile("a.md", "Hello from DB");
            await vs.fileToDb("a.md");

            // Remove from vault, then pull back
            vault.files.delete("a.md");
            const doc = await db.get(makeFileId("a.md")) as FileDoc;

            await vs.dbToFile(doc);

            expect(vault.files.has("a.md")).toBe(true);
            expect(vault.readText("a.md")).toBe("Hello from DB");
        });

        it("overwrites existing file", async () => {
            vault.addFile("a.md", "v1");
            await vs.fileToDb("a.md");

            // Change DB content
            vault.addFile("a.md", "v2");
            await vs.fileToDb("a.md");

            // Reset vault to v1
            vault.addFile("a.md", "v1");
            const doc = await db.get(makeFileId("a.md")) as FileDoc;

            await vs.dbToFile(doc);

            expect(vault.readText("a.md")).toBe("v2");
        });

        it("deletes file for tombstone", async () => {
            vault.addFile("a.md", "content");
            await vs.fileToDb("a.md");

            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            const tombstone = { ...doc, deleted: true } as FileDoc;

            await vs.dbToFile(tombstone);

            expect(vault.files.has("a.md")).toBe(false);
        });

        it("skips write when vault content already matches", async () => {
            vault.addFile("a.md", "same");
            await vs.fileToDb("a.md");

            // Capture vault state, run dbToFile with the doc that
            // matches what's already on disk, expect no mutation.
            const beforeMtime = (await vault.stat("a.md"))?.mtime;
            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            await vs.dbToFile(doc);
            const afterMtime = (await vault.stat("a.md"))?.mtime;

            expect(afterMtime).toBe(beforeMtime);
        });
    });

    // ── compareFileToDoc ────────────────────────────────

    describe("compareFileToDoc", () => {
        it("returns identical when content matches", async () => {
            vault.addFile("a.md", "same");
            await vs.fileToDb("a.md");

            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            const stat = (await vault.stat("a.md"))!;
            const result = await vs.compareFileToDoc(doc, "a.md", stat.size);
            expect(result).toBe("identical");
        });

        it("returns local-unpushed when vault has changed", async () => {
            vault.addFile("a.md", "v1");
            await vs.fileToDb("a.md");
            await vs.loadLastSyncedVclocks();

            // Change vault content without pushing
            vault.addFile("a.md", "v2-local-edit", { size: 999 });

            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            const result = await vs.compareFileToDoc(doc, "a.md", 999);
            expect(result).toBe("local-unpushed");
        });

        it("returns remote-pending when db has newer vclock", async () => {
            vault.addFile("a.md", "v1");
            await vs.fileToDb("a.md");
            await vs.loadLastSyncedVclocks();

            // Simulate remote update by directly modifying DB
            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            const updated = { ...doc, vclock: { "dev-A": 1, "dev-B": 1 }, size: 888 };
            await db.runWriteTx({ docs: [{ doc: updated as any }] });

            vault.addFile("a.md", "v1-unchanged", { size: 777 });
            const result = await vs.compareFileToDoc(updated as FileDoc, "a.md", 777);
            expect(result).toBe("remote-pending");
        });
    });

    // ── markDeleted ─────────────────────────────────────

    describe("markDeleted", () => {
        it("marks existing doc as deleted", async () => {
            vault.addFile("a.md", "content");
            await vs.fileToDb("a.md");

            await vs.markDeleted("a.md");

            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            expect(doc.deleted).toBe(true);
        });

        it("increments vclock on deletion", async () => {
            vault.addFile("a.md", "content");
            await vs.fileToDb("a.md");

            await vs.markDeleted("a.md");

            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            expect(doc.vclock["dev-A"]).toBe(2);
        });
    });

    // ── handleRename ────────────────────────────────────

    describe("handleRename", () => {
        it("creates new doc and deletes old", async () => {
            vault.addFile("old.md", "content");
            await vs.fileToDb("old.md");

            // Simulate rename
            const data = vault.files.get("old.md")!.data;
            vault.files.delete("old.md");
            vault.addBinaryFile("new.md", data);

            await vs.handleRename("new.md", "old.md");

            const newDoc = await db.get(makeFileId("new.md")) as FileDoc;
            const oldDoc = await db.get(makeFileId("old.md")) as FileDoc;
            expect(newDoc).not.toBeNull();
            expect(newDoc.type).toBe("file");
            expect(oldDoc.deleted).toBe(true);
        });
    });

    // ── applyRemoteDeletion ─────────────────────────────

    describe("applyRemoteDeletion", () => {
        it("deletes file from vault and marks in DB", async () => {
            vault.addFile("a.md", "content");
            await vs.fileToDb("a.md");

            await vs.applyRemoteDeletion("a.md");

            expect(vault.files.has("a.md")).toBe(false);
            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            expect(doc.deleted).toBe(true);
        });

        it("handles already-missing file gracefully", async () => {
            vault.addFile("a.md", "content");
            await vs.fileToDb("a.md");
            vault.files.delete("a.md"); // already gone

            await vs.applyRemoteDeletion("a.md");

            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            expect(doc.deleted).toBe(true);
        });
    });

    // ── hasUnpushedChanges ──────────────────────────────

    describe("hasUnpushedChanges", () => {
        it("returns false when no synced vclock exists", async () => {
            expect(vs.hasUnpushedChanges("a.md", { A: 1 })).toBe(false);
        });

        it("returns false when vclock matches", async () => {
            vault.addFile("a.md", "content");
            await vs.fileToDb("a.md");

            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            expect(vs.hasUnpushedChanges("a.md", doc.vclock)).toBe(false);
        });

        it("returns true when vclock differs", async () => {
            vault.addFile("a.md", "v1");
            await vs.fileToDb("a.md");

            // Simulate a second local edit (vclock incremented)
            expect(vs.hasUnpushedChanges("a.md", { "dev-A": 2 })).toBe(true);
        });
    });
});
