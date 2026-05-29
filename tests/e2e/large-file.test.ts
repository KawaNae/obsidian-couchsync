/**
 * E2E: round-trip a 5MB binary file through the REAL engine + real CouchDB.
 * Exercises multi-chunk split, attachment push (bulkDocsWithAttachments),
 * longpoll pull, on-demand chunk fetch (getAttachment), and reassembly —
 * byte-for-byte. Drives the production pipeline, not a hand-rolled bulkDocs.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createE2EHarness, waitFor, bytesEqual, type E2EHarness } from "./couch-harness.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import type { FileDoc } from "../../src/types.ts";

describe("E2E: large-file roundtrip (real engine + real CouchDB)", () => {
    let h: E2EHarness;

    beforeEach(async () => {
        h = await createE2EHarness({ uniqueDb: true });
    });

    afterEach(async () => {
        if (h) await h.destroyAll();
    });

    it("5MB binary file survives real push → real pull → vault byte-for-byte", async () => {
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

        // Sanity: the file really did split into multiple chunks.
        const docA = (await a.db.get(makeFileId("big.bin"))) as FileDoc;
        expect(docA.chunks.length).toBeGreaterThan(1);

        await a.engine.start();
        await b.engine.start();

        await waitFor(
            async () => (await b.vault.exists("big.bin"))
                && bytesEqual(await b.vault.readBinary("big.bin"), buf.buffer),
            { label: "B reassembles 5MB big.bin byte-for-byte", timeoutMs: 9000 },
        );
        expect((await b.vault.readBinary("big.bin")).byteLength).toBe(SIZE);
    });
});
