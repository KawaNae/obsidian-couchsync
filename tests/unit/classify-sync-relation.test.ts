/**
 * Matrix tests for `classifySyncRelation` — the single sync-state
 * classifier that PR3/PR4 wire up to all four legacy classification
 * sites.
 */

import { describe, it, expect } from "vitest";
import { classifySyncRelation } from "../../src/sync/classify-sync-relation.ts";
import type { ClassifyInput } from "../../src/sync/classify-sync-relation.ts";
import type { LastSynced } from "../../src/sync/last-synced.ts";

// Helpers for terse fixtures.
const C = (...ids: string[]) => ids;
const VC = (vc: Record<string, number>) => ({ ...vc });

function input(partial: Partial<ClassifyInput>): ClassifyInput {
    // Defaults: identical inputs both sides, no baseline.
    return {
        leftVC: VC({}),
        leftChunks: C("a"),
        leftSize: 10,
        rightVC: VC({}),
        rightChunks: C("a"),
        rightSize: 10,
        ...partial,
    };
}

describe("classifySyncRelation", () => {
    // ── identical ───────────────────────────────────────────
    describe("identical", () => {
        it("chunks equal + vclock equal → identical", () => {
            expect(classifySyncRelation(input({}))).toBe("identical");
        });

        it("empty vclock both sides + chunks equal → identical", () => {
            expect(classifySyncRelation(input({
                leftVC: VC({}),
                rightVC: VC({}),
            }))).toBe("identical");
        });

        it("matching multi-device vclocks + matching chunks → identical", () => {
            expect(classifySyncRelation(input({
                leftVC: VC({ a: 5, b: 3 }),
                rightVC: VC({ a: 5, b: 3 }),
                leftChunks: C("c1", "c2"),
                rightChunks: C("c1", "c2"),
                leftSize: 100,
                rightSize: 100,
            }))).toBe("identical");
        });
    });

    // ── vclock-only-drift (silent merge candidate) ─────────
    describe("vclock-only-drift", () => {
        it("chunks equal but vclock concurrent → vclock-only-drift", () => {
            expect(classifySyncRelation(input({
                leftVC: VC({ a: 1 }),
                rightVC: VC({ b: 1 }),
            }))).toBe("vclock-only-drift");
        });

        it("chunks equal, left dominates → vclock-only-drift", () => {
            expect(classifySyncRelation(input({
                leftVC: VC({ a: 2 }),
                rightVC: VC({ a: 1 }),
            }))).toBe("vclock-only-drift");
        });

        it("chunks equal, right dominates → vclock-only-drift", () => {
            expect(classifySyncRelation(input({
                leftVC: VC({ a: 1 }),
                rightVC: VC({ a: 2 }),
            }))).toBe("vclock-only-drift");
        });

        it("Pixel7a-style initial-sync false-positive resolves to vclock-only-drift", () => {
            // From project_false_positive_concurrent.md: device pushed under
            // its own deviceId but content identical to remote.
            expect(classifySyncRelation(input({
                leftVC: VC({ "melchior-main": 72, "ipadpro11gen4-main": 11 }),
                rightVC: VC({ "melchior-main": 72, "ipadpro11gen4-main": 11, "pixel7a-main": 1 }),
                leftChunks: C("hash"),
                rightChunks: C("hash"),
                leftSize: 200,
                rightSize: 200,
            }))).toBe("vclock-only-drift");
        });
    });

    // ── true-divergent ────────────────────────────────────
    describe("true-divergent", () => {
        it("chunks differ + vclock concurrent → true-divergent", () => {
            expect(classifySyncRelation(input({
                leftVC: VC({ a: 1 }),
                rightVC: VC({ b: 1 }),
                leftChunks: C("L"),
                rightChunks: C("R"),
                leftSize: 5,
                rightSize: 5,
            }))).toBe("true-divergent");
        });

        it("chunks differ + right dominates + left drifted from baseline → true-divergent", () => {
            const lastSynced: LastSynced = {
                vclock: VC({ a: 1 }),
                chunks: ["base"],
                size: 4,
            };
            expect(classifySyncRelation(input({
                leftVC: VC({ a: 1 }),
                rightVC: VC({ a: 2 }),
                leftChunks: C("local-edit"),  // user edited stale
                leftSize: 11,
                rightChunks: C("remote-edit"),
                rightSize: 11,
                lastSynced,
            }))).toBe("true-divergent");
        });
    });

    // ── remote-edit ───────────────────────────────────────
    describe("remote-edit", () => {
        it("chunks differ + right dominates + no baseline → remote-edit", () => {
            expect(classifySyncRelation(input({
                leftVC: VC({ a: 1 }),
                rightVC: VC({ a: 2 }),
                leftChunks: C("old"),
                rightChunks: C("new"),
                leftSize: 3,
                rightSize: 3,
            }))).toBe("remote-edit");
        });

        it("chunks differ + right dominates + left matches baseline → remote-edit", () => {
            const lastSynced: LastSynced = {
                vclock: VC({ a: 1 }),
                chunks: ["base"],
                size: 4,
            };
            expect(classifySyncRelation(input({
                leftVC: VC({ a: 1 }),
                rightVC: VC({ a: 2 }),
                leftChunks: C("base"),
                leftSize: 4,
                rightChunks: C("new"),
                rightSize: 3,
                lastSynced,
            }))).toBe("remote-edit");
        });
    });

    // ── local-edit ────────────────────────────────────────
    describe("local-edit", () => {
        it("chunks differ + vclock equal → local-edit", () => {
            expect(classifySyncRelation(input({
                leftVC: VC({ a: 1 }),
                rightVC: VC({ a: 1 }),
                leftChunks: C("user-edit"),
                rightChunks: C("old"),
                leftSize: 9,
                rightSize: 3,
            }))).toBe("local-edit");
        });

        it("chunks differ + left dominates → local-edit", () => {
            expect(classifySyncRelation(input({
                leftVC: VC({ a: 2 }),
                rightVC: VC({ a: 1 }),
                leftChunks: C("user-edit"),
                rightChunks: C("old"),
                leftSize: 9,
                rightSize: 3,
            }))).toBe("local-edit");
        });

        it("chunks differ + vclock equal + left matches baseline → still local-edit", () => {
            // Edge case: user edit hasn't been pushed yet. Baseline matches
            // disk because lastSynced was set at the same content.
            const lastSynced: LastSynced = {
                vclock: VC({ a: 1 }),
                chunks: ["user-edit"],
                size: 9,
            };
            expect(classifySyncRelation(input({
                leftVC: VC({ a: 1 }),
                rightVC: VC({ a: 1 }),
                leftChunks: C("user-edit"),
                rightChunks: C("old"),
                leftSize: 9,
                rightSize: 3,
                lastSynced,
            }))).toBe("local-edit");
        });
    });

    // ── legacy-skip ───────────────────────────────────────
    describe("legacy-skip", () => {
        it("right dominates + lastSynced.chunks undefined → legacy-skip", () => {
            const lastSynced: LastSynced = { vclock: VC({ a: 1 }) };
            expect(classifySyncRelation(input({
                leftVC: VC({ a: 1 }),
                rightVC: VC({ a: 2 }),
                leftChunks: C("L"),
                rightChunks: C("R"),
                leftSize: 1,
                rightSize: 1,
                lastSynced,
            }))).toBe("legacy-skip");
        });

        it("right dominates + lastSynced.size undefined → legacy-skip", () => {
            const lastSynced: LastSynced = {
                vclock: VC({ a: 1 }),
                chunks: ["base"],
                // size missing
            };
            expect(classifySyncRelation(input({
                leftVC: VC({ a: 1 }),
                rightVC: VC({ a: 2 }),
                leftChunks: C("L"),
                rightChunks: C("R"),
                leftSize: 1,
                rightSize: 1,
                lastSynced,
            }))).toBe("legacy-skip");
        });

        it("legacy lastSynced does NOT affect identical / vclock-only-drift / local-edit", () => {
            const lastSynced: LastSynced = { vclock: VC({}) };
            // identical
            expect(classifySyncRelation(input({ lastSynced }))).toBe("identical");
            // vclock-only-drift
            expect(classifySyncRelation(input({
                leftVC: VC({ a: 1 }),
                rightVC: VC({ b: 1 }),
                lastSynced,
            }))).toBe("vclock-only-drift");
            // local-edit (vcRel "equal", no baseline check needed)
            expect(classifySyncRelation(input({
                leftChunks: C("L"),
                rightChunks: C("R"),
                lastSynced,
            }))).toBe("local-edit");
        });
    });

    // ── Today's Home.md repro shape ───────────────────────
    describe("regression: 2026-05-10 Home.md silent loss shape", () => {
        // After a successful PR1 dbToFile, lastSynced.vclock and FileDoc.vclock
        // both equal `{melchior:12, fake-desktop:1}`. With PR1, disk is also
        // the new content. classifier returns identical. With PR1 broken
        // (= the bug), disk is OLD; classifier sees:
        // - leftVC = lastSynced.vclock = {melchior:12, fake-desktop:1}
        // - rightVC = fileDoc.vclock = same
        // - leftChunks = OLD (disk), rightChunks = NEW (fileDoc)
        // - lastSynced.chunks = NEW (lying baseline)
        //
        // classifier returns "local-edit" because vclock equal + chunks differ.
        // This means PR3 will route to push (which is what was happening) —
        // but PR1 prevents the lie in the first place. PR5 adds defense in
        // depth by detecting this shape and recovering.
        it("PR1-broken state classifies as local-edit (push will happen but PR1 prevents the disk-stale state)", () => {
            const baseVC = VC({ "melchior-main": 12, "fake-desktop": 1 });
            const lastSynced: LastSynced = {
                vclock: { ...baseVC },
                chunks: ["NEW-chunk"],  // lying — disk actually has OLD
                size: 77,
            };
            expect(classifySyncRelation(input({
                leftVC: { ...baseVC },
                rightVC: { ...baseVC },
                leftChunks: C("OLD-chunk"),
                leftSize: 24,
                rightChunks: C("NEW-chunk"),
                rightSize: 77,
                lastSynced,
            }))).toBe("local-edit");
        });

        it("with PR1 working, post-pull state classifies as identical", () => {
            const baseVC = VC({ "melchior-main": 12, "fake-desktop": 1 });
            const lastSynced: LastSynced = {
                vclock: { ...baseVC },
                chunks: ["NEW-chunk"],
                size: 77,
            };
            // PR1 invariant: disk == content, so leftChunks reflects NEW.
            expect(classifySyncRelation(input({
                leftVC: { ...baseVC },
                rightVC: { ...baseVC },
                leftChunks: C("NEW-chunk"),
                leftSize: 77,
                rightChunks: C("NEW-chunk"),
                rightSize: 77,
                lastSynced,
            }))).toBe("identical");
        });
    });
});
