import { describe, it, expect } from "vitest";
import {
    splitIntoChunks,
    joinChunks,
    arrayBufferToBase64,
    base64ToArrayBuffer,
} from "../src/db/chunker.ts";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8");

function textToBuffer(s: string): ArrayBuffer {
    return enc.encode(s).buffer;
}
function bufferToText(b: ArrayBuffer): string {
    return dec.decode(b);
}

describe("chunker roundtrip (text via binary path)", () => {
    it("text roundtrip preserves content", async () => {
        const original = "Hello, world!\nThis is a test.";
        const chunks = await splitIntoChunks(textToBuffer(original));
        expect(bufferToText(joinChunks(chunks))).toBe(original);
    });

    it("preserves newlines at chunk boundaries (v0.4.1 regression)", async () => {
        const line = "This is a line of text that will be repeated many times.\n";
        const original = line.repeat(3000);
        const chunks = await splitIntoChunks(textToBuffer(original));
        expect(chunks.length).toBeGreaterThan(1);
        expect(bufferToText(joinChunks(chunks))).toBe(original);
    });

    it("preserves trailing newline", async () => {
        const original = "hello\nworld\n";
        const chunks = await splitIntoChunks(textToBuffer(original));
        expect(bufferToText(joinChunks(chunks))).toBe(original);
    });

    it("preserves CRLF line endings exactly", async () => {
        const original = "line one\r\nline two\r\nline three\r\n";
        const buf = textToBuffer(original);
        const chunks = await splitIntoChunks(buf);
        const result = new Uint8Array(joinChunks(chunks));
        expect(result).toEqual(new Uint8Array(buf));
    });

    it("preserves UTF-8 BOM exactly", async () => {
        const bytes = new Uint8Array([0xEF, 0xBB, 0xBF, ...enc.encode("# Hello\n")]);
        const chunks = await splitIntoChunks(bytes.buffer);
        const result = new Uint8Array(joinChunks(chunks));
        expect(result).toEqual(bytes);
    });

    it("handles Japanese text", async () => {
        const original = "こんにちは世界\n日本語テスト\n絵文字🎉✨";
        const chunks = await splitIntoChunks(textToBuffer(original));
        expect(bufferToText(joinChunks(chunks))).toBe(original);
    });

    it("handles empty buffer", async () => {
        const chunks = await splitIntoChunks(new ArrayBuffer(0));
        expect(joinChunks(chunks).byteLength).toBe(0);
    });

    it("binary roundtrip preserves bytes", async () => {
        const bytes = new Uint8Array([0, 1, 2, 127, 128, 255, 0, 42]);
        const chunks = await splitIntoChunks(bytes.buffer);
        expect(new Uint8Array(joinChunks(chunks))).toEqual(bytes);
    });

    it("same content produces same chunk IDs (content-addressed)", async () => {
        const buf = textToBuffer("identical content for hashing");
        const chunks1 = await splitIntoChunks(buf);
        const chunks2 = await splitIntoChunks(buf);
        expect(chunks1.map((c) => c._id)).toEqual(chunks2.map((c) => c._id));
    });

    it("different content produces different chunk IDs", async () => {
        const chunks1 = await splitIntoChunks(textToBuffer("content A"));
        const chunks2 = await splitIntoChunks(textToBuffer("content B"));
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
