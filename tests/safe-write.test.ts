import { describe, it, expect, beforeEach } from "vitest";
import { splitIntoChunks } from "../src/db/chunker.ts";
import type { FileDoc } from "../src/types.ts";

/**
 * Tests for the dbToFile() Safe Write logic.
 *
 * Since dbToFile() depends on Obsidian's App/Vault APIs (not available in
 * unit tests), we test the core comparison logic extracted into pure functions.
 */

async function computeChunkIds(content: string): Promise<string[]> {
    const chunks = await splitIntoChunks(new TextEncoder().encode(content).buffer);
    return chunks.map((c) => c._id);
}

describe("Safe Write — content comparison", () => {
    it("identical content produces identical chunk IDs", async () => {
        const content = "Hello, world!";
        const ids1 = await computeChunkIds(content);
        const ids2 = await computeChunkIds(content);
        expect(ids1).toEqual(ids2);
    });

    it("different content produces different chunk IDs", async () => {
        const ids1 = await computeChunkIds("version A");
        const ids2 = await computeChunkIds("version B");
        expect(ids1).not.toEqual(ids2);
    });

    it("empty content has consistent chunk IDs", async () => {
        const ids1 = await computeChunkIds("");
        const ids2 = await computeChunkIds("");
        expect(ids1).toEqual(ids2);
    });
});

describe("Safe Write — freshness comparison", () => {
    function shouldApplyRemote(localMtime: number, remoteDoc: FileDoc): boolean {
        const remoteEditedAt = remoteDoc.editedAt ?? remoteDoc.mtime;
        return localMtime <= remoteEditedAt;
    }

    it("applies remote when remote editedAt is newer", () => {
        const remoteDoc: FileDoc = {
            _id: "test.md", type: "file", chunks: [], mtime: 1000, ctime: 1000, size: 0,
            editedAt: 2000,
        };
        expect(shouldApplyRemote(1500, remoteDoc)).toBe(true);
    });

    it("skips remote when local mtime is newer than remote editedAt", () => {
        const remoteDoc: FileDoc = {
            _id: "test.md", type: "file", chunks: [], mtime: 1000, ctime: 1000, size: 0,
            editedAt: 1500,
        };
        expect(shouldApplyRemote(2000, remoteDoc)).toBe(false);
    });

    it("falls back to mtime when editedAt is undefined (old doc)", () => {
        const remoteDoc: FileDoc = {
            _id: "test.md", type: "file", chunks: [], mtime: 3000, ctime: 1000, size: 0,
        };
        expect(shouldApplyRemote(2000, remoteDoc)).toBe(true);
    });

    it("falls back to mtime and skips when local is newer (old doc)", () => {
        const remoteDoc: FileDoc = {
            _id: "test.md", type: "file", chunks: [], mtime: 1000, ctime: 1000, size: 0,
        };
        expect(shouldApplyRemote(2000, remoteDoc)).toBe(false);
    });

    it("applies when timestamps are equal", () => {
        const remoteDoc: FileDoc = {
            _id: "test.md", type: "file", chunks: [], mtime: 1000, ctime: 1000, size: 0,
            editedAt: 2000,
        };
        expect(shouldApplyRemote(2000, remoteDoc)).toBe(true);
    });
});
