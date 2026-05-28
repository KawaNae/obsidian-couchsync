/**
 * Phase 8 (data-layer-v2): cover the EncryptingCouchClient attachment
 * path. The decorator must encrypt attachment binaries on push and
 * decrypt on pull, transparently to the caller, alongside the existing
 * path-ID HMAC translation.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { FakeCouchClient } from "./helpers/fake-couch-client.ts";
import { EncryptingCouchClient } from "../src/db/encrypting-couch-client.ts";
import {
    createCryptoProvider,
    deriveKeys,
    generateSalt,
    type CryptoProvider,
} from "../src/db/crypto-provider.ts";

let crypto1: CryptoProvider;
let crypto2: CryptoProvider; // different keys, for failure tests

beforeAll(async () => {
    const salt = generateSalt();
    crypto1 = createCryptoProvider(await deriveKeys("pass-A", salt));
    crypto2 = createCryptoProvider(await deriveKeys("pass-B", salt));
});

function bytes(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}

describe("EncryptingCouchClient v2 attachment encryption", () => {
    it("round-trips a chunk attachment via the encrypting decorator", async () => {
        const inner = new FakeCouchClient();
        const client = new EncryptingCouchClient(inner, crypto1);

        const original = bytes("v2 encrypted attachment");
        await client.bulkDocsWithAttachments([
            {
                doc: { _id: "chunk:abc", type: "chunk" },
                attachments: { c: { contentType: "application/octet-stream", data: original } },
            },
        ]);

        const back = await client.getAttachment("chunk:abc", "c");
        expect(back).toEqual(original);
    });

    it("the inner storage holds ciphertext, not plaintext", async () => {
        const inner = new FakeCouchClient();
        const client = new EncryptingCouchClient(inner, crypto1);

        const original = bytes("secret chunk content");
        await client.bulkDocsWithAttachments([
            { doc: { _id: "chunk:secret" }, attachments: { c: { contentType: "x", data: original } } },
        ]);

        const raw = await inner.getAttachment("chunk:secret", "c");
        expect(raw).not.toBeNull();
        expect(raw!.length).toBeGreaterThan(original.length); // IV + GCM tag overhead
        expect(raw).not.toEqual(original);
    });

    it("decrypt with wrong key throws EncryptionError", async () => {
        const inner = new FakeCouchClient();
        const writer = new EncryptingCouchClient(inner, crypto1);
        await writer.bulkDocsWithAttachments([
            { doc: { _id: "chunk:enc" }, attachments: { c: { contentType: "x", data: bytes("data") } } },
        ]);

        const reader = new EncryptingCouchClient(inner, crypto2);
        await expect(reader.getAttachment("chunk:enc", "c"))
            .rejects.toThrow(/Failed to decrypt attachment/);
    });

    it("file: doc id is HMAC'd in inner storage but plain when fetched via decorator", async () => {
        const inner = new FakeCouchClient();
        const client = new EncryptingCouchClient(inner, crypto1);

        const original = bytes("file content as one chunk would be elsewhere");
        const fileId = "file:notes/secret.md";
        await client.bulkDocsWithAttachments([
            { doc: { _id: fileId, type: "file" }, attachments: { c: { contentType: "x", data: original } } },
        ]);

        // Inner storage: the file: id should be HMAC-suffixed, plain id not directly there.
        const innerKeys = [...(inner as any).docs.keys()] as string[];
        const filesAtInner = innerKeys.filter((k) => k.startsWith("file:"));
        expect(filesAtInner.length).toBe(1);
        expect(filesAtInner[0]).not.toBe(fileId);
        expect(filesAtInner[0]).toMatch(/^file:[0-9a-f]{64}$/);

        // Decorator-facing fetch resolves the plain id and decrypts.
        const back = await client.getAttachment(fileId, "c");
        expect(back).toEqual(original);
    });

    it("chunk: id passes through (content-addressed, not HMAC-translated)", async () => {
        const inner = new FakeCouchClient();
        const client = new EncryptingCouchClient(inner, crypto1);

        // The chunk ID for v2 is hash(plainBytes) computed by chunker —
        // already content-addressed, the decorator does not translate it.
        const chunkId = "chunk:abc1234567890def";
        await client.bulkDocsWithAttachments([
            { doc: { _id: chunkId }, attachments: { c: { contentType: "x", data: bytes("payload") } } },
        ]);

        const stored = (inner as any).docs.get(chunkId);
        expect(stored).toBeTruthy();
        expect(await client.getAttachment(chunkId, "c")).toEqual(bytes("payload"));
    });

    it("empty attachment round-trips", async () => {
        const inner = new FakeCouchClient();
        const client = new EncryptingCouchClient(inner, crypto1);
        await client.bulkDocsWithAttachments([
            { doc: { _id: "chunk:zero" }, attachments: { c: { contentType: "x", data: new Uint8Array(0) } } },
        ]);
        expect(await client.getAttachment("chunk:zero", "c")).toEqual(new Uint8Array(0));
    });

    it("each push generates a fresh IV (same plaintext → different ciphertext)", async () => {
        const inner1 = new FakeCouchClient();
        const inner2 = new FakeCouchClient();
        const c1 = new EncryptingCouchClient(inner1, crypto1);
        const c2 = new EncryptingCouchClient(inner2, crypto1);

        const payload = bytes("repeat me");
        await c1.bulkDocsWithAttachments([
            { doc: { _id: "chunk:repeat" }, attachments: { c: { contentType: "x", data: payload } } },
        ]);
        await c2.bulkDocsWithAttachments([
            { doc: { _id: "chunk:repeat" }, attachments: { c: { contentType: "x", data: payload } } },
        ]);

        const raw1 = await inner1.getAttachment("chunk:repeat", "c");
        const raw2 = await inner2.getAttachment("chunk:repeat", "c");
        expect(raw1).not.toEqual(raw2); // different IVs → different cipher
    });
});

describe("CryptoProvider encryptBytes / decryptBytes", () => {
    it("round-trips arbitrary binary payloads", async () => {
        const payload = new Uint8Array(256);
        for (let i = 0; i < 256; i++) payload[i] = i;
        const blob = await crypto1.encryptBytes(payload);
        const back = await crypto1.decryptBytes(blob);
        expect(back).toEqual(payload);
    });

    it("blob = IV(12) || cipher; minimum length is IV_BYTES + tag (16)", async () => {
        const blob = await crypto1.encryptBytes(new Uint8Array(0));
        expect(blob.length).toBeGreaterThanOrEqual(12 + 16);
    });

    it("decryptBytes rejects truncated input", async () => {
        const tooShort = new Uint8Array(5);
        await expect(crypto1.decryptBytes(tooShort)).rejects.toThrow(/shorter than IV/);
    });
});
