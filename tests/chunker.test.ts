import { describe, it, expect } from "vitest";
import {
    splitIntoChunks,
    joinChunks,
    arrayBufferToBase64,
    base64ToArrayBuffer,
    arrayBufferToBase64Fallback,
    base64ToArrayBufferFallback,
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

describe("chunker v2 binary representation", () => {
    it("each chunk carries both binary `content` and base64 `data`", async () => {
        const original = "hello v2";
        const chunks = await splitIntoChunks(textToBuffer(original));
        expect(chunks.length).toBe(1);
        const c = chunks[0];
        expect(c.content).toBeInstanceOf(Uint8Array);
        expect(typeof c.data).toBe("string");
        // The binary form matches the input; the base64 form is the
        // encoded binary.
        expect(new Uint8Array(c.content!)).toEqual(enc.encode(original));
        expect(c.data).toBe(arrayBufferToBase64(enc.encode(original).buffer));
    });

    it("chunk IDs are hex (xxhash64 over binary), padded to 16 chars", async () => {
        const chunks = await splitIntoChunks(textToBuffer("v2 id format"));
        const hash = chunks[0]._id.replace(/^chunk:/, "");
        expect(hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it("schemaVersion is stamped on output", async () => {
        const chunks = await splitIntoChunks(textToBuffer("schema check"));
        expect(chunks[0].schemaVersion).toBe(2);
    });

    it("custom hashFn receives binary input", async () => {
        const seen: Uint8Array[] = [];
        const hashFn = async (data: Uint8Array) => {
            seen.push(new Uint8Array(data));
            return "deterministic";
        };
        await splitIntoChunks(textToBuffer("inject"), hashFn);
        expect(seen.length).toBe(1);
        expect(seen[0]).toEqual(enc.encode("inject"));
    });

    it("joinChunks prefers binary `content` over base64 `data` when both present", async () => {
        const chunks = await splitIntoChunks(textToBuffer("prefer-binary"));
        // Tamper with `data` to ensure joinChunks does NOT read it when
        // `content` is present (v2 path).
        for (const c of chunks) c.data = "ZZZZ-corrupted-base64";
        expect(bufferToText(joinChunks(chunks))).toBe("prefer-binary");
    });

    it("joinChunks falls back to base64 `data` when `content` is missing", async () => {
        const chunks = await splitIntoChunks(textToBuffer("legacy-fallback"));
        // Strip the v2 binary field; emulates a doc read from legacy storage.
        for (const c of chunks) c.content = undefined;
        expect(bufferToText(joinChunks(chunks))).toBe("legacy-fallback");
    });
});

describe("base64 utilities", () => {
    it("arrayBufferToBase64 and base64ToArrayBuffer roundtrip", () => {
        const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
        const base64 = arrayBufferToBase64(bytes.buffer);
        const result = new Uint8Array(base64ToArrayBuffer(base64));
        expect(result).toEqual(bytes);
    });

    it("fallback roundtrip on small input", () => {
        const bytes = new Uint8Array([0, 1, 2, 127, 128, 255, 42]);
        const base64 = arrayBufferToBase64Fallback(bytes);
        const result = new Uint8Array(base64ToArrayBufferFallback(base64));
        expect(result).toEqual(bytes);
    });

    it("fallback roundtrip crosses 0x8000 chunk boundary", () => {
        // 200 KB with a deterministic byte pattern — exercises multiple
        // String.fromCharCode.apply slices in the fallback encoder.
        const size = 200 * 1024;
        const bytes = new Uint8Array(size);
        for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
        const base64 = arrayBufferToBase64Fallback(bytes);
        const result = new Uint8Array(base64ToArrayBufferFallback(base64));
        expect(result).toEqual(bytes);
    });

    it("fallback matches main function output", () => {
        const bytes = new Uint8Array([0xEF, 0xBB, 0xBF, 0, 255, 128, 1]);
        expect(arrayBufferToBase64Fallback(bytes)).toBe(arrayBufferToBase64(bytes.buffer));
    });
});
