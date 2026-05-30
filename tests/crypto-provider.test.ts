import { describe, it, expect, beforeAll, vi } from "vitest";
import {
    deriveKeys,
    generateSalt,
    createCryptoProvider,
    type CryptoProvider,
    type EncryptionKeys,
} from "../src/db/crypto-provider.ts";
import { encryptString, decryptString } from "../src/db/envelope.ts";
import { createKeyCheck, verifyKeyCheck } from "../src/db/vault-meta.ts";

async function makeTestKeys(): Promise<EncryptionKeys> {
    return deriveKeys("test-passphrase", generateSalt());
}

describe("deriveKeys", () => {
    it("produces non-extractable CryptoKey objects", async () => {
        const keys = await makeTestKeys();
        expect(keys.contentKey).toBeInstanceOf(CryptoKey);
        expect(keys.hmacKey).toBeInstanceOf(CryptoKey);
        expect(keys.contentKey.extractable).toBe(false);
        expect(keys.hmacKey.extractable).toBe(false);
    });

    it("same passphrase + salt → same derived keys", async () => {
        const salt = generateSalt();
        const k1 = await deriveKeys("pass", salt);
        const k2 = await deriveKeys("pass", salt);
        const p1 = createCryptoProvider(k1);
        const p2 = createCryptoProvider(k2);
        const probe = new TextEncoder().encode("test");
        expect(await p1.hmacHash(probe)).toBe(await p2.hmacHash(probe));
    });

    it("different passphrase → different keys", async () => {
        const salt = generateSalt();
        const k1 = await deriveKeys("alpha", salt);
        const k2 = await deriveKeys("beta", salt);
        const p1 = createCryptoProvider(k1);
        const p2 = createCryptoProvider(k2);
        const probe = new TextEncoder().encode("test");
        expect(await p1.hmacHash(probe)).not.toBe(await p2.hmacHash(probe));
    });

    it("different salt → different keys", async () => {
        const k1 = await deriveKeys("same", generateSalt());
        const k2 = await deriveKeys("same", generateSalt());
        const p1 = createCryptoProvider(k1);
        const p2 = createCryptoProvider(k2);
        const probe = new TextEncoder().encode("test");
        expect(await p1.hmacHash(probe)).not.toBe(await p2.hmacHash(probe));
    });
});

describe("envelope.encryptString / decryptString", () => {
    let provider: CryptoProvider;
    beforeAll(async () => { provider = createCryptoProvider(await makeTestKeys()); });

    it("roundtrip preserves content", async () => {
        const original = "Hello, World!";
        const encrypted = await encryptString(original, provider);
        expect(encrypted).not.toBe(original);
        expect(await decryptString(encrypted, provider)).toBe(original);
    });

    it("output is base64-wrapped envelope (not legacy iv:cipher format)", async () => {
        const encrypted = await encryptString("data", provider);
        // No colon separator from the old `base64(iv):base64(cipher)` shape.
        expect(encrypted).not.toContain(":");
        // base64 chars only.
        expect(encrypted).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    it("same plaintext produces different ciphertexts (random IV)", async () => {
        const plain = "determinism test";
        const e1 = await encryptString(plain, provider);
        const e2 = await encryptString(plain, provider);
        expect(e1).not.toBe(e2);
    });

    it("decryption with wrong key throws", async () => {
        const other = createCryptoProvider(await makeTestKeys());
        const encrypted = await encryptString("secret", provider);
        await expect(decryptString(encrypted, other)).rejects.toThrow();
    });

    it("handles empty string", async () => {
        const encrypted = await encryptString("", provider);
        expect(await decryptString(encrypted, provider)).toBe("");
    });

    it("handles large data (100KB+)", async () => {
        const large = "x".repeat(100_000);
        const encrypted = await encryptString(large, provider);
        expect(await decryptString(encrypted, provider)).toBe(large);
    });
});

describe("CryptoProvider hmacHash", () => {
    let provider: CryptoProvider;
    const enc = new TextEncoder();
    beforeAll(async () => { provider = createCryptoProvider(await makeTestKeys()); });

    it("returns 64-char hex string", async () => {
        const hash = await provider.hmacHash(enc.encode("test data"));
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic (same input → same hash)", async () => {
        const h1 = await provider.hmacHash(enc.encode("same input"));
        const h2 = await provider.hmacHash(enc.encode("same input"));
        expect(h1).toBe(h2);
    });

    it("different input → different hash", async () => {
        const h1 = await provider.hmacHash(enc.encode("input A"));
        const h2 = await provider.hmacHash(enc.encode("input B"));
        expect(h1).not.toBe(h2);
    });

    it("accepts arbitrary binary content (not just utf-8)", async () => {
        const bytes = new Uint8Array([0x00, 0xff, 0x7f, 0x80]);
        const hash = await provider.hmacHash(bytes);
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe("keyCheck", () => {
    it("verify succeeds with correct keys", async () => {
        const keys = await makeTestKeys();
        const check = await createKeyCheck(keys);
        expect(await verifyKeyCheck(keys, check)).toBe(true);
    });

    it("verify fails with wrong keys", async () => {
        const k1 = await makeTestKeys();
        const k2 = await makeTestKeys();
        const check = await createKeyCheck(k1);
        expect(await verifyKeyCheck(k2, check)).toBe(false);
    });

    it("verify fails with corrupted keyCheck", async () => {
        const keys = await makeTestKeys();
        expect(await verifyKeyCheck(keys, "garbage-not-an-envelope")).toBe(false);
    });
});

describe("generateSalt", () => {
    it("returns 16 bytes", () => {
        const salt = generateSalt();
        expect(salt).toBeInstanceOf(Uint8Array);
        expect(salt.length).toBe(16);
    });

    it("produces unique values", () => {
        const s1 = generateSalt();
        const s2 = generateSalt();
        expect(Array.from(s1)).not.toEqual(Array.from(s2));
    });
});

describe("encryptBytesIv additional-authenticated-data (#2)", () => {
    const enc = new TextEncoder();

    it("round-trips when the same AAD is supplied to decrypt", async () => {
        const p = createCryptoProvider(await makeTestKeys());
        const aad = enc.encode("file:abc");
        const { iv, cipher } = await p.encryptBytesIv(new Uint8Array([1, 2, 3]), aad);
        const back = await p.decryptBytesIv(iv, cipher, aad);
        expect(Array.from(back)).toEqual([1, 2, 3]);
    });

    it("fails the GCM tag check when the AAD differs (id-binding)", async () => {
        const p = createCryptoProvider(await makeTestKeys());
        const { iv, cipher } = await p.encryptBytesIv(new Uint8Array([1, 2, 3]), enc.encode("id-A"));
        await expect(p.decryptBytesIv(iv, cipher, enc.encode("id-B"))).rejects.toBeTruthy();
    });

    it("fails when an AAD-bound ciphertext is decrypted without any AAD", async () => {
        const p = createCryptoProvider(await makeTestKeys());
        const { iv, cipher } = await p.encryptBytesIv(new Uint8Array([9]), enc.encode("id"));
        await expect(p.decryptBytesIv(iv, cipher)).rejects.toBeTruthy();
    });
});

describe("KDF parameters regression (#13)", () => {
    it("derives with PBKDF2 >= 600k iterations and SHA-256 (GPU-bruteforce resistance floor)", async () => {
        const spy = vi.spyOn(globalThis.crypto.subtle, "deriveBits");
        try {
            await deriveKeys("pw", generateSalt());
            const call = spy.mock.calls.find((c) => (c[0] as any)?.name === "PBKDF2");
            expect(call).toBeTruthy();
            const params = call![0] as Pbkdf2Params;
            expect(params.iterations).toBeGreaterThanOrEqual(600_000);
            expect(params.hash).toBe("SHA-256");
        } finally {
            spy.mockRestore();
        }
    });

    it("uses a 16-byte salt", () => {
        expect(generateSalt().length).toBe(16);
    });
});
