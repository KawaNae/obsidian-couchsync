import { describe, it, expect } from "vitest";
import {
    splitIntoChunks,
    joinChunks,
    arrayBufferToBase64,
    base64ToArrayBuffer,
} from "../src/db/chunker.ts";

describe("chunker roundtrip", () => {
    it("text roundtrip preserves content", async () => {
        const original = "Hello, world!\nThis is a test.";
        const chunks = await splitIntoChunks(original, false);
        const result = joinChunks(chunks, false) as string;
        expect(result).toBe(original);
    });

    it("preserves newlines at chunk boundaries (v0.4.1 regression)", async () => {
        // Create text large enough to split into multiple chunks (>100KB base64)
        const line = "This is a line of text that will be repeated many times.\n";
        const original = line.repeat(3000); // ~171KB text → >228KB base64 → multiple chunks
        const chunks = await splitIntoChunks(original, false);
        expect(chunks.length).toBeGreaterThan(1);
        const result = joinChunks(chunks, false) as string;
        expect(result).toBe(original);
    });

    it("preserves trailing newline", async () => {
        const original = "hello\nworld\n";
        const chunks = await splitIntoChunks(original, false);
        const result = joinChunks(chunks, false) as string;
        expect(result).toBe(original);
    });

    it("handles Japanese text", async () => {
        const original = "こんにちは世界\n日本語テスト\n絵文字🎉✨";
        const chunks = await splitIntoChunks(original, false);
        const result = joinChunks(chunks, false) as string;
        expect(result).toBe(original);
    });

    it("handles empty string", async () => {
        const original = "";
        const chunks = await splitIntoChunks(original, false);
        const result = joinChunks(chunks, false) as string;
        expect(result).toBe(original);
    });

    it("binary roundtrip preserves content", async () => {
        const bytes = new Uint8Array([0, 1, 2, 127, 128, 255, 0, 42]);
        const original = bytes.buffer;
        const chunks = await splitIntoChunks(original, true);
        const result = joinChunks(chunks, true) as ArrayBuffer;
        expect(new Uint8Array(result)).toEqual(bytes);
    });

    it("same content produces same chunk IDs (content-addressed)", async () => {
        const content = "identical content for hashing";
        const chunks1 = await splitIntoChunks(content, false);
        const chunks2 = await splitIntoChunks(content, false);
        expect(chunks1.map((c) => c._id)).toEqual(chunks2.map((c) => c._id));
    });

    it("different content produces different chunk IDs", async () => {
        const chunks1 = await splitIntoChunks("content A", false);
        const chunks2 = await splitIntoChunks("content B", false);
        expect(chunks1[0]._id).not.toBe(chunks2[0]._id);
    });
});

describe("base64 utilities", () => {
    it("arrayBufferToBase64 and base64ToArrayBuffer roundtrip", () => {
        const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
        const base64 = arrayBufferToBase64(bytes.buffer);
        const result = new Uint8Array(base64ToArrayBuffer(base64));
        expect(result).toEqual(bytes);
    });
});
