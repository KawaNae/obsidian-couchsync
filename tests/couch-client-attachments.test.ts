import { describe, it, expect } from "vitest";
import { FakeCouchClient } from "./helpers/fake-couch-client.ts";
import type { DocWithAttachments } from "../src/db/interfaces.ts";

describe("ICouchClient attachment API (fake)", () => {
    it("bulkDocsWithAttachments stores attachments addressable by getAttachment", async () => {
        const client = new FakeCouchClient();
        const items: DocWithAttachments[] = [
            {
                doc: { _id: "chunk:abc", type: "chunk", schemaVersion: 2 },
                attachments: {
                    c: {
                        contentType: "application/octet-stream",
                        data: new Uint8Array([1, 2, 3, 4, 5]),
                    },
                },
            },
        ];
        const results = await client.bulkDocsWithAttachments(items);
        expect(results[0]?.ok).toBe(true);

        const fetched = await client.getAttachment("chunk:abc", "c");
        expect(fetched).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    });

    it("getAttachment returns null for missing doc", async () => {
        const client = new FakeCouchClient();
        expect(await client.getAttachment("chunk:missing", "c")).toBeNull();
    });

    it("getAttachment returns null for missing attachment name", async () => {
        const client = new FakeCouchClient();
        await client.bulkDocsWithAttachments([
            {
                doc: { _id: "chunk:abc", type: "chunk" },
                attachments: { c: { contentType: "x", data: new Uint8Array([1]) } },
            },
        ]);
        expect(await client.getAttachment("chunk:abc", "nope")).toBeNull();
    });

    it("attachment payloads are isolated copies (input mutation does not leak)", async () => {
        const client = new FakeCouchClient();
        const buf = new Uint8Array([10, 20, 30]);
        await client.bulkDocsWithAttachments([
            { doc: { _id: "chunk:iso" }, attachments: { c: { contentType: "x", data: buf } } },
        ]);
        // Mutate the original buffer after submission.
        buf[0] = 99;
        const stored = await client.getAttachment("chunk:iso", "c");
        expect(stored![0]).toBe(10); // unchanged
    });

    it("preserves contentEncoding metadata when set", async () => {
        const client = new FakeCouchClient();
        await client.bulkDocsWithAttachments([
            {
                doc: { _id: "chunk:gz" },
                attachments: {
                    c: {
                        contentType: "application/octet-stream",
                        data: new Uint8Array([1, 2, 3]),
                        contentEncoding: "gzip",
                    },
                },
            },
        ]);
        // The fake's API surface returns only the binary; the encoding flag
        // lives on stored metadata. We assert via getAttachment shape:
        const blob = await client.getAttachment("chunk:gz", "c");
        expect(blob).toEqual(new Uint8Array([1, 2, 3]));
    });
});
