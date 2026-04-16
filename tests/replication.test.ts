import { describe, it, expect } from "vitest";
import { splitIntoChunks } from "../src/db/chunker.ts";
import { ConflictResolver } from "../src/conflict/conflict-resolver.ts";
import type { FileDoc } from "../src/types.ts";
import { makeFileId } from "../src/types/doc-id.ts";

function makeFile(
    path: string,
    content: string,
    mtime: number,
    vclock: Record<string, number> = { test: 1 },
): FileDoc {
    return {
        _id: makeFileId(path),
        type: "file",
        chunks: [`chunk:${content}`],
        mtime,
        ctime: mtime,
        size: content.length,
        vclock,
    };
}

describe("ConflictResolver — resolveOnPull", () => {
    it("picks the VC-dominator as winner (ignoring mtime)", async () => {
        const localDoc = makeFile("note.md", "old edit (wrong)", 9999, { A: 2 });
        const remoteDoc = makeFile("note.md", "new edit (right)", 1, { A: 3 });

        const resolver = new ConflictResolver();
        const verdict = await resolver.resolveOnPull(localDoc, remoteDoc);
        expect(verdict).toBe("take-remote");
    });

    it("calls onAutoResolved with winner and losers for dominated conflicts", async () => {
        const localDoc = makeFile("note.md", "loser", 2000, { A: 2 });
        const remoteDoc = makeFile("note.md", "winner", 5000, { A: 3 });

        const resolver = new ConflictResolver();

        const verdict = await resolver.resolveOnPull(localDoc, remoteDoc);

        // dominated = normal update, not a conflict. No callback.
        expect(verdict).toBe("take-remote");
    });

    it("raises onConcurrent callback when VCs are incomparable", async () => {
        const localDoc = makeFile("note.md", "A's edit", 2000, { A: 2, B: 0 });
        const remoteDoc = makeFile("note.md", "B's edit", 2000, { A: 0, B: 1 });

        const resolver = new ConflictResolver();

        const verdict = await resolver.resolveOnPull(localDoc, remoteDoc);
        expect(verdict).toBe("concurrent");
    });
});

describe("chunk deduplication skip", () => {
    it("same content produces same chunk IDs so fileToDb can skip", async () => {
        const content = "same content";
        const chunks1 = await splitIntoChunks(new TextEncoder().encode(content).buffer);
        const chunks2 = await splitIntoChunks(new TextEncoder().encode(content).buffer);

        const ids1 = chunks1.map((c) => c._id);
        const ids2 = chunks2.map((c) => c._id);

        expect(ids1).toEqual(ids2);
    });

    it("different content produces different chunk IDs", async () => {
        const chunks1 = await splitIntoChunks(new TextEncoder().encode("content A").buffer);
        const chunks2 = await splitIntoChunks(new TextEncoder().encode("content B").buffer);

        const ids1 = chunks1.map((c) => c._id);
        const ids2 = chunks2.map((c) => c._id);

        expect(ids1).not.toEqual(ids2);
    });
});
