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

    it("encrypts ConfigDoc.data", async () => {
        const { inner, enc } = makeClient();
        const config = { _id: "config:.obsidian/app.json", type: "config", data: btoa("{}"), vclock: {}, mtime: 0, size: 2 };
        await enc.bulkDocs([config]);

        const stored = await inner.getDoc<any>("config:.obsidian/app.json");
        expect(stored!.data).not.toBe(btoa("{}"));
        expect(stored!.data).toContain(":");
    });

    it("does NOT encrypt FileDoc", async () => {
        const { inner, enc } = makeClient();
        const file = { _id: "file:note.md", type: "file", chunks: ["chunk:abc"], vclock: { d: 1 }, mtime: 1, ctime: 1, size: 5 };
        await enc.bulkDocs([file]);

        const stored = await inner.getDoc<any>("file:note.md");
        expect(stored!.vclock).toEqual({ d: 1 });
        expect(stored!.chunks).toEqual(["chunk:abc"]);
        expect(stored!.mtime).toBe(1);
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

    it("getDoc decrypts", async () => {
        const { inner, enc } = makeClient();
        const encrypted = await crypto.encrypt(btoa("cfg data"));
        await inner.bulkDocs([{ _id: "config:test", type: "config", data: encrypted, vclock: {}, mtime: 0, size: 0 }]);

        const doc = await enc.getDoc<any>("config:test");
        expect(doc!.data).toBe(btoa("cfg data"));
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
