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

        it("rejects a remote path that escapes the vault (#3 traversal)", async () => {
            vault.addFile("seed.md", "payload");
            await vs.fileToDb("seed.md");
            const seed = await db.get(makeFileId("seed.md")) as FileDoc;

            // Server-controlled _id with a parent-traversal path (the
            // plaintext-vault attack vector). Reuse the valid chunks so only
            // the path is hostile.
            const evil = { ...seed, _id: makeFileId("../evil.md") } as FileDoc;
            const res = await vs.dbToFile(evil);

            expect(res).toEqual({ applied: false, reason: "unsafe-path" });
            expect(vault.files.has("../evil.md")).toBe(false);
        });

        it("rejects a tombstone whose path escapes the vault (#3 delete-via-traversal)", async () => {
            vault.addFile("seed.md", "payload");
            await vs.fileToDb("seed.md");
            const seed = await db.get(makeFileId("seed.md")) as FileDoc;

            // The tombstone branch bypasses shouldSync, so the path gate must
            // precede it — a hostile tombstone must not delete outside the vault.
            const evilDel = { ...seed, _id: makeFileId("../victim.md"), deleted: true } as FileDoc;
            const res = await vs.dbToFile(evilDel);

            expect(res).toEqual({ applied: false, reason: "unsafe-path" });
        });

        it("skips pull when total chunk size exceeds maxFileSizeMB (#4, symmetric to push)", async () => {
            vault.addFile("big.md", "y".repeat(4000));
            await vs.fileToDb("big.md");
            vault.files.delete("big.md");
            const doc = await db.get(makeFileId("big.md")) as FileDoc;

            settings.maxFileSizeMB = 0.001; // ~1 KB, below the ~4 KB content
            const res = await vs.dbToFile(doc);

            expect(res).toEqual({ applied: false, reason: "exceeds-max-size" });
            expect(vault.files.has("big.md")).toBe(false);
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

    // ── classifyFileVsDoc (PR3 — replaces legacy compareFileToDoc) ─

    describe("classifyFileVsDoc", () => {
        it("returns identical when content matches", async () => {
            vault.addFile("a.md", "same");
            await vs.fileToDb("a.md");

            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            const stat = (await vault.stat("a.md"))!;
            const result = await vs.classifyFileVsDoc(doc, "a.md", stat.size);
            expect(result).toBe("identical");
        });

        it("returns local-edit when vault has changed", async () => {
            vault.addFile("a.md", "v1");
            await vs.fileToDb("a.md");
            await vs.loadLastSyncedVclocks();

            // Change vault content without pushing
            vault.addFile("a.md", "v2-local-edit", { size: 999 });

            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            const result = await vs.classifyFileVsDoc(doc, "a.md", 999);
            expect(result).toBe("local-edit");
        });

        it("returns true-divergent when db has newer vclock and vault drifted", async () => {
            vault.addFile("a.md", "v1");
            await vs.fileToDb("a.md");
            await vs.loadLastSyncedVclocks();

            // Simulate remote update by directly modifying DB
            const doc = await db.get(makeFileId("a.md")) as FileDoc;
            const updated = { ...doc, vclock: { "dev-A": 1, "dev-B": 1 }, size: 888 };
            await db.runWriteTx({ docs: [{ doc: updated as any }] });

            // Vault has different content from both lastSynced and remote.
            vault.addFile("a.md", "v1-but-different", { size: 777 });
            const result = await vs.classifyFileVsDoc(updated as FileDoc, "a.md", 777);
            // PR3 classifier detects "right dominates AND left drifted from
            // baseline" → true-divergent (instead of legacy remote-pending
            // which had a separate divergent-edit guard).
            expect(result).toBe("true-divergent");
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

    // ── hasUnpushedChanges (PR-B: chunks-aware, invariant 4) ─

    describe("hasUnpushedChanges", () => {
        it("returns false when no integration baseline exists", async () => {
            expect(await vs.hasUnpushedChanges("a.md")).toBe(false);
        });

        it("returns false when vault matches the integration baseline", async () => {
            vault.addFile("a.md", "content");
            await vs.fileToDb("a.md");

            expect(await vs.hasUnpushedChanges("a.md")).toBe(false);
        });

        it("returns true when vault disk drifts from baseline (size differs)", async () => {
            vault.addFile("a.md", "v1");
            await vs.fileToDb("a.md");

            // Simulate a user edit landing on disk before fileToDb fires.
            vault.addFile("a.md", "v2-local-edit-much-longer", { size: 999 });
            expect(await vs.hasUnpushedChanges("a.md")).toBe(true);
        });

        it("returns true when vault drifts but size is unchanged (chunks differ)", async () => {
            vault.addFile("a.md", "abcde");
            await vs.fileToDb("a.md");
            const ls1 = vs.getLastSynced("a.md")!;

            // Same byte length, different content → different chunks.
            vault.addFile("a.md", "vwxyz", { size: ls1.size });
            expect(await vs.hasUnpushedChanges("a.md")).toBe(true);
        });

        it("returns true when ChangeTracker has a debounced sync pending", async () => {
            vault.addFile("a.md", "content");
            await vs.fileToDb("a.md");
            // Vault disk equals baseline — chunks check would say false.
            expect(await vs.hasUnpushedChanges("a.md")).toBe(false);

            // Wire a fake probe to simulate ChangeTracker reporting pending.
            vs.setPendingProbe({
                hasPending: (p: string) => p === "a.md",
            });
            expect(await vs.hasUnpushedChanges("a.md")).toBe(true);
            expect(await vs.hasUnpushedChanges("other.md")).toBe(false);
        });

        it("returns false when vault file is missing (deletion path handles it)", async () => {
            vault.addFile("a.md", "content");
            await vs.fileToDb("a.md");
            await vault.delete("a.md");

            expect(await vs.hasUnpushedChanges("a.md")).toBe(false);
        });
    });
});
