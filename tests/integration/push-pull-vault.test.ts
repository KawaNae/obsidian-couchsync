/**
 * Integration test: push → pull → vault
 *
 * Exercises the full sync path using real VaultSync + real DexieStore +
 * real chunker/vector-clock, with only the vault I/O faked. This is the
 * test tier that would have caught the "onCommit dropped → pull data
 * never reaches vault" bug.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, afterEach } from "vitest";
import { VaultSync } from "../../src/sync/vault-sync.ts";
import { FilesystemVaultWriter } from "../../src/sync/vault-writer.ts";
import { LocalDB } from "../../src/db/local-db.ts";
import { ConflictResolver } from "../../src/conflict/conflict-resolver.ts";
import { FakeVaultIO } from "../helpers/fake-vault-io.ts";
import { makeSettings } from "../helpers/settings-factory.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";

let counter = 0;
function uniqueDbName(label: string) {
    return `integration-${label}-${Date.now()}-${counter++}`;
}

describe("Integration: push → pull → vault", () => {
    const cleanups: Array<() => Promise<void>> = [];

    function createDevice(deviceId: string) {
        const vault = new FakeVaultIO();
        const db = new LocalDB(uniqueDbName(deviceId));
        db.open();
        const settings = makeSettings({ deviceId });
        const writer = new FilesystemVaultWriter(vault);
        const vs = new VaultSync(vault, db, () => settings, writer);
        cleanups.push(async () => { await db.destroy(); });
        return { vault, db, vs, settings };
    }

    afterEach(async () => {
        for (const fn of cleanups.splice(0)) await fn();
    });

    it("local edit round-trips through push → pull to another device", async () => {
        const devA = createDevice("dev-A");
        const devB = createDevice("dev-B");

        // Device A creates and pushes a file
        devA.vault.addFile("notes/hello.md", "Hello from A!");
        await devA.vs.fileToDb("notes/hello.md");

        // Verify DB on A has the file
        const docA = await devA.db.get(makeFileId("notes/hello.md")) as FileDoc;
        expect(docA).not.toBeNull();
        expect(docA.chunks.length).toBeGreaterThan(0);

        // Simulate transfer: copy FileDoc + ChunkDocs from A's DB to B's DB
        const chunks = await devA.db.getChunks(docA.chunks);
        await devB.db.runWriteTx({
            docs: [{ doc: docA as unknown as CouchSyncDoc }],
            chunks: chunks as unknown as CouchSyncDoc[],
        });

        // Device B pulls the file to vault
        const docB = await devB.db.get(makeFileId("notes/hello.md")) as FileDoc;
        await devB.vs.dbToFile(docB);

        // Verify: file appears in B's vault with correct content
        expect(devB.vault.files.has("notes/hello.md")).toBe(true);
        expect(devB.vault.readText("notes/hello.md")).toBe("Hello from A!");
    });

    it("modified file on A overwrites stale version on B", async () => {
        const devA = createDevice("dev-A");
        const devB = createDevice("dev-B");

        // Both devices start with v1
        devA.vault.addFile("doc.md", "version 1");
        await devA.vs.fileToDb("doc.md");
        const v1 = await devA.db.get(makeFileId("doc.md")) as FileDoc;
        const v1Chunks = await devA.db.getChunks(v1.chunks);
        await devB.db.runWriteTx({
            docs: [{ doc: v1 as unknown as CouchSyncDoc }],
            chunks: v1Chunks as unknown as CouchSyncDoc[],
        });
        await devB.vs.dbToFile(v1);
        devB.vault.addFile("doc.md", "version 1"); // sync baseline

        // Device A edits to v2
        devA.vault.addFile("doc.md", "version 2 from A");
        await devA.vs.fileToDb("doc.md");

        // Transfer v2 to B
        const v2 = await devA.db.get(makeFileId("doc.md")) as FileDoc;
        const v2Chunks = await devA.db.getChunks(v2.chunks);
        await devB.db.runWriteTx({
            docs: [{ doc: v2 as unknown as CouchSyncDoc }],
            chunks: v2Chunks as unknown as CouchSyncDoc[],
        });

        // B pulls v2
        const v2OnB = await devB.db.get(makeFileId("doc.md")) as FileDoc;
        await devB.vs.dbToFile(v2OnB);

        expect(devB.vault.readText("doc.md")).toBe("version 2 from A");
    });

    it("deletion propagates from A to B", async () => {
        const devA = createDevice("dev-A");
        const devB = createDevice("dev-B");

        // Both devices have the file
        devA.vault.addFile("gone.md", "will be deleted");
        await devA.vs.fileToDb("gone.md");
        const doc = await devA.db.get(makeFileId("gone.md")) as FileDoc;
        const chunks = await devA.db.getChunks(doc.chunks);
        await devB.db.runWriteTx({
            docs: [{ doc: doc as unknown as CouchSyncDoc }],
            chunks: chunks as unknown as CouchSyncDoc[],
        });
        await devB.vs.dbToFile(doc);
        expect(devB.vault.files.has("gone.md")).toBe(true);

        // Device A deletes
        await devA.vs.markDeleted("gone.md");
        const tombstone = await devA.db.get(makeFileId("gone.md")) as FileDoc;
        expect(tombstone.deleted).toBe(true);

        // Transfer tombstone to B
        await devB.db.runWriteTx({
            docs: [{ doc: tombstone as unknown as CouchSyncDoc }],
        });

        // B applies tombstone
        const tombstoneOnB = await devB.db.get(makeFileId("gone.md")) as FileDoc;
        await devB.vs.dbToFile(tombstoneOnB);

        expect(devB.vault.files.has("gone.md")).toBe(false);
    });

    it("concurrent edits are detected by ConflictResolver", async () => {
        const devA = createDevice("dev-A");
        const devB = createDevice("dev-B");
        const resolver = new ConflictResolver();

        // Both start with same file
        devA.vault.addFile("shared.md", "original");
        await devA.vs.fileToDb("shared.md");
        const original = await devA.db.get(makeFileId("shared.md")) as FileDoc;
        const origChunks = await devA.db.getChunks(original.chunks);
        // Seed B as if B had pulled the original cleanly: doc + chunks +
        // lastSyncedVclock (so the divergent guard recognizes B as
        // integrated up to dev-A:1 and B's local edit becomes a
        // legitimate push, not a pending pull integration).
        await devB.db.runWriteTx({
            docs: [{ doc: original as unknown as CouchSyncDoc }],
            chunks: origChunks as unknown as CouchSyncDoc[],
            vclocks: [{ path: "shared.md", op: "set", clock: original.vclock ?? {} }],
        });
        // Also seed devB.vault with the original content + reload the
        // VaultSync's in-memory lastSyncedVclock cache from the meta we
        // just persisted. (In production, dbToFile populates both.)
        devB.vault.addFile("shared.md", "original");
        await devB.vs.loadLastSyncedVclocks();

        // Both devices edit independently
        devA.vault.addFile("shared.md", "version A");
        await devA.vs.fileToDb("shared.md");

        devB.vault.addFile("shared.md", "version B");
        await devB.vs.fileToDb("shared.md");

        // When B receives A's version, ConflictResolver detects concurrent
        const localDocOnB = await devB.db.get(makeFileId("shared.md")) as FileDoc;
        const remoteDocFromA = await devA.db.get(makeFileId("shared.md")) as FileDoc;

        const verdict = await resolver.resolveOnPull(localDocOnB, remoteDocFromA);
        expect(verdict).toBe("concurrent");
    });

    it("file with subdirectory is created with parent dir", async () => {
        const devA = createDevice("dev-A");
        const devB = createDevice("dev-B");

        devA.vault.addFile("deep/nested/file.md", "nested content");
        await devA.vs.fileToDb("deep/nested/file.md");

        const doc = await devA.db.get(makeFileId("deep/nested/file.md")) as FileDoc;
        const chunks = await devA.db.getChunks(doc.chunks);
        await devB.db.runWriteTx({
            docs: [{ doc: doc as unknown as CouchSyncDoc }],
            chunks: chunks as unknown as CouchSyncDoc[],
        });

        // B's vault is empty — dbToFile should create parent dirs
        const docOnB = await devB.db.get(makeFileId("deep/nested/file.md")) as FileDoc;
        await devB.vs.dbToFile(docOnB);

        expect(devB.vault.files.has("deep/nested/file.md")).toBe(true);
        expect(devB.vault.readText("deep/nested/file.md")).toBe("nested content");
    });

    it("large file with multiple chunks round-trips correctly", async () => {
        const devA = createDevice("dev-A");
        const devB = createDevice("dev-B");

        // Create a file large enough to produce multiple chunks
        const bigContent = "Line of content\n".repeat(5000);
        devA.vault.addFile("big.md", bigContent);
        await devA.vs.fileToDb("big.md");

        const doc = await devA.db.get(makeFileId("big.md")) as FileDoc;
        expect(doc.chunks.length).toBeGreaterThanOrEqual(1);

        const chunks = await devA.db.getChunks(doc.chunks);
        await devB.db.runWriteTx({
            docs: [{ doc: doc as unknown as CouchSyncDoc }],
            chunks: chunks as unknown as CouchSyncDoc[],
        });

        const docOnB = await devB.db.get(makeFileId("big.md")) as FileDoc;
        await devB.vs.dbToFile(docOnB);

        expect(devB.vault.readText("big.md")).toBe(bigContent);
    });
});
