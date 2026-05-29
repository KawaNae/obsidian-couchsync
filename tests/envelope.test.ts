import { describe, it, expect, beforeAll } from "vitest";
import {
    encodeEnvelope,
    decodeEnvelope,
    plainEnvelope,
    encryptString,
    decryptString,
    EnvelopeError,
    type Envelope,
} from "../src/db/envelope.ts";
import {
    createCryptoProvider,
    deriveKeys,
    generateSalt,
    type CryptoProvider,
} from "../src/db/crypto-provider.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

let crypto: CryptoProvider;
beforeAll(async () => {
    crypto = createCryptoProvider(await deriveKeys("envelope-test", generateSalt()));
});

// ── codec byte layout ───────────────────────────────────────────

describe("envelope codec byte", () => {
    it("plain envelope writes header 0x00 followed by body", () => {
        const blob = encodeEnvelope(plainEnvelope(enc.encode("hi")));
        expect(blob[0]).toBe(0x00);
        expect(dec.decode(blob.slice(1))).toBe("hi");
    });

    it("compressed-only envelope writes header 0x02", () => {
        const blob = encodeEnvelope({
            bits: { encrypted: false, compressed: true },
            body: enc.encode("gz"),
        });
        expect(blob[0]).toBe(0x02);
    });

    it("encrypted-only envelope writes header 0x01 with IV after the byte", () => {
        const iv = new Uint8Array(12).fill(0x42);
        const blob = encodeEnvelope({
            bits: { encrypted: true, compressed: false },
            iv,
            body: enc.encode("cipher"),
        });
        expect(blob[0]).toBe(0x01);
        expect(blob.slice(1, 13)).toEqual(iv);
    });

    it("encrypted + compressed writes header 0x03", () => {
        const blob = encodeEnvelope({
            bits: { encrypted: true, compressed: true },
            iv: new Uint8Array(12),
            body: enc.encode("x"),
        });
        expect(blob[0]).toBe(0x03);
    });
});

// ── round-trip across all 4 codec combinations ──────────────────

describe.each([
    { name: "plain",                bits: { encrypted: false, compressed: false } },
    { name: "compressed",           bits: { encrypted: false, compressed: true  } },
    { name: "encrypted",            bits: { encrypted: true,  compressed: false } },
    { name: "encrypted+compressed", bits: { encrypted: true,  compressed: true  } },
])("envelope round-trip — $name", ({ bits }) => {
    it("decode∘encode preserves bits, iv, and body", () => {
        const env: Envelope = {
            bits,
            iv: bits.encrypted ? new Uint8Array(12).fill(0x7e) : undefined,
            body: enc.encode("payload-" + JSON.stringify(bits)),
        };
        const back = decodeEnvelope(encodeEnvelope(env));
        expect(back.bits).toEqual(env.bits);
        if (env.iv) expect(back.iv).toEqual(env.iv);
        else expect(back.iv).toBeUndefined();
        expect(back.body).toEqual(env.body);
    });
});

// ── decoder validation (invariant 12 reject paths) ──────────────

describe("envelope decoder validation", () => {
    it("rejects empty blob", () => {
        expect(() => decodeEnvelope(new Uint8Array(0))).toThrow(EnvelopeError);
    });

    it("rejects reserved bits 2-6 set", () => {
        for (const flag of [0x04, 0x08, 0x10, 0x20, 0x40]) {
            const bad = new Uint8Array([flag, 0xff, 0xff]);
            expect(() => decodeEnvelope(bad)).toThrow(/reserved bits/);
        }
    });

    it("rejects extension flag (bit 7) — reserved escape in v1", () => {
        const bad = new Uint8Array([0x80, 0x00]);
        expect(() => decodeEnvelope(bad)).toThrow(/extension flag/);
    });

    it("rejects encrypted envelope shorter than 1 + IV(12) bytes", () => {
        const tooShort = new Uint8Array([0x01, 0x00, 0x00, 0x00]);
        expect(() => decodeEnvelope(tooShort)).toThrow(/shorter than 1 \+ IV/);
    });
});

// ── encoder validation ──────────────────────────────────────────

describe("envelope encoder validation", () => {
    it("rejects encrypted envelope without IV", () => {
        expect(() => encodeEnvelope({
            bits: { encrypted: true, compressed: false },
            body: new Uint8Array(0),
        })).toThrow(/requires IV/);
    });

    it("rejects encrypted envelope with wrong-length IV", () => {
        expect(() => encodeEnvelope({
            bits: { encrypted: true, compressed: false },
            iv: new Uint8Array(8),
            body: new Uint8Array(0),
        })).toThrow(/requires IV/);
    });

    it("rejects IV on a non-encrypted envelope", () => {
        expect(() => encodeEnvelope({
            bits: { encrypted: false, compressed: false },
            iv: new Uint8Array(12),
            body: new Uint8Array(0),
        })).toThrow(/iv present but encrypted bit not set/);
    });
});

// ── empty body edge case ────────────────────────────────────────

describe("empty body", () => {
    it("plain empty body encodes to a single header byte", () => {
        const blob = encodeEnvelope(plainEnvelope(new Uint8Array(0)));
        expect(blob.length).toBe(1);
        expect(blob[0]).toBe(0x00);
    });

    it("decodes round-trip of empty body", () => {
        const blob = encodeEnvelope(plainEnvelope(new Uint8Array(0)));
        const back = decodeEnvelope(blob);
        expect(back.body.length).toBe(0);
        expect(back.bits).toEqual({ encrypted: false, compressed: false });
    });
});

// ── encryptString / decryptString (Δ2-13 invariant) ─────────────

describe("encryptString / decryptString", () => {
    it("round-trips UTF-8 content via base64(envelope) form", async () => {
        const original = "ニュース 🎉 — multi-byte content";
        const wire = await encryptString(original, crypto);
        // Output is base64 — no colon separator (legacy `iv:cipher` hint).
        expect(wire).toMatch(/^[A-Za-z0-9+/=]+$/);
        expect(wire).not.toContain(":");
        expect(await decryptString(wire, crypto)).toBe(original);
    });

    it("two encryptions of the same plaintext produce distinct wires (fresh IV)", async () => {
        const a = await encryptString("repeat", crypto);
        const b = await encryptString("repeat", crypto);
        expect(a).not.toBe(b);
    });

    it("rejects a wire whose envelope is not encrypted", async () => {
        // Build a plain-bit envelope, base64 it, hand to decryptString.
        const plainBytes = enc.encode("not encrypted");
        const blob = encodeEnvelope(plainEnvelope(plainBytes));
        const b64 = btoa(String.fromCharCode(...blob));
        await expect(decryptString(b64, crypto)).rejects.toThrow(/not encrypted/);
    });

    it("rejects a compressed-string envelope (v1 forbids it)", async () => {
        const blob = encodeEnvelope({
            bits: { encrypted: true, compressed: true },
            iv: new Uint8Array(12),
            body: new Uint8Array(16),
        });
        const b64 = btoa(String.fromCharCode(...blob));
        await expect(decryptString(b64, crypto)).rejects.toThrow(/compressed string envelopes/);
    });
});
