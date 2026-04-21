/**
 * View-model tests for the Chunk Consistency Modal.
 *
 * The Modal itself is a thin renderer; the interesting branching
 * (which sections appear, whether Repair is offered, what the headline
 * says) is decided by `describeChunkConsistencyResult`. Asserting on
 * the descriptor is both DOM-free and stable against cosmetic Modal
 * refactors.
 */

import { describe, it, expect } from "vitest";
import { describeChunkConsistencyResult } from "../src/ui/chunk-consistency-view.ts";
import type {
    ChunkConsistencyReport,
    ChunkConsistencyResult,
    FileDocDivergence,
} from "../src/sync/chunk-consistency.ts";
import { makeFileId, makeChunkId } from "../src/types/doc-id.ts";

function emptyReport(overrides: Partial<ChunkConsistencyReport> = {}): ChunkConsistencyReport {
    return {
        generatedAt: 0,
        localUpdateSeq: 0,
        remoteUpdateSeq: 0,
        snapshotChanged: false,
        counts: {
            localChunks: 0,
            remoteChunks: 0,
            referencedIds: 0,
            localOnly: 0,
            remoteOnly: 0,
            missingReferenced: 0,
            orphanLocal: 0,
            orphanRemote: 0,
        },
        localOnly: [],
        remoteOnly: [],
        missingReferenced: [],
        orphanLocal: [],
        orphanRemote: [],
        ...overrides,
    };
}

describe("describeChunkConsistencyResult — converged", () => {
    it("no issues: headline shows totals, no sections, plan total 0", () => {
        const result: ChunkConsistencyResult = {
            state: "converged",
            report: emptyReport({
                counts: {
                    localChunks: 10,
                    remoteChunks: 10,
                    referencedIds: 5,
                    localOnly: 0,
                    remoteOnly: 0,
                    missingReferenced: 0,
                    orphanLocal: 0,
                    orphanRemote: 0,
                },
            }),
        };
        const view = describeChunkConsistencyResult(result);
        expect(view.state).toBe("converged");
        if (view.state !== "converged") return;
        expect(view.hasIssues).toBe(false);
        expect(view.planTotal).toBe(0);
        expect(view.planBullets).toEqual([]);
        expect(view.sections).toEqual([]);
        expect(view.headline).toContain("10 chunk(s) local");
    });

    it("localOnly + remoteOnly populate plan push/pull bullets", () => {
        const c1 = makeChunkId("aa");
        const c2 = makeChunkId("bb");
        const result: ChunkConsistencyResult = {
            state: "converged",
            report: emptyReport({
                counts: {
                    localChunks: 1,
                    remoteChunks: 1,
                    referencedIds: 2,
                    localOnly: 1,
                    remoteOnly: 1,
                    missingReferenced: 0,
                    orphanLocal: 0,
                    orphanRemote: 0,
                },
                localOnly: [c1],
                remoteOnly: [c2],
            }),
        };
        const view = describeChunkConsistencyResult(result);
        if (view.state !== "converged") throw new Error("expected converged");
        expect(view.hasIssues).toBe(true);
        expect(view.plan.toPush).toEqual([c1]);
        expect(view.plan.toPull).toEqual([c2]);
        expect(view.planTotal).toBe(2);
        expect(view.planBullets).toEqual([
            "push 1 → remote",
            "pull 1 ← remote",
        ]);
    });

    it("orphan buckets produce delete bullets", () => {
        const lo = makeChunkId("lo");
        const ro = makeChunkId("ro");
        const result: ChunkConsistencyResult = {
            state: "converged",
            report: emptyReport({
                counts: {
                    localChunks: 1,
                    remoteChunks: 1,
                    referencedIds: 0,
                    localOnly: 1,
                    remoteOnly: 1,
                    missingReferenced: 0,
                    orphanLocal: 1,
                    orphanRemote: 1,
                },
                localOnly: [lo],
                remoteOnly: [ro],
                orphanLocal: [lo],
                orphanRemote: [ro],
            }),
        };
        const view = describeChunkConsistencyResult(result);
        if (view.state !== "converged") throw new Error("expected converged");
        expect(view.plan.toDeleteLocal).toEqual([lo]);
        expect(view.plan.toDeleteRemote).toEqual([ro]);
        expect(view.planBullets).toContain(
            "delete 1 local (one-sided orphan)",
        );
        expect(view.planBullets).toContain(
            "delete 1 remote (one-sided orphan, tombstone)",
        );
    });

    it("missingReferenced formats lines with referencing paths", () => {
        const g = makeChunkId("ghost");
        const result: ChunkConsistencyResult = {
            state: "converged",
            report: emptyReport({
                counts: {
                    localChunks: 0,
                    remoteChunks: 0,
                    referencedIds: 1,
                    localOnly: 0,
                    remoteOnly: 0,
                    missingReferenced: 1,
                    orphanLocal: 0,
                    orphanRemote: 0,
                },
                missingReferenced: [{ id: g, referencedBy: ["broken.md"] }],
            }),
        };
        const view = describeChunkConsistencyResult(result);
        if (view.state !== "converged") throw new Error("expected converged");
        const missingSec = view.sections.find((s) =>
            s.title.startsWith("Missing referenced"),
        );
        expect(missingSec?.lines[0]).toBe(`${g} — referenced by broken.md`);
    });
});

describe("describeChunkConsistencyResult — needs-convergence", () => {
    function mkDivergence(
        overrides: Partial<FileDocDivergence> = {},
    ): FileDocDivergence {
        return {
            localOnly: [],
            remoteOnly: [],
            differing: [],
            ...overrides,
        };
    }

    it("no divergence yields zero totals (defensive; analyser should not return this)", () => {
        const result: ChunkConsistencyResult = {
            state: "needs-convergence",
            divergence: mkDivergence(),
        };
        const view = describeChunkConsistencyResult(result);
        if (view.state !== "needs-convergence") throw new Error("expected needs-convergence");
        expect(view.total).toBe(0);
        expect(view.sections).toEqual([]);
    });

    it("localOnly / remoteOnly / differing each become their own section with paths", () => {
        const localOnlyId = makeFileId("a.md");
        const remoteOnlyId = makeFileId("b.md");
        const diffId = makeFileId("c.md");
        const result: ChunkConsistencyResult = {
            state: "needs-convergence",
            divergence: mkDivergence({
                localOnly: [localOnlyId],
                remoteOnly: [remoteOnlyId],
                differing: [
                    {
                        id: diffId,
                        localVC: { A: 1 },
                        remoteVC: { A: 2 },
                        relation: "dominated",
                    },
                ],
            }),
        };
        const view = describeChunkConsistencyResult(result);
        if (view.state !== "needs-convergence") throw new Error("expected needs-convergence");
        expect(view.total).toBe(3);
        const pushSec = view.sections.find((s) => s.title.includes("Pending push"));
        const pullSec = view.sections.find((s) => s.title.includes("Pending pull"));
        const diffSec = view.sections.find((s) => s.title.includes("Differing"));
        expect(pushSec?.lines).toEqual(["a.md"]);
        expect(pullSec?.lines).toEqual(["b.md"]);
        expect(diffSec?.lines).toEqual(["c.md — dominated"]);
    });

    it("headline summarises all three divergence counts", () => {
        const result: ChunkConsistencyResult = {
            state: "needs-convergence",
            divergence: mkDivergence({
                localOnly: [makeFileId("a.md"), makeFileId("b.md")],
                remoteOnly: [makeFileId("c.md")],
                differing: [
                    {
                        id: makeFileId("d.md"),
                        localVC: { A: 1, B: 1 },
                        remoteVC: { A: 2, B: 0 },
                        relation: "concurrent",
                    },
                ],
            }),
        };
        const view = describeChunkConsistencyResult(result);
        if (view.state !== "needs-convergence") throw new Error("expected needs-convergence");
        expect(view.headline).toContain("2 pending push");
        expect(view.headline).toContain("1 pending pull");
        expect(view.headline).toContain("1 differing");
    });
});
