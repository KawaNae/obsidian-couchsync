import { describe, it, expect } from "vitest";
import {
    DOC_ID,
    ID_RANGE,
    makeFileId,
    makeChunkId,
    makeConfigId,
    isFileDocId,
    isChunkDocId,
    isConfigDocId,
    isLocalDocId,
    isReplicatedDocId,
    filePathFromId,
    chunkHashFromId,
    configPathFromId,
    parseDocId,
} from "../src/types/doc-id.ts";

describe("DOC_ID constants", () => {
    it("exposes the three replicated kinds", () => {
        expect(DOC_ID.FILE).toBe("file:");
        expect(DOC_ID.CHUNK).toBe("chunk:");
        expect(DOC_ID.CONFIG).toBe("config:");
    });

    it("exposes matching range sentinels", () => {
        expect(ID_RANGE.file.startkey).toBe("file:");
        expect(ID_RANGE.file.endkey).toBe("file:\ufff0");
        expect(ID_RANGE.chunk.startkey).toBe("chunk:");
        expect(ID_RANGE.chunk.endkey).toBe("chunk:\ufff0");
        expect(ID_RANGE.config.startkey).toBe("config:");
        expect(ID_RANGE.config.endkey).toBe("config:\ufff0");
    });
});

describe("make* and *FromId round-trip", () => {
    it("round-trips file paths", () => {
        const id = makeFileId("notes/hello.md");
        expect(id).toBe("file:notes/hello.md");
        expect(filePathFromId(id)).toBe("notes/hello.md");
    });

    it("round-trips chunk hashes", () => {
        const id = makeChunkId("a1b2c3d4e5f6");
        expect(id).toBe("chunk:a1b2c3d4e5f6");
        expect(chunkHashFromId(id)).toBe("a1b2c3d4e5f6");
    });

    it("round-trips config paths", () => {
        const id = makeConfigId(".obsidian/appearance.json");
        expect(id).toBe("config:.obsidian/appearance.json");
        expect(configPathFromId(id)).toBe(".obsidian/appearance.json");
    });

    it("round-trips unicode paths", () => {
        const p = "ノート/日本語 ファイル.md";
        expect(filePathFromId(makeFileId(p))).toBe(p);
    });

    it("round-trips paths containing colons (not at start)", () => {
        // Windows forbids `:` in filenames but Linux/macOS allow it.
        const p = "scratch/time-09:00.md";
        const id = makeFileId(p);
        expect(id).toBe("file:scratch/time-09:00.md");
        expect(filePathFromId(id)).toBe(p);
    });

    it("handles empty payload (edge case)", () => {
        // We don't expect this in practice but the helpers should not explode.
        const id = makeFileId("");
        expect(id).toBe("file:");
        expect(filePathFromId(id)).toBe("");
    });
});

describe("is*Id predicates", () => {
    it("identifies file doc ids", () => {
        expect(isFileDocId("file:notes/a.md")).toBe(true);
        expect(isFileDocId("file:")).toBe(true); // edge
        expect(isFileDocId("chunk:abc")).toBe(false);
        expect(isFileDocId("config:.obsidian/app.json")).toBe(false);
        expect(isFileDocId("_local/scan-cursor")).toBe(false);
        expect(isFileDocId("notes/a.md")).toBe(false); // bare path (legacy)
    });

    it("identifies chunk doc ids", () => {
        expect(isChunkDocId("chunk:abcd1234")).toBe(true);
        expect(isChunkDocId("chunk:")).toBe(true);
        expect(isChunkDocId("config:foo")).toBe(false);
        expect(isChunkDocId("file:foo")).toBe(false);
    });

    it("identifies config doc ids", () => {
        expect(isConfigDocId("config:.obsidian/app.json")).toBe(true);
        expect(isConfigDocId("config:")).toBe(true);
        expect(isConfigDocId("chunk:foo")).toBe(false);
        expect(isConfigDocId("file:foo")).toBe(false);
    });

    it("identifies local doc ids", () => {
        expect(isLocalDocId("_local/scan-cursor")).toBe(true);
        expect(isLocalDocId("_design/view")).toBe(true); // anything with leading _
        expect(isLocalDocId("file:foo")).toBe(false);
    });

    it("predicates are mutually exclusive for replicated kinds", () => {
        const ids = [
            "file:notes/a.md",
            "chunk:abc",
            "config:.obsidian/app.json",
        ];
        for (const id of ids) {
            const matches = [
                isFileDocId(id),
                isChunkDocId(id),
                isConfigDocId(id),
            ].filter(Boolean);
            expect(matches.length).toBe(1);
        }
    });

    it("isReplicatedDocId covers file/chunk/config", () => {
        expect(isReplicatedDocId("file:a")).toBe(true);
        expect(isReplicatedDocId("chunk:a")).toBe(true);
        expect(isReplicatedDocId("config:a")).toBe(true);
        expect(isReplicatedDocId("_local/x")).toBe(false);
        expect(isReplicatedDocId("notes/legacy.md")).toBe(false);
    });
});

describe("parseDocId", () => {
    it("parses each replicated kind", () => {
        expect(parseDocId("file:notes/a.md")).toEqual({
            kind: "file",
            path: "notes/a.md",
        });
        expect(parseDocId("chunk:abcd")).toEqual({
            kind: "chunk",
            hash: "abcd",
        });
        expect(parseDocId("config:.obsidian/app.json")).toEqual({
            kind: "config",
            path: ".obsidian/app.json",
        });
    });

    it("parses _local/<name>", () => {
        expect(parseDocId("_local/scan-cursor")).toEqual({
            kind: "local",
            name: "scan-cursor",
        });
    });

    it("returns unknown for bare legacy ids", () => {
        expect(parseDocId("notes/legacy.md")).toEqual({ kind: "unknown" });
    });

    it("returns unknown for empty string", () => {
        expect(parseDocId("")).toEqual({ kind: "unknown" });
    });

    it("handles _design/ as local-kind (leading underscore)", () => {
        expect(parseDocId("_design/view")).toEqual({
            kind: "local",
            name: "design/view",
        });
    });
});

describe("prefix disjointness (the whole point of the scheme)", () => {
    it("chunk: and config: are lexicographically disjoint despite sharing 'c'", () => {
        // A range query over "chunk:" must NOT match "config:..." entries
        // because ':' (0x3A) < 'f' (0x66) so "chunk:\ufff0" < "config:".
        expect("chunk:\ufff0" < "config:").toBe(true);
        // And "config:\ufff0" < "file:" because 'c' < 'f'.
        expect("config:\ufff0" < "file:").toBe(true);
    });

    it("file: range does not swallow future prefixes that start with f", () => {
        // Any future "fooX:" doc type would need to sort AFTER "file:\ufff0".
        // This test documents the constraint for future maintainers.
        expect("file:\ufff0" < "foo:").toBe(true);
    });
});

describe("filePathFromId error handling", () => {
    it("throws on wrong-kind id", () => {
        expect(() => filePathFromId("chunk:abc")).toThrow();
        expect(() => filePathFromId("legacy/bare.md")).toThrow();
    });
});

describe("chunkHashFromId error handling", () => {
    it("throws on wrong-kind id", () => {
        expect(() => chunkHashFromId("file:foo")).toThrow();
    });
});

describe("configPathFromId error handling", () => {
    it("throws on wrong-kind id", () => {
        expect(() => configPathFromId("file:foo")).toThrow();
    });
});
