/**
 * Invariants 11-15 — one focused assertion per invariant established
 * in v0.25.0 schema self-description (plan: dreamy-riding-star.md).
 *
 *  11. Replicated docs carry `schemaVersion` (type-level requirement,
 *      writers always stamp).
 *  12. All attachment binary on the wire is envelope-formatted
 *      (`[codec][IV?][body]`), even plaintext+uncompressed.
 *  13. Encrypted strings are envelope-formatted (no legacy
 *      `base64(IV):base64(cipher)` shape remains in the API surface).
 *  14. Chunk ids carry the hash-algorithm tag (`chunk:<alg>:<hash>`).
 *  15. Every local Dexie DB carries `_meta.schemaVersion` stamped on
 *      first open.
 *
 * These tests target the invariant directly so a regression surfaces
 * here rather than dispersed across the unit-level suites.
 */

import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll } from "vitest";
import { FakeCouchClient } from "./helpers/fake-couch-client.ts";
import { LocalDB } from "../src/db/local-db.ts";
import { ConfigLocalDB } from "../src/db/config-local-db.ts";
import { HistoryStorage } from "../src/history/storage.ts";
import { LogStorage } from "../src/log/log-storage.ts";
import { CompressingCouchClient } from "../src/db/compressing-couch-client.ts";
import { EncryptingCouchClient } from "../src/db/encrypting-couch-client.ts";
import {
    createCryptoProvider,
    deriveKeys,
    generateSalt,
    type CryptoProvider,
} from "../src/db/crypto-provider.ts";
import {
    decodeEnvelope,
    encryptString,
} from "../src/db/envelope.ts";
import { splitIntoChunks } from "../src/db/chunker.ts";
import { makeChunkId, parseChunkId, ID_RANGE } from "../src/types/doc-id.ts";
import { CURRENT_SCHEMA_VERSION } from "../src/types.ts";
import { asEnvelope } from "./helpers/envelope.ts";

let crypto: CryptoProvider;
beforeAll(async () => {
    crypto = createCryptoProvider(await deriveKeys("inv-test", generateSalt()));
});

// ── 11: schemaVersion required on writer paths ─────────────────

describe("invariant 11 — schemaVersion stamped on every writer path", () => {
    it("chunker output carries CURRENT_SCHEMA_VERSION", async () => {
        const chunks = await splitIntoChunks(new TextEncoder().encode("body").buffer);
        for (const c of chunks) {
            expect(c.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
        }
    });
});

// ── 12: every attachment binary is envelope-formatted ──────────

describe("invariant 12 — attachment envelope universality", () => {
    it("plaintext + uncompressed stack still writes the 0x00 codec byte", async () => {
        const inner = new FakeCouchClient();
        // Caller's responsibility (push-pipeline / remote-couch /
        // tests) is to envelope-wrap raw bytes before pushing.
        await inner.bulkDocsWithAttachments([{
            doc: { _id: "chunk:x64:flat", type: "chunk" },
            attachments: { c: { contentType: "x", data: asEnvelope(new TextEncoder().encode("hi")) } },
        }]);
        const blob = await inner.getAttachment("chunk:x64:flat", "c");
        expect(blob).not.toBeNull();
        const env = decodeEnvelope(blob!);
        expect(env.bits).toEqual({ encrypted: false, compressed: false });
    });

    it("each codec decorator sets exactly its own bit", async () => {
        const inner = new FakeCouchClient();
        const enc = new EncryptingCouchClient(inner, crypto);
        await enc.bulkDocsWithAttachments([{
            doc: { _id: "chunk:x64:e" },
            attachments: { c: { contentType: "x", data: asEnvelope(new TextEncoder().encode("e")) } },
        }]);
        const onlyEncrypted = (await inner.getAttachment("chunk:x64:e", "c"))!;
        expect(onlyEncrypted[0]).toBe(0x01);

        const innerB = new FakeCouchClient();
        const gz = new CompressingCouchClient(innerB);
        await gz.bulkDocsWithAttachments([{
            doc: { _id: "chunk:x64:g" },
            attachments: { c: { contentType: "x", data: asEnvelope(new TextEncoder().encode("g")) } },
        }]);
        const onlyCompressed = (await innerB.getAttachment("chunk:x64:g", "c"))!;
        expect(onlyCompressed[0]).toBe(0x02);

        const innerC = new FakeCouchClient();
        const stack = new CompressingCouchClient(new EncryptingCouchClient(innerC, crypto));
        await stack.bulkDocsWithAttachments([{
            doc: { _id: "chunk:x64:gz" },
            attachments: { c: { contentType: "x", data: asEnvelope(new TextEncoder().encode("gz")) } },
        }]);
        const both = (await innerC.getAttachment("chunk:x64:gz", "c"))!;
        expect(both[0]).toBe(0x03);
    });
});

// ── 13: encrypted strings are envelope-formatted (legacy shape gone) ─

describe("invariant 13 — encrypted string envelope (legacy iv:cipher shape removed)", () => {
    it("CryptoProvider exposes only IV-split binary primitives — no string envelope API", () => {
        const cp = crypto as unknown as Record<string, unknown>;
        expect(typeof cp.encryptBytesIv).toBe("function");
        expect(typeof cp.decryptBytesIv).toBe("function");
        expect(typeof cp.hmacHash).toBe("function");
        // The legacy string envelope API is physically removed —
        // surfacing it again would re-open the unversioned-envelope hole.
        expect(cp.encrypt).toBeUndefined();
        expect(cp.decrypt).toBeUndefined();
        expect(cp.encryptPath).toBeUndefined();
        expect(cp.decryptPath).toBeUndefined();
    });

    it("encryptString output is base64(envelope) with no colon separator", async () => {
        const wire = await encryptString("payload", crypto);
        expect(wire).toMatch(/^[A-Za-z0-9+/=]+$/);
        expect(wire).not.toContain(":");
    });
});

// ── 14: chunk id carries algorithm tag ─────────────────────────

describe("invariant 14 — chunk id self-declares its hash algorithm", () => {
    it("makeChunkId emits chunk:x64:<hash> by default", () => {
        expect(makeChunkId("deadbeefcafef00d")).toBe("chunk:x64:deadbeefcafef00d");
    });

    it("makeChunkId accepts hmac tag for encrypted-vault ids", () => {
        // 64 hex chars = HMAC-SHA256
        const hmacHash = "f".repeat(64);
        expect(makeChunkId(hmacHash, "hmac")).toBe("chunk:hmac:" + hmacHash);
    });

    it("parseChunkId round-trips both algorithms", () => {
        expect(parseChunkId("chunk:x64:abcd1234abcd1234")).toEqual({
            alg: "x64", hash: "abcd1234abcd1234",
        });
        expect(parseChunkId("chunk:hmac:" + "0".repeat(64))).toEqual({
            alg: "hmac", hash: "0".repeat(64),
        });
    });

    it("parseChunkId throws on legacy chunk:<hex> (no algorithm tag)", () => {
        expect(() => parseChunkId("chunk:deadbeefcafef00d")).toThrow(/missing algorithm tag/);
    });

    it("parseChunkId throws on unknown algorithm", () => {
        expect(() => parseChunkId("chunk:b3:abcd")).toThrow(/unknown algorithm/);
    });

    it("ID_RANGE.chunk.{x64,hmac} narrow the chunk range per algorithm", () => {
        expect(ID_RANGE.chunk.x64.startkey).toBe("chunk:x64:");
        expect(ID_RANGE.chunk.x64.endkey.startsWith("chunk:x64:")).toBe(true);
        expect(ID_RANGE.chunk.hmac.startkey).toBe("chunk:hmac:");
        expect(ID_RANGE.chunk.hmac.endkey.startsWith("chunk:hmac:")).toBe(true);
    });
});

// ── 15: each Dexie DB carries _meta.schemaVersion = 1 ──────────

describe("invariant 15 — local schema version stamped on every Dexie DB", () => {
    const uid = (s: string) => `inv15-${s}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    async function readMeta(dbName: string): Promise<number | null> {
        const { default: Dexie } = await import("dexie");
        const probe = new Dexie(dbName);
        probe.version(3).stores({ docs: "_id, type, _localSeq", meta: "key", _meta: "&key" });
        await probe.open();
        const row = await probe.table("_meta").get("schemaVersion");
        probe.close();
        return row ? (row.value as number) : null;
    }

    it("LocalDB stamps schemaVersion on both docs + meta stores", async () => {
        const name = uid("local");
        const db = new LocalDB(name);
        db.open();
        await db.ensureSchemaVersion();
        await db.close();

        expect(await readMeta(name)).toBe(1);
        expect(await readMeta(`${name}-meta`)).toBe(1);
    });

    it("ConfigLocalDB stamps schemaVersion", async () => {
        const name = uid("config");
        const db = new ConfigLocalDB(name);
        db.open();
        await db.ensureSchemaVersion();
        await db.close();
        expect(await readMeta(name)).toBe(1);
    });

    it("HistoryStorage stamps schemaVersion", async () => {
        const vault = uid("hist");
        const h = new HistoryStorage(vault);
        await h.ensureSchemaVersion();
        h.close();
        const { default: Dexie } = await import("dexie");
        const probe = new Dexie(`couchsync-history-${vault}`);
        probe.version(2).stores({
            diffs: "++id, [filePath+timestamp], filePath, timestamp",
            snapshots: "filePath",
            _meta: "&key",
        });
        await probe.open();
        const row = await probe.table("_meta").get("schemaVersion");
        probe.close();
        expect(row?.value).toBe(1);
    });

    it("LogStorage stamps schemaVersion", async () => {
        const vault = uid("log");
        const l = new LogStorage(vault);
        await l.ensureSchemaVersion();
        l.close();
        const { default: Dexie } = await import("dexie");
        const probe = new Dexie(`couchsync-logs-${vault}`);
        probe.version(2).stores({ entries: "++id, timestamp", _meta: "&key" });
        await probe.open();
        const row = await probe.table("_meta").get("schemaVersion");
        probe.close();
        expect(row?.value).toBe(1);
    });
});
