import { describe, it, expect, beforeAll } from "vitest";
import {
    deriveKeys,
    generateSalt,
    createCryptoProvider,
    createKeyCheck,
    verifyKeyCheck,
    type CryptoProvider,
    type EncryptionKeys,
} from "../src/db/crypto-provider.ts";

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
        expect(await p1.hmacHash("test")).toBe(await p2.hmacHash("test"));
    });

    it("different passphrase → different keys", async () => {
        const salt = generateSalt();
        const k1 = await deriveKeys("alpha", salt);
        const k2 = await deriveKeys("beta", salt);
        const p1 = createCryptoProvider(k1);
        const p2 = createCryptoProvider(k2);
        expect(await p1.hmacHash("test")).not.toBe(await p2.hmacHash("test"));
    });

    it("different salt → different keys", async () => {
        const k1 = await deriveKeys("same", generateSalt());
        const k2 = await deriveKeys("same", generateSalt());
        const p1 = createCryptoProvider(k1);
        const p2 = createCryptoProvider(k2);
        expect(await p1.hmacHash("test")).not.toBe(await p2.hmacHash("test"));
    });
});

describe("CryptoProvider encrypt/decrypt", () => {
    let provider: CryptoProvider;
    beforeAll(async () => { provider = createCryptoProvider(await makeTestKeys()); });

    it("roundtrip preserves content", async () => {
        const original = btoa("Hello, World!");
        const encrypted = await provider.encrypt(original);
        expect(encrypted).not.toBe(original);
        expect(await provider.decrypt(encrypted)).toBe(original);
    });

    it("encrypts to iv:ciphertext format", async () => {
        const encrypted = await provider.encrypt(btoa("data"));
        expect(encrypted).toContain(":");
        const [iv, ct] = encrypted.split(":");
        expect(iv.length).toBeGreaterThan(0);
        expect(ct.length).toBeGreaterThan(0);
    });

    it("same plaintext produces different ciphertexts (random IV)", async () => {
        const plain = btoa("determinism test");
        const e1 = await provider.encrypt(plain);
        const e2 = await provider.encrypt(plain);
        expect(e1).not.toBe(e2);
    });

    it("decryption with wrong key throws", async () => {
        const other = createCryptoProvider(await makeTestKeys());
        const encrypted = await provider.encrypt(btoa("secret"));
        await expect(other.decrypt(encrypted)).rejects.toThrow();
    });

    it("handles empty string", async () => {
        const encrypted = await provider.encrypt("");
        expect(await provider.decrypt(encrypted)).toBe("");
    });

    it("handles large data (100KB+)", async () => {
        const large = btoa("x".repeat(100_000));
        const encrypted = await provider.encrypt(large);
        expect(await provider.decrypt(encrypted)).toBe(large);
    });
});

describe("CryptoProvider hmacHash", () => {
    let provider: CryptoProvider;
    beforeAll(async () => { provider = createCryptoProvider(await makeTestKeys()); });

    it("returns 64-char hex string", async () => {
        const hash = await provider.hmacHash("test data");
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic (same input → same hash)", async () => {
        const h1 = await provider.hmacHash("same input");
        const h2 = await provider.hmacHash("same input");
        expect(h1).toBe(h2);
    });

    it("different input → different hash", async () => {
        const h1 = await provider.hmacHash("input A");
        const h2 = await provider.hmacHash("input B");
        expect(h1).not.toBe(h2);
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
        expect(await verifyKeyCheck(keys, "garbage:data")).toBe(false);
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
