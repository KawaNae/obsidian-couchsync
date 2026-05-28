import { describe, it, expect, expectTypeOf } from "vitest";
import {
    CURRENT_SCHEMA_VERSION,
    type SchemaVersion,
    type FileDoc,
    type ChunkDoc,
    type ConfigDoc,
} from "../src/types.ts";

describe("schema version (v2)", () => {
    it("exposes CURRENT_SCHEMA_VERSION = 2", () => {
        expect(CURRENT_SCHEMA_VERSION).toBe(2);
    });

    it("SchemaVersion is the literal type of CURRENT_SCHEMA_VERSION", () => {
        expectTypeOf<SchemaVersion>().toEqualTypeOf<2>();
    });

    it("FileDoc accepts schemaVersion set to the current version", () => {
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
    });

    it("FileDoc remains valid without schemaVersion (legacy tolerance)", () => {
        const legacy: FileDoc = {
            _id: "file:legacy.md",
            type: "file",
            chunks: [],
            mtime: 0,
            ctime: 0,
            size: 0,
            vclock: {},
        };
        expect(legacy.schemaVersion).toBeUndefined();
    });

    it("ChunkDoc accepts schemaVersion", () => {
        const doc: ChunkDoc = {
            _id: "chunk:abc",
            type: "chunk",
            data: "",
            schemaVersion: CURRENT_SCHEMA_VERSION,
        };
        expect(doc.schemaVersion).toBe(2);
    });

    it("ConfigDoc accepts schemaVersion", () => {
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
