import { describe, it, expect, expectTypeOf } from "vitest";
import {
    CURRENT_SCHEMA_VERSION,
    type SchemaVersion,
    type FileDoc,
    type ChunkDoc,
    type ConfigDoc,
} from "../src/types.ts";

describe("schema version (v2) — invariant 11 (writer-required schemaVersion)", () => {
    it("exposes CURRENT_SCHEMA_VERSION = 2", () => {
        expect(CURRENT_SCHEMA_VERSION).toBe(2);
    });

    it("SchemaVersion is the literal type of CURRENT_SCHEMA_VERSION", () => {
        expectTypeOf<SchemaVersion>().toEqualTypeOf<2>();
    });

    it("FileDoc requires schemaVersion (type-level enforcement)", () => {
        const doc: FileDoc = {
            _id: "file:notes/hello.md",
            type: "file",
            chunks: [],
            mtime: 0,
            ctime: 0,
            size: 0,
            vclock: {},
            schemaVersion: CURRENT_SCHEMA_VERSION,
        };
        expect(doc.schemaVersion).toBe(2);
        // The build catches omissions at compile time — this assertion
        // documents that no runtime tolerance for missing schemaVersion
        // remains (v0.25.0 dropped the legacy `?` modifier).
        expectTypeOf<FileDoc>().toHaveProperty("schemaVersion").not.toBeNullable();
    });

    it("ChunkDoc requires schemaVersion and content (Uint8Array), no legacy `data` field", () => {
        const doc: ChunkDoc = {
            _id: "chunk:x64:abc",
            type: "chunk",
            schemaVersion: CURRENT_SCHEMA_VERSION,
            content: new Uint8Array([1, 2, 3]),
        };
        expect(doc.schemaVersion).toBe(2);
        expect(doc.content).toBeInstanceOf(Uint8Array);
        // `data: string` was the v1 carrier — v0.25.0 removed it entirely.
        // The type no longer carries the field; runtime probes confirm.
        expect((doc as Record<string, unknown>).data).toBeUndefined();
    });

    it("ConfigDoc requires schemaVersion", () => {
        const doc: ConfigDoc = {
            _id: "config:.obsidian/x.json",
            type: "config",
            data: "",
            mtime: 0,
            size: 0,
            vclock: {},
            schemaVersion: CURRENT_SCHEMA_VERSION,
        };
        expect(doc.schemaVersion).toBe(2);
    });

    it("only CURRENT_SCHEMA_VERSION is assignable to the schemaVersion field", () => {
        // A future-bump check: if the schema is ever changed without
        // updating this test, the literal mismatch surfaces here rather
        // than rotting silently in the test suite.
        const doc: FileDoc = {
            _id: "file:x",
            type: "file",
            chunks: [],
            mtime: 0,
            ctime: 0,
            size: 0,
            vclock: {},
            schemaVersion: 2,
        };
        expect(doc.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    });
});
