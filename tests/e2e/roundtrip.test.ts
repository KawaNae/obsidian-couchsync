/**
 * E2E: push → pull roundtrip across 2 devices using a real CouchDB.
 *
 * 前提: docker-compose up で CouchDB が :5984 に起動済み。
 * 実行: npm run test:e2e
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createE2EHarness, type E2EHarness } from "./couch-harness.ts";
import { expectVault, expectCouch } from "../harness/assertions.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";

describe("E2E: roundtrip (real CouchDB)", () => {
    let h: E2EHarness;

    beforeAll(async () => {
        h = await createE2EHarness();
    });

    beforeEach(async () => {
        await h.destroyAll();
        await h.resetCouch();
    });

    afterAll(async () => {
        if (h) await h.destroyAll();
    });

    it("A pushes FileDoc + chunks → real CouchDB retains them", async () => {
        const a = h.addDevice("dev-A");
        a.vault.addFile("notes/hello.md", "Hello from A!");
        await a.vs.fileToDb("notes/hello.md");

        const fileId = makeFileId("notes/hello.md");
        const docA = (await a.db.get(fileId)) as FileDoc;
        const chunksA = await a.db.getChunks(docA.chunks);

        await a.client.bulkDocs([
            docA as unknown as CouchSyncDoc,
            ...(chunksA as unknown as CouchSyncDoc[]),
        ]);

        const info = await a.client.info();
        expect(info.doc_count).toBeGreaterThanOrEqual(1 + chunksA.length);

        await expectCouch(a.client).toHaveDoc<FileDoc>(fileId).then(
            (e) => e.satisfying((d) => d.chunks.length === docA.chunks.length),
        );
    });

    it("A pushes → B pulls via bulkGet → B's vault matches", async () => {
        const a = h.addDevice("dev-A");
        const b = h.addDevice("dev-B");

        a.vault.addFile("notes/shared.md", "from A");
        await a.vs.fileToDb("notes/shared.md");
        const fileId = makeFileId("notes/shared.md");
        const docA = (await a.db.get(fileId)) as FileDoc;
        const chunksA = await a.db.getChunks(docA.chunks);
        await a.client.bulkDocs([
            docA as unknown as CouchSyncDoc,
            ...(chunksA as unknown as CouchSyncDoc[]),
        ]);

        // B pulls via bulkGet.
        const ids = [fileId, ...docA.chunks];
        const fetched = await b.client.bulkGet<CouchSyncDoc>(ids);
        const fileDocs = fetched.filter((d) => d._id === fileId);
        const chunkDocs = fetched.filter((d) => d._id !== fileId);
        await b.db.runWriteTx({
            docs: fileDocs.map((doc) => ({ doc })),
            chunks: chunkDocs,
        });
        const docOnB = (await b.db.get(fileId)) as FileDoc;
        await b.vs.dbToFile(docOnB);

        expectVault(b.vault).toHaveFile("notes/shared.md").withContent("from A");
    });
});
