/**
 * Phase 4 (data-layer-v2): verify that the LocalDB can round-trip a
 * ChunkDoc with its v2 binary `content` field through Dexie / fake-IDB.
 *
 * IndexedDB stores Uint8Array via the structured-clone algorithm, so no
 * schema migration is required — but we still need to prove the
 * round-trip end-to-end and assert that the binary survives unchanged.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createTestStore } from "./helpers/dexie-test-store.ts";
import { DexieStore } from "../src/db/dexie-store.ts";
import type { ChunkDoc, FileDoc } from "../src/types.ts";
import { CURRENT_SCHEMA_VERSION } from "../src/types.ts";
import { makeChunkId, makeFileId } from "../src/types/doc-id.ts";

const stores: DexieStore[] = [];
afterEach(async () => {
    while (stores.length) await stores.pop()!.destroy();
});

function open(): DexieStore {
    const s = createTestStore("phase4");
    stores.push(s);
    return s;
}

describe("LocalDB chunk attachment (Phase 4)", () => {
    it("round-trips a ChunkDoc with binary `content` unchanged", async () => {
        const store = open();
        const payload = new Uint8Array([0x00, 0x7f, 0x80, 0xff, 0x42, 0xde, 0xad, 0xbe, 0xef]);
        const chunk: ChunkDoc = {
            _id: makeChunkId("abc1234567890def"),
            type: "chunk",
            schemaVersion: CURRENT_SCHEMA_VERSION,
            data: "",            // legacy slot stays empty; v2 reads from `content`
            content: payload,
        };
        await store.runWriteTx({ docs: [{ doc: chunk }] });

        const fetched = await store.get(chunk._id);
        expect(fetched).not.toBeNull();
        expect(fetched!.type).toBe("chunk");
        expect(fetched!.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
        expect(fetched!.content).toBeInstanceOf(Uint8Array);
        expect(new Uint8Array(fetched!.content)).toEqual(payload);
    });

    it("preserves binary content across many chunks in one tx", async () => {
        const store = open();
        const chunks: ChunkDoc[] = [];
        for (let i = 0; i < 20; i++) {
            const buf = new Uint8Array(64);
            for (let j = 0; j < 64; j++) buf[j] = (i * 31 + j) & 0xff;
            chunks.push({
                _id: makeChunkId(i.toString().padStart(16, "0")),
                type: "chunk",
                schemaVersion: CURRENT_SCHEMA_VERSION,
                data: "",
                content: buf,
            });
        }
        await store.runWriteTx({ docs: chunks.map((c) => ({ doc: c })) });

        for (const c of chunks) {
            const back = await store.get(c._id);
            expect(new Uint8Array(back!.content)).toEqual(c.content);
        }
    });

    it("commits a FileDoc + its referenced ChunkDocs atomically", async () => {
        const store = open();
        const chunk: ChunkDoc = {
            _id: makeChunkId("atomic000000000a"),
            type: "chunk",
            schemaVersion: CURRENT_SCHEMA_VERSION,
            data: "",
            content: new Uint8Array([1, 2, 3]),
        };
        const file: FileDoc = {
            _id: makeFileId("notes/atomic.md"),
            type: "file",
            schemaVersion: CURRENT_SCHEMA_VERSION,
            chunks: [chunk._id],
            mtime: 1,
            ctime: 1,
            size: 3,
            vclock: { A: 1 },
        };
        await store.runWriteTx({
            docs: [{ doc: chunk }, { doc: file }],
        });

        const f = await store.get(file._id);
        const c = await store.get(chunk._id);
        expect(f).not.toBeNull();
        expect(c).not.toBeNull();
        expect(new Uint8Array(c!.content)).toEqual(chunk.content);
        expect((f as any).chunks).toEqual([chunk._id]);
    });

    it("legacy ChunkDoc (data: string only, no content) still round-trips", async () => {
        const store = open();
        const chunk: ChunkDoc = {
            _id: makeChunkId("legacy0000000001"),
            type: "chunk",
            data: "aGVsbG8=", // base64 of "hello"
        };
        await store.runWriteTx({ docs: [{ doc: chunk }] });

        const back = await store.get(chunk._id);
        expect(back!.data).toBe("aGVsbG8=");
        expect((back as any).content).toBeUndefined();
    });
});
