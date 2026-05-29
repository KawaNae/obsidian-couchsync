import { describe, it, expect, beforeAll } from "vitest";
import { FakeCouchClient } from "./helpers/fake-couch-client.ts";
import { EncryptingCouchClient } from "../src/db/encrypting-couch-client.ts";
import {
    deriveKeys,
    generateSalt,
    createCryptoProvider,
    type CryptoProvider,
} from "../src/db/crypto-provider.ts";
import { decryptString } from "../src/db/envelope.ts";

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
    it("encrypts ConfigDoc.data via envelope and translates _id", async () => {
        const { inner, enc } = makeClient();
        const config = { _id: "config:.obsidian/app.json", type: "config", data: btoa("{}"), vclock: {}, mtime: 0, size: 2, schemaVersion: 2 };
        await enc.bulkDocs([config]);

        const allDocs = await inner.allDocs<any>({ startkey: "config:", endkey: "config:￰", include_docs: true });
        const stored = allDocs.rows[0]?.doc;
        expect(stored).toBeDefined();
        expect(stored._id).toMatch(/^config:[0-9a-f]{64}$/);
        // Encrypted ConfigDoc.data is a base64-wrapped envelope — distinct
        // from the original plaintext base64 and without the legacy
        // colon-separated `iv:cipher` form.
        expect(stored.data).not.toBe(btoa("{}"));
        expect(stored.data).not.toContain(":");
        expect(stored.encryptedPath).toBeDefined();
    });

    it("does NOT encrypt FileDoc body fields but encrypts _id", async () => {
        const { inner, enc } = makeClient();
        const file = { _id: "file:note.md", type: "file", chunks: ["chunk:x64:abc"], vclock: { d: 1 }, mtime: 1, ctime: 1, size: 5, schemaVersion: 2 };
        await enc.bulkDocs([file]);

        const allDocs = await inner.allDocs<any>({ startkey: "file:", endkey: "file:￰", include_docs: true });
        const stored = allDocs.rows[0]?.doc;
        expect(stored._id).toMatch(/^file:[0-9a-f]{64}$/);
        expect(stored.vclock).toEqual({ d: 1 });
        expect(stored.chunks).toEqual(["chunk:x64:abc"]);
        expect(stored.mtime).toBe(1);
        expect(stored.encryptedPath).toBeDefined();
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
    it("getDoc decrypts ConfigDoc.data and restores _id", async () => {
        const { enc } = makeClient();
        const original = btoa("cfg data");
        await enc.bulkDocs([{ _id: "config:test", type: "config", data: original, vclock: {}, mtime: 0, size: 0, schemaVersion: 2 }]);

        const doc = await enc.getDoc<any>("config:test");
        expect(doc!.data).toBe(original);
        expect(doc!._id).toBe("config:test");
    });

    it("changes decrypts docs when include_docs is true", async () => {
        const { enc } = makeClient();
        await enc.bulkDocs([{ _id: "config:c1", type: "config", data: btoa("cfg-c1"), vclock: {}, mtime: 0, size: 0, schemaVersion: 2 }]);

        const result = await enc.changes<any>({ include_docs: true });
        const row = result.results.find((r) => r.id === "config:c1");
        expect(row!.doc.data).toBe(btoa("cfg-c1"));
        expect(row!.doc._id).toBe("config:c1");
    });

    it("allDocs decrypts when include_docs is true", async () => {
        const { enc } = makeClient();
        await enc.bulkDocs([{ _id: "config:a", type: "config", data: btoa("a"), vclock: {}, mtime: 0, size: 0, schemaVersion: 2 }]);

        const result = await enc.allDocs<any>({ keys: ["config:a"], include_docs: true });
        expect(result.rows[0].doc!.data).toBe(btoa("a"));
        expect(result.rows[0].doc!._id).toBe("config:a");
    });

    it("rejects ciphertext produced by a different key", async () => {
        // Realistic 2-vault scenario: writer encrypts under key A and
        // pushes via its own EncryptingCouchClient; a reader with key B
        // pulls the same doc and must surface EncryptionError rather
        // than silently returning garbage. allDocs decrypts inline, so
        // the rejection bubbles out of the allDocs call itself.
        const inner = new FakeCouchClient();
        const keyA = createCryptoProvider(await deriveKeys("alpha", generateSalt()));
        const keyB = createCryptoProvider(await deriveKeys("beta", generateSalt()));
        const writerA = new EncryptingCouchClient(inner, keyA);
        const readerB = new EncryptingCouchClient(inner, keyB);

        const path = "config:.obsidian/secret.json";
        await writerA.bulkDocs([{
            _id: path, type: "config", data: btoa("secret"), vclock: {},
            mtime: 0, size: 6, schemaVersion: 2,
        }]);

        await expect(readerB.allDocs<any>({
            startkey: "config:", endkey: "config:￰", include_docs: true,
        })).rejects.toThrow(/Failed to decrypt/);
    });
});

describe("EncryptingCouchClient roundtrip", () => {
    it("push → pull preserves ConfigDoc content and path", async () => {
        const { enc } = makeClient();
        const original = btoa("roundtrip test data ok");
        await enc.bulkDocs([{ _id: "config:rt.json", type: "config", data: original, vclock: {}, mtime: 0, size: 0, schemaVersion: 2 }]);

        const pulled = await enc.getDoc<any>("config:rt.json");
        expect(pulled!.data).toBe(original);
        expect(pulled!._id).toBe("config:rt.json");
    });

    it("mixed doc types in single bulkDocs", async () => {
        const { enc } = makeClient();
        const file = { _id: "file:f.md", type: "file", chunks: ["chunk:x64:m1"], vclock: {}, mtime: 0, ctime: 0, size: 5, schemaVersion: 2 };
        const config = { _id: "config:app", type: "config", data: btoa("cfg"), vclock: {}, mtime: 0, size: 3, schemaVersion: 2 };
        await enc.bulkDocs([file, config]);

        const f = await enc.getDoc<any>("file:f.md");
        expect(f!.chunks).toEqual(["chunk:x64:m1"]);
        const cfg = await enc.getDoc<any>("config:app");
        expect(cfg!.data).toBe(btoa("cfg"));
    });
});

describe("EncryptingCouchClient Level 2 (path encryption)", () => {
    it("encrypts file _id on push and adds encryptedPath", async () => {
        const { inner, enc } = makeClient();
        const file = { _id: "file:notes/hello.md", type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0, schemaVersion: 2 };
        await enc.bulkDocs([file]);

        const allDocs = await inner.allDocs<any>({ startkey: "file:", endkey: "file:￰", include_docs: true });
        const stored = allDocs.rows[0]?.doc;
        expect(stored).toBeDefined();
        expect(stored._id).not.toBe("file:notes/hello.md");
        expect(stored._id).toMatch(/^file:[0-9a-f]{64}$/);
        // encryptedPath is the base64-wrapped envelope, no longer the
        // legacy `base64(iv):base64(cipher)` shape.
        expect(stored.encryptedPath).toBeDefined();
        expect(stored.encryptedPath).not.toContain(":");
        // Roundtrip via decryptString to confirm the envelope is well-formed.
        const decoded = await decryptString(stored.encryptedPath, crypto);
        expect(decoded).toBe("notes/hello.md");
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
        const cfg = { _id: "config:.obsidian/app.json", type: "config", data: btoa("{}"), vclock: {}, mtime: 0, size: 2, schemaVersion: 2 };
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
        const config = { _id: "config:rt", type: "config", data: btoa("content"), vclock: {}, mtime: 0, size: 7, schemaVersion: 2 };
        const file = { _id: "file:doc.md", type: "file", chunks: ["chunk:x64:r1"], vclock: { d: 1 }, mtime: 1, ctime: 1, size: 7, schemaVersion: 2 };
        await enc.bulkDocs([config, file]);

        const c = await enc.getDoc<any>("config:rt");
        expect(c!.data).toBe(btoa("content"));
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
