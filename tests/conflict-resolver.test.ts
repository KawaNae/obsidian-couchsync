/**
 * Tests for the ConflictResolver — resolveOnPull() API.
 *
 * No PouchDB conflict trees, no getByRev/removeRev.
 * Resolution is a direct two-document vclock comparison via resolveOnPull().
 */

import { describe, it, expect, vi } from "vitest";
import { ConflictResolver } from "../src/conflict/conflict-resolver.ts";
import type { FileDoc } from "../src/types.ts";
import { makeFileId } from "../src/types/doc-id.ts";

function makeFile(path: string, vclock: Record<string, number>, data?: string): FileDoc {
    return {
        _id: makeFileId(path),
        type: "file",
        chunks: [data ?? "chunk:default"],
        mtime: 1000,
        ctime: 1000,
        size: 0,
        vclock,
    };
}

describe("ConflictResolver — resolveOnPull", () => {
    it("returns take-remote when no local doc exists", async () => {
        const resolver = new ConflictResolver();
        const remote = makeFile("new.md", { A: 1 });

        const verdict = await resolver.resolveOnPull(null, remote);
        expect(verdict).toBe("take-remote");
    });

    it("returns take-remote when remote dominates local", async () => {
        const resolver = new ConflictResolver();
        const local = makeFile("doc.md", { A: 1, B: 1 }, "chunk:local");
        const remote = makeFile("doc.md", { A: 2, B: 1 }, "chunk:remote");

        const verdict = await resolver.resolveOnPull(local, remote);
        expect(verdict).toBe("take-remote");
    });

    it("returns take-remote without callback when remote dominates (not a conflict)", async () => {
        const resolver = new ConflictResolver();
        const local = makeFile("doc.md", { A: 1, B: 1 }, "chunk:local");
        const remote = makeFile("doc.md", { A: 2, B: 1 }, "chunk:remote");

        const verdict = await resolver.resolveOnPull(local, remote);

        expect(verdict).toBe("take-remote");
        // No onAutoResolved — dominated is a normal update, not a conflict.
    });

    it("returns keep-local when local dominates remote (chunks differ)", async () => {
        const resolver = new ConflictResolver();
        const local = makeFile("doc.md", { A: 2, B: 1 }, "chunk:local");
        const remote = makeFile("doc.md", { A: 1, B: 1 }, "chunk:remote");

        const verdict = await resolver.resolveOnPull(local, remote);
        expect(verdict).toBe("keep-local");
    });

    it("returns keep-local when local dominates (no side effects, chunks differ)", async () => {
        const resolver = new ConflictResolver();
        const local = makeFile("doc.md", { A: 2 }, "chunk:local");
        const remote = makeFile("doc.md", { A: 1 }, "chunk:remote");

        const verdict = await resolver.resolveOnPull(local, remote);
        expect(verdict).toBe("keep-local");
    });

    it("returns keep-local when vclocks are equal", async () => {
        const resolver = new ConflictResolver();
        const local = makeFile("doc.md", { A: 1, B: 1 });
        const remote = makeFile("doc.md", { A: 1, B: 1 });

        const verdict = await resolver.resolveOnPull(local, remote);
        expect(verdict).toBe("keep-local");
    });

    it("returns concurrent when vclocks are incomparable AND content differs", async () => {
        const resolver = new ConflictResolver();

        const local = makeFile("doc.md", { A: 1, B: 0 }, "chunk:local");
        const remote = makeFile("doc.md", { A: 0, B: 1 }, "chunk:remote");

        const verdict = await resolver.resolveOnPull(local, remote);
        expect(verdict).toBe("concurrent");
    });

    it("returns silent-merge when vclocks are incomparable but content is identical", async () => {
        // False-positive concurrent on initial-sync devices: comparing
        // vclocks alone returned "concurrent" and triggered a modal; the
        // classifier now detects content equality and silently merges the
        // vclocks.
        const resolver = new ConflictResolver();

        const local = makeFile("concurrent.md", { A: 1 }, "shared-chunk");
        const remote = makeFile("concurrent.md", { B: 1 }, "shared-chunk");

        const verdict = await resolver.resolveOnPull(local, remote);
        expect(verdict).toBe("silent-merge");
    });

    it("returns silent-merge when local dominates but content is identical", async () => {
        // Edge case: a re-introduced
        // device with chunks-equal but vclock-divergent post sync.
        const resolver = new ConflictResolver();
        const local = makeFile("doc.md", { A: 5, B: 1 }, "shared-chunk");
        const remote = makeFile("doc.md", { A: 5 }, "shared-chunk");

        const verdict = await resolver.resolveOnPull(local, remote);
        expect(verdict).toBe("silent-merge");
    });

    it("does NOT use mtime as a tiebreaker (chunks differ → concurrent)", async () => {
        const resolver = new ConflictResolver();

        const local = makeFile("tiebreak.md", { A: 1, B: 0 }, "chunk:local");
        local.mtime = 9999; // very new
        const remote = makeFile("tiebreak.md", { A: 0, B: 1 }, "chunk:remote");
        remote.mtime = 1; // very old

        const verdict = await resolver.resolveOnPull(local, remote);
        expect(verdict).toBe("concurrent");
    });

    it("handles missing vclock as empty (chunks differ → take-remote)", async () => {
        const resolver = new ConflictResolver();
        const local = makeFile("no-vc.md", {}, "chunk:local");
        delete (local as any).vclock;
        const remote = makeFile("no-vc.md", { A: 1 }, "chunk:remote");

        // Remote has a vclock, local doesn't, content differs — remote dominates.
        const verdict = await resolver.resolveOnPull(local, remote);
        expect(verdict).toBe("take-remote");
    });

});
