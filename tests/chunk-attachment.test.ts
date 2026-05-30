import { describe, it, expect } from "vitest";
import {
    buildChunkAttachment,
    chunkFromAttachment,
    ChunkIntegrityError,
    ChunkAlgMismatchError,
    isCorruptChunkError,
    CHUNK_ATTACHMENT_NAME,
    CHUNK_CONTENT_TYPE,
} from "../src/db/chunk-attachment.ts";
import { EnvelopeError } from "../src/db/codec-errors.ts";
import { CHUNK_SCHEMA_VERSION, type ChunkDoc } from "../src/types.ts";
import { makeChunkId } from "../src/types/doc-id.ts";
import { computeHash, type ChunkHasher } from "../src/db/chunker.ts";

const x64Hasher: ChunkHasher = { alg: "x64", hash: computeHash };

async function makeChunk(content: Uint8Array): Promise<ChunkDoc> {
    const id = makeChunkId(await computeHash(content), "x64");
    return { _id: id, type: "chunk", schemaVersion: CHUNK_SCHEMA_VERSION, content };
}

describe("chunk-attachment round-trip", () => {
    it("buildChunkAttachment → chunkFromAttachment preserves content + schema", async () => {
        const content = new Uint8Array([1, 2, 3, 4, 5]);
        const chunk = await makeChunk(content);

        const item = buildChunkAttachment(chunk);
        // Attachment shape contract.
        const att = item.attachments[CHUNK_ATTACHMENT_NAME];
        expect(att).toBeDefined();
        expect(att.contentType).toBe(CHUNK_CONTENT_TYPE);
        expect(att.contentEncoding).toBeUndefined();
        // The binary body never travels in the JSON doc.
        expect((item.doc as any).content).toBeUndefined();

        const back = await chunkFromAttachment(chunk._id, att.data);
        expect(back._id).toBe(chunk._id);
        expect(back.type).toBe("chunk");
        expect(back.schemaVersion).toBe(CHUNK_SCHEMA_VERSION);
        expect(Array.from(back.content)).toEqual(Array.from(content));
    });

    it("keepRev defaults to true; keepRev:false drops _rev", async () => {
        const chunk = { ...(await makeChunk(new Uint8Array([9]))), _rev: "3-abc" };

        const kept = buildChunkAttachment(chunk);
        expect((kept.doc as any)._rev).toBe("3-abc");

        const dropped = buildChunkAttachment(chunk, { keepRev: false });
        expect((dropped.doc as any)._rev).toBeUndefined();
    });

    it("chunkFromAttachment verifies content hashes to the id when a matching hasher is given", async () => {
        const content = new Uint8Array([7, 7, 7]);
        const chunk = await makeChunk(content);
        const item = buildChunkAttachment(chunk);

        // Correct content → passes.
        await expect(
            chunkFromAttachment(chunk._id, item.attachments.c.data, x64Hasher),
        ).resolves.toMatchObject({ _id: chunk._id });
    });

    it("throws ChunkIntegrityError when the body does not hash to the id", async () => {
        const realChunk = await makeChunk(new Uint8Array([1, 1, 1]));
        // Build a blob for DIFFERENT content but keep the original id.
        const tampered = buildChunkAttachment(
            await makeChunk(new Uint8Array([2, 2, 2])),
        );
        await expect(
            chunkFromAttachment(realChunk._id, tampered.attachments.c.data, x64Hasher),
        ).rejects.toBeInstanceOf(ChunkIntegrityError);
    });

    it("fail-closed: throws ChunkAlgMismatchError when the hasher's alg differs from the id's tag (#10)", async () => {
        // hmac-tagged id but only an x64 hasher available → the hasher cannot
        // verify these bytes. Previously this silently skipped verification,
        // letting a server present an unverifiable id and have its body
        // trusted. Now it fails closed and routes to repair.
        const content = new Uint8Array([5, 5]);
        const hmacId = makeChunkId("deadbeef", "hmac");
        const blob = buildChunkAttachment(
            { _id: hmacId, type: "chunk", schemaVersion: CHUNK_SCHEMA_VERSION, content },
        ).attachments.c.data;

        await expect(
            chunkFromAttachment(hmacId, blob, x64Hasher),
        ).rejects.toBeInstanceOf(ChunkAlgMismatchError);
        // Subclass of ChunkIntegrityError so existing catch sites treat it as corrupt.
        await expect(
            chunkFromAttachment(hmacId, blob, x64Hasher),
        ).rejects.toBeInstanceOf(ChunkIntegrityError);
    });

    it("stamps the CHUNK_SCHEMA_VERSION constant, not a literal", async () => {
        const chunk = await makeChunk(new Uint8Array([0]));
        const back = await chunkFromAttachment(
            chunk._id,
            buildChunkAttachment(chunk).attachments.c.data,
        );
        expect(back.schemaVersion).toBe(CHUNK_SCHEMA_VERSION);
    });

    it("throws EnvelopeError on a structurally-malformed attachment blob", async () => {
        const chunk = await makeChunk(new Uint8Array([1, 2]));
        // 0x04 sets a reserved bit → decodeEnvelope rejects before hashing.
        await expect(
            chunkFromAttachment(chunk._id, new Uint8Array([0x04]), x64Hasher),
        ).rejects.toBeInstanceOf(EnvelopeError);
    });
});

describe("isCorruptChunkError — shared classifier for both fetch boundaries (#4)", () => {
    it("treats integrity, alg-mismatch and envelope errors as corrupt", () => {
        expect(isCorruptChunkError(new ChunkIntegrityError("id", "a", "b"))).toBe(true);
        expect(isCorruptChunkError(new ChunkAlgMismatchError("id", "hmac", "x64"))).toBe(true);
        expect(isCorruptChunkError(new EnvelopeError("malformed"))).toBe(true);
    });

    it("lets genuine failures (network/abort/generic) propagate", () => {
        expect(isCorruptChunkError(new Error("network down"))).toBe(false);
        expect(isCorruptChunkError(new DOMException("aborted", "AbortError"))).toBe(false);
        expect(isCorruptChunkError(undefined)).toBe(false);
    });
});
