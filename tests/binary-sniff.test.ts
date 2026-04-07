import { describe, it, expect } from "vitest";
import { isDiffableText } from "../src/utils/binary.ts";

const enc = new TextEncoder();

describe("isDiffableText", () => {
    it("returns true for plain ASCII markdown", () => {
        expect(isDiffableText(enc.encode("# Hello\nWorld\n"))).toBe(true);
    });

    it("returns true for Japanese markdown", () => {
        expect(isDiffableText(enc.encode("# 日本語\nこんにちは\n絵文字🎉"))).toBe(true);
    });

    it("returns true for UTF-8 BOM + text", () => {
        const bytes = new Uint8Array([0xEF, 0xBB, 0xBF, ...enc.encode("# Hello\n")]);
        expect(isDiffableText(bytes)).toBe(true);
    });

    it("returns true for CRLF text", () => {
        expect(isDiffableText(enc.encode("a\r\nb\r\n"))).toBe(true);
    });

    it("returns false for bytes containing NUL", () => {
        const bytes = new Uint8Array([0x68, 0x65, 0x00, 0x6c, 0x6f]);
        expect(isDiffableText(bytes)).toBe(false);
    });

    it("returns false for AVIF-like header bytes", () => {
        // AVIF starts with 00 00 00 ?? 66 74 79 70 (ftyp box)
        const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]);
        expect(isDiffableText(bytes)).toBe(false);
    });

    it("returns false for UTF-16 LE BOM (invalid UTF-8)", () => {
        // FF FE is UTF-16 LE BOM, not valid UTF-8
        const bytes = new Uint8Array([0xFF, 0xFE, 0x68, 0x00, 0x65, 0x00]);
        expect(isDiffableText(bytes)).toBe(false);
    });

    it("returns true for empty buffer (vacuous)", () => {
        expect(isDiffableText(new Uint8Array(0))).toBe(true);
    });

    it("accepts text with NUL beyond 8KB sniff window", () => {
        const head = new Uint8Array(9000).fill(0x61); // 9000 'a's
        const tail = new Uint8Array([0x00, 0x61]);
        const combined = new Uint8Array(head.byteLength + tail.byteLength);
        combined.set(head, 0);
        combined.set(tail, head.byteLength);
        expect(isDiffableText(combined)).toBe(true);
    });

    it("accepts ArrayBuffer directly", () => {
        expect(isDiffableText(enc.encode("hello").buffer)).toBe(true);
    });

    it("rejects invalid UTF-8 continuation bytes", () => {
        // 0xC3 0x28 — invalid 2-byte sequence
        const bytes = new Uint8Array([0xC3, 0x28]);
        expect(isDiffableText(bytes)).toBe(false);
    });
});
