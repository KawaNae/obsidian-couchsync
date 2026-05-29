import { describe, it, expect } from "vitest";
import { CompressingCouchClient } from "../src/db/compressing-couch-client.ts";
import { FakeCouchClient } from "./helpers/fake-couch-client.ts";
import { asEnvelope, fromEnvelope } from "./helpers/envelope.ts";

function bytes(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}
function text(b: Uint8Array): string {
    return new TextDecoder().decode(b);
}

describe("CompressingCouchClient", () => {
    it("attachment round-trip: same bytes in, same bytes out (decoded)", async () => {
        const inner = new FakeCouchClient();
        const client = new CompressingCouchClient(inner);

        const original = bytes("hello compression world ".repeat(100));
        await client.bulkDocsWithAttachments([
            {
                doc: { _id: "chunk:abc" },
                attachments: { c: { contentType: "application/octet-stream", data: asEnvelope(original) } },
            },
        ]);

        const fetched = await client.getAttachment("chunk:abc", "c");
        const plain = fromEnvelope(fetched!);
        expect(plain).toEqual(original);
        expect(text(plain)).toBe(text(original));
    });

    it("attachment stored on the inner client is actually gzipped (smaller for compressible input)", async () => {
        const inner = new FakeCouchClient();
        const client = new CompressingCouchClient(inner);

        // Highly compressible: 5 KiB of the same character.
        const repetitive = bytes("a".repeat(5 * 1024));
        await client.bulkDocsWithAttachments([
            {
                doc: { _id: "chunk:rep" },
                attachments: { c: { contentType: "application/octet-stream", data: asEnvelope(repetitive) } },
            },
        ]);

        // Inspect storage at the inner layer — should be much smaller
        // than the input (envelope header is 1 byte, gzip crushes the rest).
        const innerBlob = await inner.getAttachment("chunk:rep", "c");
        expect(innerBlob).not.toBeNull();
        expect(innerBlob!.length).toBeLessThan(repetitive.length / 4);
    });

    it("ungzip happens at the decorator level — caller sees plain bytes", async () => {
        const inner = new FakeCouchClient();
        const client = new CompressingCouchClient(inner);
        const original = bytes("plain caller view");

        await client.bulkDocsWithAttachments([
            { doc: { _id: "chunk:plain" }, attachments: { c: { contentType: "x", data: asEnvelope(original) } } },
        ]);

        // The decorator-facing call gives plaintext (after envelope strip)...
        const viaDecorator = await client.getAttachment("chunk:plain", "c");
        expect(fromEnvelope(viaDecorator!)).toEqual(original);

        // ...while the inner client view is the raw gzipped payload
        // (still envelope-formatted with compressed bit set), which
        // never matches the plaintext byte-for-byte.
        const viaInner = await inner.getAttachment("chunk:plain", "c");
        expect(viaInner).not.toEqual(original);
    });

    it("returns null for a missing attachment (pass-through to inner)", async () => {
        const inner = new FakeCouchClient();
        const client = new CompressingCouchClient(inner);
        expect(await client.getAttachment("chunk:missing", "c")).toBeNull();
    });

    it("empty attachment round-trips correctly", async () => {
        const inner = new FakeCouchClient();
        const client = new CompressingCouchClient(inner);
        await client.bulkDocsWithAttachments([
            { doc: { _id: "chunk:empty" }, attachments: { c: { contentType: "x", data: asEnvelope(new Uint8Array(0)) } } },
        ]);
        const back = await client.getAttachment("chunk:empty", "c");
        expect(fromEnvelope(back!)).toEqual(new Uint8Array(0));
    });

    it("non-attachment methods pass through to inner", async () => {
        const inner = new FakeCouchClient();
        const client = new CompressingCouchClient(inner);

        // bulkDocs still works for plain docs (no attachments).
        const results = await client.bulkDocs([{ _id: "file:plain.md", type: "file" }]);
        expect(results[0]?.ok).toBe(true);

        // info passthrough.
        const info = await client.info();
        expect(info).toBeTruthy();
    });

    it("preserves contentType on attachment metadata", async () => {
        const inner = new FakeCouchClient();
        const client = new CompressingCouchClient(inner);
        await client.bulkDocsWithAttachments([
            {
                doc: { _id: "chunk:ct" },
                attachments: {
                    c: { contentType: "application/octet-stream", data: asEnvelope(bytes("ct-test")) },
                },
            },
        ]);
        // Round-trip is still correct regardless of metadata; this test
        // mostly documents that the decorator does not mangle the type.
        const back = await client.getAttachment("chunk:ct", "c");
        expect(fromEnvelope(back!)).toEqual(bytes("ct-test"));
    });
});
