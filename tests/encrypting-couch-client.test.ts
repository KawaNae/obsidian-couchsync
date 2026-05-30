import { describe, it, expect, beforeAll } from "vitest";
import { FakeCouchClient } from "./helpers/fake-couch-client.ts";
import { EncryptingCouchClient, EncryptionError } from "../src/db/encrypting-couch-client.ts";
import {
    deriveKeys,
    generateSalt,
    createCryptoProvider,
    type CryptoProvider,
} from "../src/db/crypto-provider.ts";
import { encryptString, decodeEnvelope, base64ToUint8 } from "../src/db/envelope.ts";

let crypto: CryptoProvider;
beforeAll(async () => {
    crypto = createCryptoProvider(await deriveKeys("test", generateSalt()));
});

function makeClient() {
    const inner = new FakeCouchClient();
    const enc = new EncryptingCouchClient(inner, crypto);
    return { inner, enc };
}

describe("EncryptingCouchClient push (bulkDocs)", () => {
    it("encrypts config _id + body into encBody (no plaintext fields on the wire)", async () => {
        const { inner, enc } = makeClient();
        const config = { _id: "config:.obsidian/app.json", type: "config", chunks: ["chunk:x64:abc"], vclock: { d: 2 }, mtime: 0, size: 2, schemaVersion: 3 };
        await enc.bulkDocs([config]);

        const allDocs = await inner.allDocs<any>({ startkey: "config:", endkey: "config:￰", include_docs: true });
        const stored = allDocs.rows[0]?.doc;
        expect(stored).toBeDefined();
        expect(stored._id).toMatch(/^config:[0-9a-f]{64}$/);
        // v3: the body is sealed — nothing plaintext leaks to the server.
        expect(stored.encBody).toBeDefined();
        expect(stored.chunks).toBeUndefined();
        expect(stored.vclock).toBeUndefined();
        expect(stored.encryptedPath).toBeUndefined();
        // Round-trips back to the full plaintext doc through the decorator.
        const back = await enc.getDoc<any>("config:.obsidian/app.json");
        expect(back._id).toBe("config:.obsidian/app.json");
        expect(back.chunks).toEqual(["chunk:x64:abc"]);
        expect(back.vclock).toEqual({ d: 2 });
        expect(back.encBody).toBeUndefined();
    });

    it("encrypts FileDoc body into encBody bound to the _id (#2)", async () => {
        const { inner, enc } = makeClient();
        const file = { _id: "file:note.md", type: "file", chunks: ["chunk:x64:abc"], vclock: { d: 1 }, mtime: 1, ctime: 1, size: 5, schemaVersion: 2 };
        await enc.bulkDocs([file]);

        const allDocs = await inner.allDocs<any>({ startkey: "file:", endkey: "file:￰", include_docs: true });
        const stored = allDocs.rows[0]?.doc;
        expect(stored._id).toMatch(/^file:[0-9a-f]{64}$/);
        // Body fields are no longer plaintext on the wire.
        expect(stored.encBody).toBeDefined();
        expect(stored.vclock).toBeUndefined();
        expect(stored.chunks).toBeUndefined();
        expect(stored.mtime).toBeUndefined();
        expect(stored.encryptedPath).toBeUndefined();
        // Decorator restores the full plaintext doc on read.
        const back = await enc.getDoc<any>("file:note.md");
        expect(back._id).toBe("file:note.md");
        expect(back.chunks).toEqual(["chunk:x64:abc"]);
        expect(back.vclock).toEqual({ d: 1 });
        expect(back.mtime).toBe(1);
    });

    it("does not encrypt vault:meta doc fields (no path id, no data string)", async () => {
        const { inner, enc } = makeClient();
        const meta = { _id: "vault:meta", type: "vault-meta", schemaVersion: 2, encryption: { enabled: false }, compression: { enabled: false } };
        await enc.bulkDocs([meta]);

        const stored = await inner.getDoc<any>("vault:meta");
        expect(stored!._id).toBe("vault:meta");
        expect(stored!.encryption).toEqual({ enabled: false });
    });

    it("does not embed encryptable data on chunk docs (chunks ride as attachments)", async () => {
        const { inner, enc } = makeClient();
        const chunk = { _id: "chunk:x64:abc", type: "chunk", schemaVersion: 2 };
        await enc.bulkDocs([chunk]);

        const stored = await inner.getDoc<any>("chunk:x64:abc");
        expect(stored!._id).toBe("chunk:x64:abc"); // not HMAC-translated
        expect(stored!.data).toBeUndefined();
        expect(stored!.content).toBeUndefined();
    });
});

describe("EncryptingCouchClient pull (decrypt)", () => {
    it("getDoc restores config _id and preserves chunks", async () => {
        const { enc } = makeClient();
        await enc.bulkDocs([{ _id: "config:test", type: "config", chunks: ["chunk:x64:t1"], vclock: {}, mtime: 0, size: 0, schemaVersion: 3 }]);

        const doc = await enc.getDoc<any>("config:test");
        expect(doc!.chunks).toEqual(["chunk:x64:t1"]);
        expect(doc!._id).toBe("config:test");
    });

    it("changes restores docs when include_docs is true", async () => {
        const { enc } = makeClient();
        await enc.bulkDocs([{ _id: "config:c1", type: "config", chunks: ["chunk:x64:c1"], vclock: {}, mtime: 0, size: 0, schemaVersion: 3 }]);

        const result = await enc.changes<any>({ include_docs: true });
        const row = result.results.find((r) => r.id === "config:c1");
        expect(row!.doc.chunks).toEqual(["chunk:x64:c1"]);
        expect(row!.doc._id).toBe("config:c1");
    });

    it("allDocs restores when include_docs is true", async () => {
        const { enc } = makeClient();
        await enc.bulkDocs([{ _id: "config:a", type: "config", chunks: ["chunk:x64:a1"], vclock: {}, mtime: 0, size: 0, schemaVersion: 3 }]);

        const result = await enc.allDocs<any>({ keys: ["config:a"], include_docs: true });
        expect(result.rows[0].doc!.chunks).toEqual(["chunk:x64:a1"]);
        expect(result.rows[0].doc!._id).toBe("config:a");
    });

    it("rejects ciphertext produced by a different key", async () => {
        // Realistic 2-vault scenario: writer encrypts the path under key A
        // and pushes via its own EncryptingCouchClient; a reader with key B
        // pulls the same doc and must surface EncryptionError (the
        // encryptedPath fails to decrypt under B) rather than silently
        // returning garbage. allDocs decrypts inline, so the rejection
        // bubbles out of the allDocs call itself.
        const inner = new FakeCouchClient();
        const keyA = createCryptoProvider(await deriveKeys("alpha", generateSalt()));
        const keyB = createCryptoProvider(await deriveKeys("beta", generateSalt()));
        const writerA = new EncryptingCouchClient(inner, keyA);
        const readerB = new EncryptingCouchClient(inner, keyB);

        const path = "config:.obsidian/secret.json";
        await writerA.bulkDocs([{
            _id: path, type: "config", chunks: ["chunk:x64:s1"], vclock: {},
            mtime: 0, size: 6, schemaVersion: 3,
        }]);

        await expect(readerB.allDocs<any>({
            startkey: "config:", endkey: "config:￰", include_docs: true,
        })).rejects.toThrow(/Failed to decrypt/);
    });
});

describe("EncryptingCouchClient roundtrip", () => {
    it("push → pull preserves ConfigDoc chunks and path", async () => {
        const { enc } = makeClient();
        await enc.bulkDocs([{ _id: "config:rt.json", type: "config", chunks: ["chunk:x64:rt"], vclock: {}, mtime: 0, size: 0, schemaVersion: 3 }]);

        const pulled = await enc.getDoc<any>("config:rt.json");
        expect(pulled!.chunks).toEqual(["chunk:x64:rt"]);
        expect(pulled!._id).toBe("config:rt.json");
    });

    it("mixed doc types in single bulkDocs", async () => {
        const { enc } = makeClient();
        const file = { _id: "file:f.md", type: "file", chunks: ["chunk:x64:m1"], vclock: {}, mtime: 0, ctime: 0, size: 5, schemaVersion: 2 };
        const config = { _id: "config:app", type: "config", chunks: ["chunk:x64:m2"], vclock: {}, mtime: 0, size: 3, schemaVersion: 3 };
        await enc.bulkDocs([file, config]);

        const f = await enc.getDoc<any>("file:f.md");
        expect(f!.chunks).toEqual(["chunk:x64:m1"]);
        const cfg = await enc.getDoc<any>("config:app");
        expect(cfg!.chunks).toEqual(["chunk:x64:m2"]);
    });
});

describe("EncryptingCouchClient Level 2 (path encryption)", () => {
    it("encrypts file _id on push and seals the body into encBody", async () => {
        const { inner, enc } = makeClient();
        const file = { _id: "file:notes/hello.md", type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0, schemaVersion: 2 };
        await enc.bulkDocs([file]);

        const allDocs = await inner.allDocs<any>({ startkey: "file:", endkey: "file:￰", include_docs: true });
        const stored = allDocs.rows[0]?.doc;
        expect(stored).toBeDefined();
        expect(stored._id).not.toBe("file:notes/hello.md");
        expect(stored._id).toMatch(/^file:[0-9a-f]{64}$/);
        // v3: the path (and the whole body) lives inside encBody, not a
        // standalone encryptedPath field.
        expect(stored.encBody).toBeDefined();
        expect(stored.encryptedPath).toBeUndefined();
        // Round-trips back to the plaintext id+path through the decorator.
        const back = await enc.getDoc<any>("file:notes/hello.md");
        expect(back._id).toBe("file:notes/hello.md");
    });

    it("decrypts file _id on pull (getDoc)", async () => {
        const { enc } = makeClient();
        await enc.bulkDocs([{ _id: "file:my/path.md", type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0, schemaVersion: 2 }]);

        const doc = await enc.getDoc<any>("file:my/path.md");
        expect(doc).not.toBeNull();
        expect(doc!._id).toBe("file:my/path.md");
    });

    it("encrypts config _id on push", async () => {
        const { inner, enc } = makeClient();
        const cfg = { _id: "config:.obsidian/app.json", type: "config", chunks: ["chunk:x64:cfg"], vclock: {}, mtime: 0, size: 2, schemaVersion: 3 };
        await enc.bulkDocs([cfg]);

        const allDocs = await inner.allDocs<any>({ startkey: "config:", endkey: "config:￰", include_docs: true });
        const stored = allDocs.rows[0]?.doc;
        expect(stored._id).toMatch(/^config:[0-9a-f]{64}$/);
    });

    it("does NOT encrypt chunk _id", async () => {
        const { inner, enc } = makeClient();
        await enc.bulkDocs([{ _id: "chunk:x64:abc123", type: "chunk", schemaVersion: 2 }]);

        const doc = await inner.getDoc<any>("chunk:x64:abc123");
        expect(doc).not.toBeNull();
        expect(doc!.encryptedPath).toBeUndefined();
    });

    it("changes returns decrypted _id and row.id", async () => {
        const { enc } = makeClient();
        await enc.bulkDocs([{ _id: "file:test.md", type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0, schemaVersion: 2 }]);

        const result = await enc.changes<any>({ include_docs: true });
        const row = result.results.find((r) => r.doc?.type === "file");
        expect(row).toBeDefined();
        expect(row!.id).toBe("file:test.md");
        expect(row!.doc._id).toBe("file:test.md");
    });

    it("allDocs with keys translates IDs", async () => {
        const { enc } = makeClient();
        await enc.bulkDocs([{ _id: "file:a.md", type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0, schemaVersion: 2 }]);

        const result = await enc.allDocs<any>({ keys: ["file:a.md"], include_docs: true });
        expect(result.rows.length).toBe(1);
        expect(result.rows[0].doc._id).toBe("file:a.md");
    });

    it("roundtrip: push file + config → pull via getDoc", async () => {
        const { enc } = makeClient();
        const config = { _id: "config:rt", type: "config", chunks: ["chunk:x64:rt2"], vclock: {}, mtime: 0, size: 7, schemaVersion: 3 };
        const file = { _id: "file:doc.md", type: "file", chunks: ["chunk:x64:r1"], vclock: { d: 1 }, mtime: 1, ctime: 1, size: 7, schemaVersion: 2 };
        await enc.bulkDocs([config, file]);

        const c = await enc.getDoc<any>("config:rt");
        expect(c!.chunks).toEqual(["chunk:x64:rt2"]);
        const f = await enc.getDoc<any>("file:doc.md");
        expect(f!._id).toBe("file:doc.md");
        expect(f!.chunks).toEqual(["chunk:x64:r1"]);
        expect(f!.vclock).toEqual({ d: 1 });
    });
});

describe("EncryptingCouchClient passthrough", () => {
    it("info delegates", async () => {
        const { enc } = makeClient();
        const info = await enc.info();
        expect(info.db_name).toBe("fake-remote");
    });

    it("withTimeout returns wrapped client", async () => {
        const { enc } = makeClient();
        const timedOut = enc.withTimeout(5000);
        expect(timedOut).toBeInstanceOf(EncryptingCouchClient);
    });

    it("getLastPullBodyChunkAt delegates", () => {
        const { enc } = makeClient();
        expect(enc.getLastPullBodyChunkAt()).toBeNull();
    });
});

describe("EncryptingCouchClient v3 encBody (#2: authenticated, confidential body)", () => {
    const te = new TextEncoder();

    it("binds encBody to the _id via AAD — moving a body onto another doc fails authentication", async () => {
        // Produce a valid encBody for a.md.
        const innerA = new FakeCouchClient();
        const encA = new EncryptingCouchClient(innerA, crypto);
        await encA.bulkDocs([{ _id: "file:a.md", type: "file", chunks: ["chunk:x64:aaa"], vclock: { d: 1 }, mtime: 0, ctime: 0, size: 0, schemaVersion: 2 }]);
        const rawA = (await innerA.allDocs<any>({ startkey: "file:", endkey: "file:￰", include_docs: true })).rows[0].doc;

        // Compute b.md's hmac id by pushing it through a fresh client.
        const innerB = new FakeCouchClient();
        const encB = new EncryptingCouchClient(innerB, crypto);
        await encB.bulkDocs([{ _id: "file:b.md", type: "file", chunks: ["chunk:x64:bbb"], vclock: { d: 1 }, mtime: 0, ctime: 0, size: 0, schemaVersion: 2 }]);
        const rawB = (await innerB.allDocs<any>({ startkey: "file:", endkey: "file:￰", include_docs: true })).rows[0].doc;
        expect(rawB._id).not.toBe(rawA._id);

        // Tampering server: place A's (valid) encBody under B's id.
        const tampered = new FakeCouchClient();
        await tampered.bulkDocs([{ _id: rawB._id, encBody: rawA.encBody }]);
        const encT = new EncryptingCouchClient(tampered, crypto);

        // Reading b.md fetches the doc under hmac(b) and tries to decrypt A's
        // body with AAD = hmac(b) — the GCM tag was computed over hmac(a) → fail.
        await expect(encT.getDoc<any>("file:b.md")).rejects.toBeInstanceOf(EncryptionError);
    });

    it("detects in-place tampering of encBody bytes", async () => {
        const inner = new FakeCouchClient();
        const enc = new EncryptingCouchClient(inner, crypto);
        await enc.bulkDocs([{ _id: "file:t.md", type: "file", chunks: ["chunk:x64:abc"], vclock: { d: 1 }, mtime: 0, ctime: 0, size: 0, schemaVersion: 2 }]);
        const raw = (await inner.allDocs<any>({ startkey: "file:", endkey: "file:￰", include_docs: true })).rows[0].doc;

        // Flip a byte of the ciphertext (skip the codec byte + IV at the front).
        const bytes = base64ToUint8(raw.encBody);
        bytes[bytes.length - 1] ^= 0xff;
        const tamperedB64 = Buffer.from(bytes).toString("base64");
        const tampered = new FakeCouchClient();
        await tampered.bulkDocs([{ _id: raw._id, encBody: tamperedB64 }]);
        const encT = new EncryptingCouchClient(tampered, crypto);

        await expect(encT.getDoc<any>("file:t.md")).rejects.toBeInstanceOf(EncryptionError);
    });

    it("compresses a large, repetitive body before encrypting (compress-then-encrypt)", async () => {
        const inner = new FakeCouchClient();
        const enc = new EncryptingCouchClient(inner, crypto);
        // ~200 chunk ids = a long, highly-repetitive array → should gzip well.
        const chunks = Array.from({ length: 200 }, (_, i) =>
            `chunk:x64:${i.toString(16).padStart(16, "0")}`);
        await enc.bulkDocs([{ _id: "file:big.md", type: "file", chunks, vclock: { d: 1 }, mtime: 0, ctime: 0, size: 0, schemaVersion: 2 }]);
        const raw = (await inner.allDocs<any>({ startkey: "file:", endkey: "file:￰", include_docs: true })).rows[0].doc;

        const env = decodeEnvelope(base64ToUint8(raw.encBody));
        expect(env.bits.encrypted).toBe(true);
        expect(env.bits.compressed).toBe(true); // large body packed down
        // Still round-trips losslessly.
        const back = await enc.getDoc<any>("file:big.md");
        expect(back.chunks).toEqual(chunks);
    });

    it("keeps a tiny body uncompressed (keep-smaller guard avoids gzip-header bloat)", async () => {
        const inner = new FakeCouchClient();
        const enc = new EncryptingCouchClient(inner, crypto);
        await enc.bulkDocs([{ _id: "file:s.md", type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0, schemaVersion: 2 }]);
        const raw = (await inner.allDocs<any>({ startkey: "file:", endkey: "file:￰", include_docs: true })).rows[0].doc;
        const env = decodeEnvelope(base64ToUint8(raw.encBody));
        expect(env.bits.compressed).toBe(false);
    });

    // Hand-build a legacy-scheme remote doc as a pre-encBody build would have:
    // path-only encryption (`encryptedPath`) with the body fields plaintext.
    async function seedLegacyDoc(inner: FakeCouchClient): Promise<void> {
        const hmac = await crypto.hmacHash(te.encode("legacy.md"));
        const encPath = await encryptString("legacy.md", crypto);
        await inner.bulkDocs([{
            _id: "file:" + hmac, encryptedPath: encPath,
            type: "file", chunks: ["chunk:x64:legacy"], vclock: { d: 7 },
            mtime: 1, ctime: 1, size: 3, schemaVersion: 2,
        }]);
    }

    it("floor < 3 (v2 vault): still dual-reads a legacy v1 encryptedPath doc", async () => {
        const inner = new FakeCouchClient();
        // cipherVersion floor 2 → not-yet-re-init'd vault, dual-read preserved.
        const enc = new EncryptingCouchClient(inner, crypto, 2);
        await seedLegacyDoc(inner);

        const back = await enc.getDoc<any>("file:legacy.md");
        expect(back._id).toBe("file:legacy.md");
        expect(back.chunks).toEqual(["chunk:x64:legacy"]);
        expect(back.vclock).toEqual({ d: 7 });
        expect(back.encryptedPath).toBeUndefined();
    });

    it("undefined floor: still dual-reads (back-compat default)", async () => {
        const inner = new FakeCouchClient();
        const enc = new EncryptingCouchClient(inner, crypto); // no floor
        await seedLegacyDoc(inner);
        const back = await enc.getDoc<any>("file:legacy.md");
        expect(back.chunks).toEqual(["chunk:x64:legacy"]);
    });

    it("cipherVersion-3 floor: REFUSES a legacy encryptedPath doc (downgrade, #1)", async () => {
        const inner = new FakeCouchClient();
        // A re-init'd v3 vault must reject the unauthenticated legacy body a
        // curious server replays after dropping encBody.
        const enc = new EncryptingCouchClient(inner, crypto, 3);
        await seedLegacyDoc(inner);

        await expect(enc.getDoc<any>("file:legacy.md")).rejects.toBeInstanceOf(EncryptionError);
    });

    it("cipherVersion-3 floor: REFUSES a plaintext-injected file doc (#3)", async () => {
        const inner = new FakeCouchClient();
        const enc = new EncryptingCouchClient(inner, crypto, 3);
        // Server forges a plaintext file doc (no encBody, no encryptedPath) at
        // the real path's hmac id, with a destructive body (deleted/empty).
        const hmac = await crypto.hmacHash(te.encode("realnote.md"));
        await inner.bulkDocs([{
            _id: "file:" + hmac, type: "file", chunks: [], vclock: { evil: 9 },
            mtime: 0, ctime: 0, size: 0, deleted: true, schemaVersion: 2,
        }]);

        await expect(enc.getDoc<any>("file:realnote.md")).rejects.toBeInstanceOf(EncryptionError);
    });

    it("cipherVersion-3 floor: still round-trips a legitimately sealed encBody doc", async () => {
        const inner = new FakeCouchClient();
        const enc = new EncryptingCouchClient(inner, crypto, 3);
        // A normally-written (sealed) doc must remain readable under the floor.
        await enc.bulkDocs([{
            _id: "file:ok.md", type: "file", chunks: ["chunk:x64:ok"],
            vclock: { d: 1 }, mtime: 0, ctime: 0, size: 2, schemaVersion: 2,
        }]);
        const back = await enc.getDoc<any>("file:ok.md");
        expect(back._id).toBe("file:ok.md");
        expect(back.chunks).toEqual(["chunk:x64:ok"]);
    });

    it("cipherVersion-3 floor: passes through non-path docs (chunk docs untouched)", async () => {
        const inner = new FakeCouchClient();
        const enc = new EncryptingCouchClient(inner, crypto, 3);
        // Chunk docs carry no encBody legitimately and must not be rejected.
        await inner.bulkDocs([{ _id: "chunk:x64:deadbeef", type: "chunk" }]);
        const back = await enc.getDoc<any>("chunk:x64:deadbeef");
        expect(back._id).toBe("chunk:x64:deadbeef");
    });
});
