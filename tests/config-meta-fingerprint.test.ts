/**
 * `configMetaFingerprint` — the root identity a device records on Create /
 * Join. With a generation id it tells re-created plaintext roots apart;
 * without one (a meta written by an older build) it must equal the
 * pre-generation fingerprint bit for bit, or every record anchored before
 * the upgrade would read as `root-changed`.
 */
import { describe, it, expect } from "vitest";
import {
    configMetaFingerprint,
    configBindingKey,
    configStoreName,
    describeCodec,
    metaCodec,
    parseAttachment,
    sameCodec,
} from "../src/sync/config-binding-record.ts";
import {
    buildInitialConfigMeta,
    CONFIG_META_DOC_ID,
    type ConfigMetaDoc,
} from "../src/db/vault-meta.ts";

/** The fingerprint formula before generation ids existed. */
async function legacyFingerprint(meta: ConfigMetaDoc): Promise<string> {
    const enc = meta.encryption;
    const canonical = JSON.stringify(
        enc.enabled
            ? ["e", enc.kdfVersion, enc.salt, enc.keyCheck, meta.compression.enabled]
            : ["p", meta.compression.enabled],
    );
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    const hex = Array.from(new Uint8Array(digest).slice(0, 16))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    return `sha256:${hex}`;
}

function plainMeta(extra: Partial<ConfigMetaDoc> = {}): ConfigMetaDoc {
    return {
        _id: CONFIG_META_DOC_ID,
        type: "config-meta",
        schemaVersion: 2,
        encryption: { enabled: false },
        compression: { enabled: false },
        ...extra,
    };
}

describe("configMetaFingerprint", () => {
    it("without a generation id: identical to the pre-generation fingerprint", async () => {
        const plain = plainMeta();
        expect(await configMetaFingerprint(plain)).toBe(await legacyFingerprint(plain));

        const { meta } = await buildInitialConfigMeta({
            encryption: true, passphrase: "pw", compression: true,
        });
        const { generationId, ...old } = meta;
        expect(generationId).toBeDefined();
        expect(await configMetaFingerprint(old)).toBe(await legacyFingerprint(old));
    });

    it("plaintext: two roots with the same codec differ only by generation id", async () => {
        const a = plainMeta({ generationId: "a".repeat(32) });
        const b = plainMeta({ generationId: "b".repeat(32) });
        expect(await configMetaFingerprint(a)).not.toBe(await configMetaFingerprint(b));
        // …and a generation id is never confused with its absence.
        expect(await configMetaFingerprint(a)).not.toBe(await configMetaFingerprint(plainMeta()));
    });

    it("every Create mints a fresh generation id, encrypted or not", async () => {
        const one = await buildInitialConfigMeta({ encryption: false, compression: false });
        const two = await buildInitialConfigMeta({ encryption: false, compression: false });
        expect(one.meta.generationId).toMatch(/^[0-9a-f]{32}$/);
        expect(one.meta.generationId).not.toBe(two.meta.generationId);
    });

    it("ignores cipherVersion (a lowered one is cipher-downgrade, not a reset)", async () => {
        const { meta } = await buildInitialConfigMeta({
            encryption: true, passphrase: "pw", compression: false,
        });
        if (!meta.encryption.enabled) throw new Error("expected encrypted meta");
        const lowered: ConfigMetaDoc = {
            ...meta, encryption: { ...meta.encryption, cipherVersion: 2 },
        };
        expect(await configMetaFingerprint(lowered)).toBe(await configMetaFingerprint(meta));
    });
});

describe("configStoreName — the store is named from the binding key", () => {
    it("differs per server and per DB, and is stable", async () => {
        const x = await configStoreName("v", "http://x:5984", "cfg");
        expect(x).toMatch(/^couchsync-v-config-cfg-[0-9a-f]{16}$/);
        expect(await configStoreName("v", "http://x:5984", "cfg")).toBe(x);
        expect(await configStoreName("v", "http://y:5984", "cfg")).not.toBe(x);
        expect(await configStoreName("v", "http://x:5984", "cfg2")).not.toBe(x);
        expect(await configStoreName("w", "http://x:5984", "cfg")).not.toBe(x);
    });

    it("follows the key's normalisation: spellings of one server share a store", async () => {
        const a = await configStoreName("v", "http://X:5984/", "cfg");
        const b = await configStoreName("v", "http://user:pw@x:5984", "cfg");
        expect(configBindingKey("http://X:5984/", "cfg")).toBe(configBindingKey("http://user:pw@x:5984", "cfg"));
        expect(a).toBe(b);
        // The URI (and its credentials) never appear in the name.
        expect(b).not.toMatch(/pw|5984|http/);
    });
});

describe("attachment helpers", () => {
    it("parseAttachment accepts a well-formed record and rejects anything else", () => {
        const ok = { codec: { encryption: true, compression: false }, metaFingerprint: "sha256:ab" };
        expect(parseAttachment(ok)).toEqual(ok);
        expect(parseAttachment(null)).toBeNull();
        expect(parseAttachment({ codec: { encryption: true }, metaFingerprint: "x" })).toBeNull();
        expect(parseAttachment({ codec: ok.codec, metaFingerprint: "" })).toBeNull();
        // A settings-era record (codec fingerprint string) is not an attachment.
        expect(parseAttachment({ codecFingerprint: "1:0", settingUp: false })).toBeNull();
    });

    it("metaCodec / sameCodec / describeCodec", () => {
        const c = metaCodec(plainMeta({ compression: { enabled: true, algorithm: "gzip", version: 1 } }));
        expect(c).toEqual({ encryption: false, compression: true });
        expect(sameCodec(c, { encryption: false, compression: true })).toBe(true);
        expect(sameCodec(c, { encryption: true, compression: true })).toBe(false);
        expect(describeCodec(c)).toBe("encryption off, compression on");
    });
});
