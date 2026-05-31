import { describe, it, expect } from "vitest";
import {
    resolveConfigCodec,
    isInheritingConfigEncryption,
    isInheritingConfigCompression,
    codecFingerprint,
    isConfigCodecDirty,
} from "../src/sync/config-codec-policy.ts";
import type { CouchSyncSettings } from "../src/settings.ts";
import { makeSettings } from "./helpers/settings-factory.ts";

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

describe("codecFingerprint", () => {
    it("captures only the codec shape (enc/compress/passphrase-blank)", () => {
        expect(codecFingerprint({ encryption: false, compression: false, passphrase: "" })).toBe("0:0:0");
        expect(codecFingerprint({ encryption: true, compression: true, passphrase: "x" })).toBe("1:1:1");
        expect(codecFingerprint({ encryption: true, compression: false, passphrase: "" })).toBe("1:0:0");
    });

    it("is independent of the passphrase value (only blank vs non-blank)", () => {
        const a = codecFingerprint({ encryption: true, compression: false, passphrase: "alpha" });
        const b = codecFingerprint({ encryption: true, compression: false, passphrase: "beta" });
        expect(a).toBe(b);
    });
});

describe("isConfigCodecDirty", () => {
    it("is not dirty when no baseline has been recorded (pre-v0.27.2)", () => {
        // Even with an override that differs from vault, undefined baseline is permissive.
        expect(isConfigCodecDirty(settings({
            compressionEnabled: false, configEncryptionEnabled: true, configEncryptionPassphrase: "x",
        }))).toBe(false);
    });

    it("is not dirty when the live codec matches the recorded baseline", () => {
        const s = settings({ compressionEnabled: false }); // resolves to 0:0:0
        expect(isConfigCodecDirty({ ...s, configCodecApplied: codecFingerprint(resolveConfigCodec(s)) }))
            .toBe(false);
    });

    it("is dirty when encryption is toggled on after Init", () => {
        expect(isConfigCodecDirty(settings({
            compressionEnabled: false,
            configCodecApplied: "0:0:0",
            configEncryptionEnabled: true,
            configEncryptionPassphrase: "secret",
        }))).toBe(true);
    });

    it("is dirty when encryption is toggled OFF after an encrypted Init (worst case)", () => {
        expect(isConfigCodecDirty(settings({
            compressionEnabled: false,
            configCodecApplied: "1:0:1",
            configEncryptionEnabled: false,
        }))).toBe(true);
    });

    it("is dirty when compression is flipped after Init", () => {
        expect(isConfigCodecDirty(settings({
            compressionEnabled: false,
            configCodecApplied: "0:0:0",
            configCompressionEnabled: true,
        }))).toBe(true);
    });

    it("is dirty when a passphrase is added where there was none", () => {
        expect(isConfigCodecDirty(settings({
            compressionEnabled: false,
            encryptionEnabled: true,
            encryptionPassphrase: "",
            configCodecApplied: "1:0:0",
            configEncryptionPassphrase: "now-set",
        }))).toBe(true);
    });
});
