/**
 * Smoke test for assertion helpers: verifies the effect-first fluent API
 * works against a real harness + LocalDB + FakeVaultIO + FakeCouchClient.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, afterEach } from "vitest";
import { createSyncHarness } from "./sync-harness.ts";
import { expectVault, expectDb, expectCouch } from "./assertions.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";

describe("assertion helpers — smoke", () => {
    const harnesses: Array<{ destroyAll: () => Promise<void> }> = [];

    afterEach(async () => {
        for (const h of harnesses.splice(0)) await h.destroyAll();
    });

    it("expectVault — toHaveFile / toNotHaveFile / withContent / withSize", async () => {
        const h = createSyncHarness();
        harnesses.push(h);
        const a = h.addDevice("dev-A");

        a.vault.addFile("note.md", "hello world");

        expectVault(a.vault).toHaveFile("note.md").withContent("hello world");
        expectVault(a.vault).toHaveFile("note.md").withSize(11);
        expectVault(a.vault).toNotHaveFile("missing.md");
        expectVault(a.vault).toHaveFileCount(1);

        expect(() =>
            expectVault(a.vault).toHaveFile("missing.md")
        ).toThrow();
        expect(() =>
            expectVault(a.vault).toHaveFile("note.md").withContent("wrong")
        ).toThrow();
    });

    it("expectDb — toHaveFileDoc withChunks + deleted + toHaveLastSyncedVclock", async () => {
        const h = createSyncHarness();
        harnesses.push(h);
        const a = h.addDevice("dev-A");

        a.vault.addFile("doc.md", "payload");
        await a.vs.fileToDb("doc.md");

        await expectDb(a.db).toHaveFileDoc("doc.md").withChunks(1);

        // lastSyncedVclock should be persisted after fileToDb.
        const doc = (await a.db.get(makeFileId("doc.md"))) as FileDoc;
        await expectDb(a.db).toHaveLastSyncedVclock("doc.md", doc.vclock ?? {});

        // mark deleted
        await a.vs.markDeleted("doc.md");
        await expectDb(a.db).toHaveFileDoc("doc.md").deleted();
    });

    it("expectCouch — toHaveDoc / toNotHaveDoc / satisfying", async () => {
        const h = createSyncHarness();
        harnesses.push(h);
        const a = h.addDevice("dev-A");

        a.vault.addFile("x.md", "body");
        await a.vs.fileToDb("x.md");
        const fileId = makeFileId("x.md");
        const doc = (await a.db.get(fileId)) as FileDoc;
        const chunks = await a.db.getChunks(doc.chunks);
        await h.couch.bulkDocs([
            doc as unknown as CouchSyncDoc,
            ...(chunks as unknown as CouchSyncDoc[]),
        ]);

        (await expectCouch(h.couch).toHaveDoc<FileDoc>(fileId)).satisfying(
            (d) => d.chunks.length >= 1,
        );
        await expectCouch(h.couch).toNotHaveDoc(makeFileId("ghost.md"));
        await expectCouch(h.couch).toHaveDocCount(1 + chunks.length);
    });
});
