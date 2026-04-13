/**
 * Tests for the Phase 2 ConflictResolver — resolveOnPull() API.
 *
 * Phase 2 simplification: no PouchDB conflict trees, no getByRev/removeRev.
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

describe("ConflictResolver — resolveOnPull (Phase 2)", () => {
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
        const local = makeFile("doc.md", { A: 1, B: 1 });
        const remote = makeFile("doc.md", { A: 2, B: 1 });

        const verdict = await resolver.resolveOnPull(local, remote);

        expect(verdict).toBe("take-remote");
        // No onAutoResolved — dominated is a normal update, not a conflict.
    });

    it("returns keep-local when local dominates remote", async () => {
        const resolver = new ConflictResolver();
        const local = makeFile("doc.md", { A: 2, B: 1 });
        const remote = makeFile("doc.md", { A: 1, B: 1 });

        const verdict = await resolver.resolveOnPull(local, remote);
        expect(verdict).toBe("keep-local");
    });

    it("does NOT fire onAutoResolved when local dominates", async () => {
        const onAuto = vi.fn();
        const resolver = new ConflictResolver(onAuto);
        const local = makeFile("doc.md", { A: 2 });
        const remote = makeFile("doc.md", { A: 1 });

        await resolver.resolveOnPull(local, remote);
        expect(onAuto).not.toHaveBeenCalled();
    });

    it("returns keep-local when vclocks are equal", async () => {
        const resolver = new ConflictResolver();
        const local = makeFile("doc.md", { A: 1, B: 1 });
        const remote = makeFile("doc.md", { A: 1, B: 1 });

        const verdict = await resolver.resolveOnPull(local, remote);
        expect(verdict).toBe("keep-local");
    });

    it("returns concurrent when vclocks are incomparable", async () => {
        const resolver = new ConflictResolver();
        const onConcurrent = vi.fn();
        resolver.setOnConcurrent(onConcurrent);

        const local = makeFile("doc.md", { A: 1, B: 0 }, "chunk:local");
        const remote = makeFile("doc.md", { A: 0, B: 1 }, "chunk:remote");

        const verdict = await resolver.resolveOnPull(local, remote);
        expect(verdict).toBe("concurrent");
    });

    it("fires onConcurrent with path and both revisions", async () => {
        const onConcurrent = vi.fn();
        const resolver = new ConflictResolver();
        resolver.setOnConcurrent(onConcurrent);

        const local = makeFile("concurrent.md", { A: 1 });
        const remote = makeFile("concurrent.md", { B: 1 });

        await resolver.resolveOnPull(local, remote);

        expect(onConcurrent).toHaveBeenCalledTimes(1);
        const [path, revs] = onConcurrent.mock.calls[0];
        expect(path).toBe("concurrent.md");
        expect(revs).toEqual([local, remote]);
    });

    it("returns concurrent even without onConcurrent handler", async () => {
        const resolver = new ConflictResolver();
        const local = makeFile("no-handler.md", { A: 1 });
        const remote = makeFile("no-handler.md", { B: 1 });

        const verdict = await resolver.resolveOnPull(local, remote);
        expect(verdict).toBe("concurrent");
    });

    it("does NOT use mtime as a tiebreaker", async () => {
        const resolver = new ConflictResolver();
        const onConcurrent = vi.fn();
        resolver.setOnConcurrent(onConcurrent);

        const local = makeFile("tiebreak.md", { A: 1, B: 0 });
        local.mtime = 9999; // very new
        const remote = makeFile("tiebreak.md", { A: 0, B: 1 });
        remote.mtime = 1; // very old

        const verdict = await resolver.resolveOnPull(local, remote);
        expect(verdict).toBe("concurrent");
        expect(onConcurrent).toHaveBeenCalled();
    });

    it("handles missing vclock as empty", async () => {
        const resolver = new ConflictResolver();
        const local = makeFile("no-vc.md", {});
        delete (local as any).vclock;
        const remote = makeFile("no-vc.md", { A: 1 });

        // Remote has a vclock, local doesn't — remote dominates.
        const verdict = await resolver.resolveOnPull(local, remote);
        expect(verdict).toBe("take-remote");
    });

});
