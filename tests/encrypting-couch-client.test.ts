import { describe, it, expect, beforeAll } from "vitest";
import { FakeCouchClient } from "./helpers/fake-couch-client.ts";
import { EncryptingCouchClient } from "../src/db/encrypting-couch-client.ts";
import {
    deriveKeys,
    generateSalt,
    createCryptoProvider,
    type CryptoProvider,
} from "../src/db/crypto-provider.ts";

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
    it("encrypts ChunkDoc.data", async () => {
        const { inner, enc } = makeClient();
        const chunk = { _id: "chunk:abc", type: "chunk", data: btoa("hello") };
        await enc.bulkDocs([chunk]);

        const stored = await inner.getDoc<any>("chunk:abc");
        expect(stored!.data).not.toBe(btoa("hello"));
        expect(stored!.data).toContain(":");
    });

    it("encrypts ConfigDoc.data and _id", async () => {
        const { inner, enc } = makeClient();
        const config = { _id: "config:.obsidian/app.json", type: "config", data: btoa("{}"), vclock: {}, mtime: 0, size: 2 };
        await enc.bulkDocs([config]);

        const allDocs = await inner.allDocs<any>({ startkey: "config:", endkey: "config:￰", include_docs: true });
        const stored = allDocs.rows[0]?.doc;
        expect(stored).toBeDefined();
        expect(stored._id).toMatch(/^config:[0-9a-f]{64}$/);
        expect(stored.data).not.toBe(btoa("{}"));
        expect(stored.data).toContain(":");
        expect(stored.encryptedPath).toBeDefined();
    });

    it("does NOT encrypt FileDoc data fields but encrypts _id", async () => {
        const { inner, enc } = makeClient();
        const file = { _id: "file:note.md", type: "file", chunks: ["chunk:abc"], vclock: { d: 1 }, mtime: 1, ctime: 1, size: 5 };
        await enc.bulkDocs([file]);

        const allDocs = await inner.allDocs<any>({ startkey: "file:", endkey: "file:￰", include_docs: true });
        const stored = allDocs.rows[0]?.doc;
        expect(stored._id).toMatch(/^file:[0-9a-f]{64}$/);
        expect(stored.vclock).toEqual({ d: 1 });
        expect(stored.chunks).toEqual(["chunk:abc"]);
        expect(stored.mtime).toBe(1);
        expect(stored.encryptedPath).toBeDefined();
    });

    it("does not encrypt encryption:meta doc", async () => {
        const { inner, enc } = makeClient();
        const meta = { _id: "encryption:meta", type: "encryption-meta", salt: "abc", keyCheck: "xyz", version: 1 };
        await enc.bulkDocs([meta]);

        const stored = await inner.getDoc<any>("encryption:meta");
        expect(stored!.salt).toBe("abc");
        expect(stored!.keyCheck).toBe("xyz");
    });
});

describe("EncryptingCouchClient pull (decrypt)", () => {
    it("bulkGet decrypts ChunkDoc.data", async () => {
        const { inner, enc } = makeClient();
        const original = btoa("secret content");
        const encrypted = await crypto.encrypt(original);
        await inner.bulkDocs([{ _id: "chunk:x", type: "chunk", data: encrypted }]);

        const [doc] = await enc.bulkGet<any>(["chunk:x"]);
        expect(doc.data).toBe(original);
    });

    it("getDoc decrypts (roundtrip via enc)", async () => {
        const { enc } = makeClient();
        await enc.bulkDocs([{ _id: "config:test", type: "config", data: btoa("cfg data"), vclock: {}, mtime: 0, size: 0 }]);

        const doc = await enc.getDoc<any>("config:test");
        expect(doc!.data).toBe(btoa("cfg data"));
        expect(doc!._id).toBe("config:test");
    });

    it("changes decrypts docs when include_docs is true", async () => {
        const { inner, enc } = makeClient();
        const encrypted = await crypto.encrypt(btoa("chunk data"));
        await inner.bulkDocs([{ _id: "chunk:y", type: "chunk", data: encrypted }]);

        const result = await enc.changes<any>({ include_docs: true });
        const chunkRow = result.results.find((r) => r.id === "chunk:y");
        expect(chunkRow!.doc.data).toBe(btoa("chunk data"));
    });

    it("allDocs decrypts when include_docs is true", async () => {
        const { inner, enc } = makeClient();
        const encrypted = await crypto.encrypt(btoa("allDocs data"));
        await inner.bulkDocs([{ _id: "chunk:z", type: "chunk", data: encrypted }]);

        const result = await enc.allDocs<any>({ keys: ["chunk:z"], include_docs: true });
        expect(result.rows[0].doc!.data).toBe(btoa("allDocs data"));
    });
});

describe("EncryptingCouchClient roundtrip", () => {
    it("push → pull preserves content", async () => {
        const { enc } = makeClient();
        const original = btoa("roundtrip test data ok");
        await enc.bulkDocs([{ _id: "chunk:rt", type: "chunk", data: original }]);

        const [pulled] = await enc.bulkGet<any>(["chunk:rt"]);
        expect(pulled.data).toBe(original);
    });

    it("mixed doc types in single bulkDocs", async () => {
        const { enc } = makeClient();
        const chunk = { _id: "chunk:m1", type: "chunk", data: btoa("chunk") };
        const file = { _id: "file:f.md", type: "file", chunks: ["chunk:m1"], vclock: {}, mtime: 0, ctime: 0, size: 5 };
        const config = { _id: "config:app", type: "config", data: btoa("cfg"), vclock: {}, mtime: 0, size: 3 };
        await enc.bulkDocs([chunk, file, config]);

        const [c] = await enc.bulkGet<any>(["chunk:m1"]);
        expect(c.data).toBe(btoa("chunk"));
        const f = await enc.getDoc<any>("file:f.md");
        expect(f!.chunks).toEqual(["chunk:m1"]);
        const cfg = await enc.getDoc<any>("config:app");
        expect(cfg!.data).toBe(btoa("cfg"));
    });
});

describe("EncryptingCouchClient Level 2 (path encryption)", () => {
    it("encrypts file _id on push and adds encryptedPath", async () => {
        const { inner, enc } = makeClient();
        const file = { _id: "file:notes/hello.md", type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0 };
        await enc.bulkDocs([file]);

        const allDocs = await inner.allDocs<any>({ startkey: "file:", endkey: "file:￰", include_docs: true });
        const stored = allDocs.rows[0]?.doc;
        expect(stored).toBeDefined();
        expect(stored._id).not.toBe("file:notes/hello.md");
        expect(stored._id).toMatch(/^file:[0-9a-f]{64}$/);
        expect(stored.encryptedPath).toBeDefined();
        expect(stored.encryptedPath).toContain(":");
    });

    it("decrypts file _id on pull (getDoc)", async () => {
        const { enc } = makeClient();
        await enc.bulkDocs([{ _id: "file:my/path.md", type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0 }]);

        const doc = await enc.getDoc<any>("file:my/path.md");
        expect(doc).not.toBeNull();
        expect(doc!._id).toBe("file:my/path.md");
    });

    it("encrypts config _id on push", async () => {
        const { inner, enc } = makeClient();
        const cfg = { _id: "config:.obsidian/app.json", type: "config", data: btoa("{}"), vclock: {}, mtime: 0, size: 2 };
        await enc.bulkDocs([cfg]);

        const allDocs = await inner.allDocs<any>({ startkey: "config:", endkey: "config:￰", include_docs: true });
        const stored = allDocs.rows[0]?.doc;
        expect(stored._id).toMatch(/^config:[0-9a-f]{64}$/);
    });

    it("does NOT encrypt chunk _id", async () => {
        const { inner, enc } = makeClient();
        await enc.bulkDocs([{ _id: "chunk:abc123", type: "chunk", data: btoa("x") }]);

        const doc = await inner.getDoc<any>("chunk:abc123");
        expect(doc).not.toBeNull();
        expect(doc!.encryptedPath).toBeUndefined();
    });

    it("changes returns decrypted _id and row.id", async () => {
        const { enc } = makeClient();
        await enc.bulkDocs([{ _id: "file:test.md", type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0 }]);

        const result = await enc.changes<any>({ include_docs: true });
        const row = result.results.find((r) => r.doc?.type === "file");
        expect(row).toBeDefined();
        expect(row!.id).toBe("file:test.md");
        expect(row!.doc._id).toBe("file:test.md");
    });

    it("allDocs with keys translates IDs", async () => {
        const { enc } = makeClient();
        await enc.bulkDocs([{ _id: "file:a.md", type: "file", chunks: [], vclock: {}, mtime: 0, ctime: 0, size: 0 }]);

        const result = await enc.allDocs<any>({ keys: ["file:a.md"], include_docs: true });
        expect(result.rows.length).toBe(1);
        expect(result.rows[0].doc._id).toBe("file:a.md");
    });

    it("roundtrip: push file + chunk → pull via getDoc", async () => {
        const { enc } = makeClient();
        const chunk = { _id: "chunk:r1", type: "chunk", data: btoa("content") };
        const file = { _id: "file:doc.md", type: "file", chunks: ["chunk:r1"], vclock: { d: 1 }, mtime: 1, ctime: 1, size: 7 };
        await enc.bulkDocs([chunk, file]);

        const [c] = await enc.bulkGet<any>(["chunk:r1"]);
        expect(c.data).toBe(btoa("content"));
        const f = await enc.getDoc<any>("file:doc.md");
        expect(f!._id).toBe("file:doc.md");
        expect(f!.chunks).toEqual(["chunk:r1"]);
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
