/**
 * E2E: round-trip a 5MB binary file through real CouchDB. Exercises
 * multi-chunk assembly, bulkDocs batching, and base64 transport.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createE2EHarness, stripLocalRevs, type E2EHarness } from "./couch-harness.ts";
import { expectVault } from "../harness/assertions.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";

describe("E2E: large-file roundtrip (real CouchDB)", () => {
    let h: E2EHarness;

    beforeEach(async () => {
        h = await createE2EHarness({ uniqueDb: true });
    });

    afterEach(async () => {
        if (h) await h.destroyAll();
    });

    it("5MB binary file survives push → pull → vault byte-for-byte", async () => {
        const a = h.addDevice("dev-A");
        const b = h.addDevice("dev-B");

        // 5 MiB of pseudo-random bytes (deterministic seed for reproducibility).
        const SIZE = 5 * 1024 * 1024;
        const buf = new Uint8Array(SIZE);
        let s = 0x12345678;
        for (let i = 0; i < SIZE; i++) {
            s = (s * 1664525 + 1013904223) >>> 0;
            buf[i] = s & 0xff;
        }

        a.vault.addBinaryFile("big.bin", buf.buffer);
        await a.vs.fileToDb("big.bin");

        const fileId = makeFileId("big.bin");
        const docA = (await a.db.get(fileId)) as FileDoc;
        expect(docA.chunks.length).toBeGreaterThan(1);

        const chunksA = await a.db.getChunks(docA.chunks);
        await a.client.bulkDocs(stripLocalRevs([docA, ...chunksA]));

        // Pull to B.
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

        expectVault(b.vault).toHaveFile("big.bin").withSize(SIZE);
        expectVault(b.vault).toHaveFile("big.bin").withBinary(buf.buffer);
    });
});
