/**
 * E2E: true end-to-end roundtrip through the REAL sync engine + real CouchDB.
 *
 * Unlike the old version (which hand-rolled bulkDocs with inline chunk
 * content and so never exercised the attachment path), this drives the
 * production push/pull pipeline: device A writes to its vault, A's
 * PushPipeline stores chunks as binary attachments, and B's PullPipeline
 * (catchup + longpoll) fetches them via getAttachment and reassembles them
 * into B's vault. This is the path that real devices use — and the only one
 * that would have caught the content-less / still-encrypted field bugs.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createE2EHarness, waitFor, bytesEqual, type E2EHarness } from "./couch-harness.ts";

describe("E2E: roundtrip (real engine + real CouchDB)", () => {
    let h: E2EHarness;

    beforeEach(async () => {
        h = await createE2EHarness({ uniqueDb: true });
    });

    afterEach(async () => {
        if (h) await h.destroyAll();
    });

    it("A writes → real push → B real pull → B's vault matches (text)", async () => {
        const a = h.addDevice("dev-A");
        const b = h.addDevice("dev-B");

        // Local write BEFORE start so A's first push cycle ships it immediately.
        a.vault.addFile("notes/shared.md", "from A");
        await a.vs.fileToDb("notes/shared.md");

        await a.engine.start();
        await b.engine.start();

        await waitFor(
            async () => (await b.vault.exists("notes/shared.md"))
                && b.vault.readText("notes/shared.md") === "from A",
            { label: "B receives notes/shared.md via real pull" },
        );
        expect(b.vault.readText("notes/shared.md")).toBe("from A");
    });

    it("binary file roundtrips byte-for-byte via the attachment path", async () => {
        const a = h.addDevice("dev-A");
        const b = h.addDevice("dev-B");

        // Non-text bytes including 0x00 / 0xFF — would corrupt under any
        // text-coercing transport. The attachment path must preserve them.
        const bytes = new Uint8Array([0, 1, 2, 127, 128, 200, 255, 0, 42, 99]);
        a.vault.addBinaryFile("blob.bin", bytes.buffer);
        await a.vs.fileToDb("blob.bin");

        await a.engine.start();
        await b.engine.start();

        await waitFor(
            async () => (await b.vault.exists("blob.bin"))
                && bytesEqual(await b.vault.readBinary("blob.bin"), bytes.buffer),
            { label: "B receives blob.bin byte-for-byte" },
        );
        expect(new Uint8Array(await b.vault.readBinary("blob.bin"))).toEqual(bytes);
    });
});

describe("E2E: roundtrip over the encrypted + compressed codec stack", () => {
    let h: E2EHarness;

    beforeEach(async () => {
        // Real Compressing(Encrypting(raw)) stack with a shared key — the path
        // G4 (still-encrypted decompress) lived on. A plaintext-only e2e would
        // never traverse the encrypt/compress decorators or hmac chunk ids.
        h = await createE2EHarness({ uniqueDb: true, codec: { passphrase: "e2e-secret", compression: true } });
    });

    afterEach(async () => {
        if (h) await h.destroyAll();
    });

    it("text + binary roundtrip end-to-end through encrypt+compress", async () => {
        const a = h.addDevice("dev-A");
        const b = h.addDevice("dev-B");

        a.vault.addFile("secret.md", "encrypted hello");
        await a.vs.fileToDb("secret.md");
        const bytes = new Uint8Array([0, 255, 1, 254, 2, 253, 0, 0, 128]);
        a.vault.addBinaryFile("secret.bin", bytes.buffer);
        await a.vs.fileToDb("secret.bin");

        await a.engine.start();
        await b.engine.start();

        await waitFor(
            async () => (await b.vault.exists("secret.md"))
                && b.vault.readText("secret.md") === "encrypted hello"
                && (await b.vault.exists("secret.bin"))
                && bytesEqual(await b.vault.readBinary("secret.bin"), bytes.buffer),
            { label: "B decrypts+decompresses both files end-to-end" },
        );
        expect(b.vault.readText("secret.md")).toBe("encrypted hello");
        expect(new Uint8Array(await b.vault.readBinary("secret.bin"))).toEqual(bytes);
    });
});
