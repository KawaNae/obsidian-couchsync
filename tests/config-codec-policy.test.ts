import { describe, it, expect } from "vitest";
import {
    resolveConfigCodec,
    isInheritingConfigEncryption,
    isInheritingConfigCompression,
} from "../src/sync/config-codec-policy.ts";
import type { CouchSyncSettings } from "../src/settings.ts";
import { makeSettings } from "./helpers/settings.ts";

function settings(patch: Partial<CouchSyncSettings>): CouchSyncSettings {
    return makeSettings(patch);
}

describe("resolveConfigCodec", () => {
    describe("encryption (?? — undefined inherits)", () => {
        it("inherits the vault flag when the override is unset", () => {
            expect(resolveConfigCodec(settings({ encryptionEnabled: true })).encryption).toBe(true);
            expect(resolveConfigCodec(settings({ encryptionEnabled: false })).encryption).toBe(false);
        });

        it("honours an explicit config override, including false over a true vault", () => {
            expect(resolveConfigCodec(settings({
                encryptionEnabled: true, configEncryptionEnabled: false,
            })).encryption).toBe(false);
            expect(resolveConfigCodec(settings({
                encryptionEnabled: false, configEncryptionEnabled: true,
            })).encryption).toBe(true);
        });
    });

    describe("compression (?? — undefined inherits)", () => {
        it("inherits the vault flag when the override is unset", () => {
            expect(resolveConfigCodec(settings({ compressionEnabled: true })).compression).toBe(true);
            expect(resolveConfigCodec(settings({ compressionEnabled: false })).compression).toBe(false);
        });

        it("honours an explicit config override, including false over a true vault", () => {
            expect(resolveConfigCodec(settings({
                compressionEnabled: true, configCompressionEnabled: false,
            })).compression).toBe(false);
        });
    });

    describe("passphrase (|| — empty string inherits)", () => {
        it("inherits the vault passphrase when the config override is blank", () => {
            expect(resolveConfigCodec(settings({
                encryptionPassphrase: "vault-secret", configEncryptionPassphrase: "",
            })).passphrase).toBe("vault-secret");
        });

        it("inherits the vault passphrase when the config override is undefined", () => {
            expect(resolveConfigCodec(settings({
                encryptionPassphrase: "vault-secret",
            })).passphrase).toBe("vault-secret");
        });

        it("uses a non-empty config passphrase over the vault one", () => {
            expect(resolveConfigCodec(settings({
                encryptionPassphrase: "vault-secret", configEncryptionPassphrase: "config-secret",
            })).passphrase).toBe("config-secret");
        });

        it("resolves to empty only when both are blank", () => {
            expect(resolveConfigCodec(settings({
                encryptionPassphrase: "", configEncryptionPassphrase: "",
            })).passphrase).toBe("");
        });
    });
});

describe("inherit predicates", () => {
    it("isInheritingConfigEncryption tracks the override presence", () => {
        expect(isInheritingConfigEncryption(settings({}))).toBe(true);
        expect(isInheritingConfigEncryption(settings({ configEncryptionEnabled: false }))).toBe(false);
        expect(isInheritingConfigEncryption(settings({ configEncryptionEnabled: true }))).toBe(false);
    });

    it("isInheritingConfigCompression tracks the override presence", () => {
        expect(isInheritingConfigCompression(settings({}))).toBe(true);
        expect(isInheritingConfigCompression(settings({ configCompressionEnabled: false }))).toBe(false);
    });
});
