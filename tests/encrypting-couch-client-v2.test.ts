/**
 * data-layer-v2 (envelope-aware): cover the EncryptingCouchClient
 * attachment path. The decorator must encrypt attachment binaries on
 * push (setting the envelope's `encrypted` bit and prepending IV) and
 * decrypt + strip on pull, transparently to the caller, alongside the
 * existing path-ID HMAC translation.
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
import { asEnvelope, fromEnvelope } from "./helpers/envelope.ts";

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
                attachments: { c: { contentType: "application/octet-stream", data: asEnvelope(original) } },
            },
        ]);

        const back = await client.getAttachment("chunk:abc", "c");
        expect(fromEnvelope(back!)).toEqual(original);
    });

    it("the inner storage holds ciphertext, not plaintext", async () => {
        const inner = new FakeCouchClient();
        const client = new EncryptingCouchClient(inner, crypto1);

        const original = bytes("secret chunk content");
        await client.bulkDocsWithAttachments([
            { doc: { _id: "chunk:secret" }, attachments: { c: { contentType: "x", data: asEnvelope(original) } } },
        ]);

        const raw = await inner.getAttachment("chunk:secret", "c");
        expect(raw).not.toBeNull();
        // Envelope (1B) + IV (12B) + cipher (plain + 16B GCM tag).
        expect(raw!.length).toBeGreaterThan(original.length);
        expect(raw![0]).toBe(0x01); // encrypted bit set, compressed bit clear
        expect(raw).not.toEqual(asEnvelope(original));
    });

    it("decrypt with wrong key throws EncryptionError", async () => {
        const inner = new FakeCouchClient();
        const writer = new EncryptingCouchClient(inner, crypto1);
        await writer.bulkDocsWithAttachments([
            { doc: { _id: "chunk:enc" }, attachments: { c: { contentType: "x", data: asEnvelope(bytes("data")) } } },
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
            { doc: { _id: fileId, type: "file" }, attachments: { c: { contentType: "x", data: asEnvelope(original) } } },
        ]);

        // Inner storage: the file: id should be HMAC-suffixed, plain id not directly there.
        const innerKeys = [...(inner as any).docs.keys()] as string[];
        const filesAtInner = innerKeys.filter((k) => k.startsWith("file:"));
        expect(filesAtInner.length).toBe(1);
        expect(filesAtInner[0]).not.toBe(fileId);
        expect(filesAtInner[0]).toMatch(/^file:[0-9a-f]{64}$/);

        // Decorator-facing fetch resolves the plain id and decrypts.
        const back = await client.getAttachment(fileId, "c");
        expect(fromEnvelope(back!)).toEqual(original);
    });

    it("chunk: id passes through (content-addressed, not HMAC-translated)", async () => {
        const inner = new FakeCouchClient();
        const client = new EncryptingCouchClient(inner, crypto1);

        // The chunk ID for v2 is `chunk:<alg>:<hash>` and the decorator
        // does not translate it (content-addressed, not path-based).
        const chunkId = "chunk:x64:abc1234567890def";
        await client.bulkDocsWithAttachments([
            { doc: { _id: chunkId }, attachments: { c: { contentType: "x", data: asEnvelope(bytes("payload")) } } },
        ]);

        const stored = (inner as any).docs.get(chunkId);
        expect(stored).toBeTruthy();
        const back = await client.getAttachment(chunkId, "c");
        expect(fromEnvelope(back!)).toEqual(bytes("payload"));
    });

    it("empty attachment round-trips", async () => {
        const inner = new FakeCouchClient();
        const client = new EncryptingCouchClient(inner, crypto1);
        await client.bulkDocsWithAttachments([
            { doc: { _id: "chunk:zero" }, attachments: { c: { contentType: "x", data: asEnvelope(new Uint8Array(0)) } } },
        ]);
        const back = await client.getAttachment("chunk:zero", "c");
        expect(fromEnvelope(back!)).toEqual(new Uint8Array(0));
    });

    it("each push generates a fresh IV (same plaintext → different ciphertext)", async () => {
        const inner1 = new FakeCouchClient();
        const inner2 = new FakeCouchClient();
        const c1 = new EncryptingCouchClient(inner1, crypto1);
        const c2 = new EncryptingCouchClient(inner2, crypto1);

        const payload = bytes("repeat me");
        await c1.bulkDocsWithAttachments([
            { doc: { _id: "chunk:repeat" }, attachments: { c: { contentType: "x", data: asEnvelope(payload) } } },
        ]);
        await c2.bulkDocsWithAttachments([
            { doc: { _id: "chunk:repeat" }, attachments: { c: { contentType: "x", data: asEnvelope(payload) } } },
        ]);

        const raw1 = await inner1.getAttachment("chunk:repeat", "c");
        const raw2 = await inner2.getAttachment("chunk:repeat", "c");
        expect(raw1).not.toEqual(raw2); // different IVs → different cipher
    });
});

describe("CryptoProvider encryptBytesIv / decryptBytesIv", () => {
    it("round-trips arbitrary binary payloads", async () => {
        const payload = new Uint8Array(256);
        for (let i = 0; i < 256; i++) payload[i] = i;
        const { iv, cipher } = await crypto1.encryptBytesIv(payload);
        const back = await crypto1.decryptBytesIv(iv, cipher);
        expect(back).toEqual(payload);
    });

    it("IV is exactly 12 bytes; cipher carries the GCM auth tag (+16 over plain)", async () => {
        const { iv, cipher } = await crypto1.encryptBytesIv(new Uint8Array(0));
        expect(iv.length).toBe(12);
        expect(cipher.length).toBe(16); // empty plaintext + 16B tag
    });

    it("decryptBytesIv rejects an IV of the wrong length", async () => {
        const { cipher } = await crypto1.encryptBytesIv(bytes("payload"));
        const badIv = new Uint8Array(5);
        await expect(crypto1.decryptBytesIv(badIv, cipher)).rejects.toThrow(/IV must be/);
    });
});
