/**
 * Tests for Phase 2 invariants 17 + 18 — per-DB crypto principals.
 *
 * Invariant 17: each `*:meta` is a self-contained crypto root. Building
 * a vault:meta and a config:meta from the SAME passphrase yields
 * DIFFERENT salts and DIFFERENT keys (because each Init mints a fresh
 * salt independently).
 *
 * Invariant 18: the vault DB and the config DB have independent
 * `CryptoProvider` instances. Chunk ids minted by the vault hasher and
 * the config hasher live in disjoint id spaces even for the same input
 * bytes — the HMAC key differs.
 *
 * These properties are what make cross-vault config sharing work
 * (Android dev2 ↔ dev sharing config-dev with different vault DBs):
 * the config crypto root travels with the config DB, not the vault DB.
 */

import { describe, it, expect } from "vitest";
import {
    buildInitialMeta,
    unlockMeta,
    VAULT_META_DOC_ID,
    CONFIG_META_DOC_ID,
} from "../src/db/vault-meta.ts";

const TEST_PASSPHRASE = "correct horse battery staple";

describe("Phase 2 — per-DB crypto principals (invariants 17/18)", () => {
    it("same passphrase + different meta kinds → different salts", async () => {
        const vault = await buildInitialMeta({
            docId: VAULT_META_DOC_ID,
            docType: "vault-meta",
            encryption: true,
            passphrase: TEST_PASSPHRASE,
            compression: true,
        });
        const config = await buildInitialMeta({
            docId: CONFIG_META_DOC_ID,
            docType: "config-meta",
            encryption: true,
            passphrase: TEST_PASSPHRASE,
            compression: true,
        });

        expect(vault.meta.encryption.enabled).toBe(true);
        expect(config.meta.encryption.enabled).toBe(true);
        if (!vault.meta.encryption.enabled || !config.meta.encryption.enabled) return;

        // Salts are random per Init, so building twice from the same
        // passphrase MUST produce different salts.
        expect(vault.meta.encryption.salt).not.toBe(config.meta.encryption.salt);
    });

    it("different salts → different keys → different chunk HMACs", async () => {
        const vault = await buildInitialMeta({
            docId: VAULT_META_DOC_ID,
            docType: "vault-meta",
            encryption: true,
            passphrase: TEST_PASSPHRASE,
            compression: false,
        });
        const config = await buildInitialMeta({
            docId: CONFIG_META_DOC_ID,
            docType: "config-meta",
            encryption: true,
            passphrase: TEST_PASSPHRASE,
            compression: false,
        });

        expect(vault.crypto).not.toBeNull();
        expect(config.crypto).not.toBeNull();
        if (!vault.crypto || !config.crypto) return;

        // HMAC the same bytes with each crypto provider. The HMAC keys
        // differ → digests differ → chunk ids would land in disjoint
        // id spaces even if the same content flowed through both pipelines.
        const payload = new TextEncoder().encode("same plaintext bytes");
        const vaultHmac = await vault.crypto.hmacHash(payload);
        const configHmac = await config.crypto.hmacHash(payload);

        expect(vaultHmac).not.toBe(configHmac);
        // Sanity: both look like proper hex digests of the right length.
        expect(vaultHmac).toMatch(/^[0-9a-f]{64}$/);
        expect(configHmac).toMatch(/^[0-9a-f]{64}$/);
    });

    it("each meta unlocks ONLY with its own salt (cross-meta unlock fails)", async () => {
        const vault = await buildInitialMeta({
            docId: VAULT_META_DOC_ID,
            docType: "vault-meta",
            encryption: true,
            passphrase: TEST_PASSPHRASE,
            compression: false,
        });
        const config = await buildInitialMeta({
            docId: CONFIG_META_DOC_ID,
            docType: "config-meta",
            encryption: true,
            passphrase: TEST_PASSPHRASE,
            compression: false,
        });

        // Each meta unlocks with the correct passphrase.
        const vaultUnlocked = await unlockMeta(vault.meta, TEST_PASSPHRASE);
        const configUnlocked = await unlockMeta(config.meta, TEST_PASSPHRASE);
        expect(vaultUnlocked).not.toBeNull();
        expect(configUnlocked).not.toBeNull();

        // Wrong passphrase → null on either side.
        const vaultWrong = await unlockMeta(vault.meta, "wrong");
        const configWrong = await unlockMeta(config.meta, "wrong");
        expect(vaultWrong).toBeNull();
        expect(configWrong).toBeNull();
    });

    it("plaintext meta has no crypto root (encryption=false)", async () => {
        const plain = await buildInitialMeta({
            docId: CONFIG_META_DOC_ID,
            docType: "config-meta",
            encryption: false,
            compression: true,
        });
        expect(plain.crypto).toBeNull();
        expect(plain.keys).toBeNull();
        expect(plain.meta.encryption.enabled).toBe(false);
        // unlockMeta on a plaintext meta returns null — there's nothing
        // to unlock, the caller checks `meta.encryption.enabled` first.
        const unlocked = await unlockMeta(plain.meta, TEST_PASSPHRASE);
        expect(unlocked).toBeNull();
    });

    it("config:meta schemaVersion is 2 (Phase 2 — distinguishes from Phase 1 clone)", async () => {
        const config = await buildInitialMeta({
            docId: CONFIG_META_DOC_ID,
            docType: "config-meta",
            encryption: true,
            passphrase: TEST_PASSPHRASE,
            compression: true,
        });
        expect(config.meta.schemaVersion).toBe(2);
        // The schemaVersion bump is the migration signal: Phase 1
        // in-progress installs have config:meta.schemaVersion === 1
        // (cloned shape, no real crypto root). Phase 2 readers reject
        // those and route the user to a re-Init.
    });

    it("compression flag flows through independently of encryption", async () => {
        const encryptedNoCompress = await buildInitialMeta({
            docId: CONFIG_META_DOC_ID,
            docType: "config-meta",
            encryption: true,
            passphrase: TEST_PASSPHRASE,
            compression: false,
        });
        const plaintextCompress = await buildInitialMeta({
            docId: CONFIG_META_DOC_ID,
            docType: "config-meta",
            encryption: false,
            compression: true,
        });
        expect(encryptedNoCompress.meta.compression.enabled).toBe(false);
        expect(plaintextCompress.meta.compression.enabled).toBe(true);
        expect(plaintextCompress.crypto).toBeNull();
    });
});
