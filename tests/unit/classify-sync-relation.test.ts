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
        it("chunks differ + vclock equal + vault-disk (attributed) → local-edit", () => {
            // Vault-disk call site: leftVC is the attributed lastSynced.vclock,
            // not the disk content's own clock, so an equal clock with edited
            // content is the steady-state "disk edited, vclock not yet bumped".
            expect(classifySyncRelation(input({
                leftVC: VC({ a: 1 }),
                rightVC: VC({ a: 1 }),
                leftChunks: C("user-edit"),
                rightChunks: C("old"),
                leftSize: 9,
                rightSize: 3,
                leftVCAttributed: true,
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

        it("chunks differ + vclock equal + left matches baseline → still local-edit (vault-disk)", () => {
            // Edge case: user edit hasn't been pushed yet. Baseline matches
            // disk because lastSynced was set at the same content. Vault-disk
            // call site (attributed vclock).
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
                leftVCAttributed: true,
            }))).toBe("local-edit");
        });
    });

    // ── true-divergent (pull-site vclock tie) ──────────────
    // A PULL call site compares two REAL doc vclocks (leftVCAttributed falsy).
    // An equal vclock with differing content cannot come from a legit local
    // edit (that bumps the clock) — it is the Config-Init stale-collision
    // anomaly (zombie {device:1} vs a freshly-reset {device:1}). It must be
    // surfaced, not silently kept (the 2026-06-14 non-propagation bug).
    describe("true-divergent (pull-site vclock tie)", () => {
        it("chunks differ + vclock equal + pull-site (not attributed) → true-divergent", () => {
            expect(classifySyncRelation(input({
                leftVC: VC({ a: 1 }),
                rightVC: VC({ a: 1 }),
                leftChunks: C("zombie"),
                rightChunks: C("fresh-build"),
                leftSize: 6,
                rightSize: 11,
            }))).toBe("true-divergent");
        });

        it("chunks EQUAL + vclock equal + pull-site → identical (fast-path regression guard)", () => {
            expect(classifySyncRelation(input({
                leftVC: VC({ a: 1 }),
                rightVC: VC({ a: 1 }),
                leftChunks: C("same"),
                rightChunks: C("same"),
                leftSize: 4,
                rightSize: 4,
            }))).toBe("identical");
        });

        it("chunks differ + left dominates + pull-site → local-edit (do NOT over-broaden)", () => {
            // Only the equal TIE is anomalous; a real dominates is a legit
            // local-newer state and must stay local-edit/keep-local.
            expect(classifySyncRelation(input({
                leftVC: VC({ a: 2 }),
                rightVC: VC({ a: 1 }),
                leftChunks: C("local-newer"),
                rightChunks: C("old"),
                leftSize: 11,
                rightSize: 3,
            }))).toBe("local-edit");
        });

        it("equal tie + recreateAuthority (Init re-pull) → remote-edit (adopt fresh authority)", () => {
            // During a config seq-regression re-pull the remote was recreated
            // by an Init elsewhere; chunk ids rotate with the new key, so the
            // tie is adopted from remote rather than surfaced. This is the fix
            // for both the non-propagation bug and the key-rotation flood.
            expect(classifySyncRelation(input({
                leftVC: VC({ a: 1 }),
                rightVC: VC({ a: 1 }),
                leftChunks: C("old-key-id"),
                rightChunks: C("new-key-id"),
                leftSize: 6,
                rightSize: 6,
                recreateAuthority: true,
            }))).toBe("remote-edit");
        });

        it("equal tie + recreateAuthority but vault-disk (attributed) → still local-edit", () => {
            // recreateAuthority is a pull-site signal; it must not override the
            // vault-disk edit-pending case (attributed clock).
            expect(classifySyncRelation(input({
                leftVC: VC({ a: 1 }),
                rightVC: VC({ a: 1 }),
                leftChunks: C("disk-edit"),
                rightChunks: C("doc"),
                leftSize: 9,
                rightSize: 3,
                leftVCAttributed: true,
                recreateAuthority: true,
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
            // local-edit (vcRel "equal", no baseline check needed) — vault-disk
            // call site (attributed); pull-site equal+differ is true-divergent.
            expect(classifySyncRelation(input({
                leftChunks: C("L"),
                rightChunks: C("R"),
                lastSynced,
                leftVCAttributed: true,
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
                // Vault-disk classify (compareFileToDoc): leftVC is the
                // attributed lastSynced.vclock, so equal+differ = disk edit
                // pending, → local-edit. (A pull-site tie would be true-divergent.)
                leftVCAttributed: true,
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

    // ── Invariant 7: the deleted axis ───────────────────────
    // A tombstone's fingerprint is NOT normalized (markDeleted retains the
    // deleted content's chunks), so the deleted flag — not the chunks —
    // carries the deleted state.
    describe("deleted axis (Invariant 7)", () => {
        // The wild tombstone shape: retains the chunks it deleted.
        const tomb = { rightDeleted: true, rightChunks: C("a"), rightSize: 10 };

        it("deleted×deleted with differing retained chunks → identical (not conflict)", () => {
            // Local markDeleted-tombstone (chunks retained) vs pulled
            // buildAcceptedTombstone (chunks []) — same deletion state.
            expect(classifySyncRelation(input({
                leftDeleted: true, leftChunks: C("a"), leftSize: 10,
                rightDeleted: true, rightChunks: C(), rightSize: 0,
                leftVC: VC({ a: 2 }), rightVC: VC({ a: 2 }),
            }))).toBe("identical");
        });

        it("deleted×deleted with vclock drift → vclock-only-drift (concurrent deletions converge)", () => {
            expect(classifySyncRelation(input({
                leftDeleted: true, leftChunks: C("a"), leftSize: 10,
                rightDeleted: true, rightChunks: C(), rightSize: 0,
                leftVC: VC({ a: 2 }), rightVC: VC({ b: 2 }),
            }))).toBe("vclock-only-drift");
        });

        it("alive×deleted with identical chunks is NOT content-equal (no silent resurrect)", () => {
            // Local tombstone vs remote alive doc sharing the retained
            // chunks: must fall through to vclock comparison, never
            // vclock-only-drift → silent-merge.
            expect(classifySyncRelation(input({
                leftDeleted: true, leftChunks: C("a"), leftSize: 10,
                leftVC: VC({ a: 1 }),
                rightChunks: C("a"), rightSize: 10,
                rightVC: VC({ a: 1, b: 1 }),
            }))).toBe("remote-edit"); // legitimate resurrection (pull site, real vclocks)
        });

        it("recreate over integrated deletion → local-edit (the normal recreate push)", () => {
            // Vault file over a tombstone whose deletion we integrated:
            // deleted baseline vclock equals the tombstone vclock.
            expect(classifySyncRelation(input({
                ...tomb,
                leftVCAttributed: true,
                leftVC: VC({ m: 2 }), rightVC: VC({ m: 2 }),
                leftChunks: C("new"), leftSize: 20,
                lastSynced: { vclock: VC({ m: 2 }), chunks: [], size: 0, deleted: true },
            }))).toBe("local-edit");
        });

        it("W24 shape: file over tombstone, NO baseline → true-divergent (was remote-edit = wedged)", () => {
            expect(classifySyncRelation(input({
                ...tomb,
                leftVCAttributed: true,
                leftVC: VC({}), rightVC: VC({ m: 2 }),
                leftChunks: C("new"), leftSize: 20,
            }))).toBe("true-divergent");
        });

        it("file over tombstone, legacy baseline → true-divergent (safe side)", () => {
            expect(classifySyncRelation(input({
                ...tomb,
                leftVCAttributed: true,
                leftVC: VC({ m: 1 }), rightVC: VC({ m: 2 }),
                leftChunks: C("new"), leftSize: 20,
                lastSynced: { vclock: VC({ m: 1 }) }, // no chunks/size
            }))).toBe("true-divergent");
        });

        it("file over tombstone dominating the deleted baseline → true-divergent (re-delete raced recreate)", () => {
            expect(classifySyncRelation(input({
                ...tomb,
                leftVCAttributed: true,
                rightVC: VC({ m: 2, i: 1 }),
                leftVC: VC({ m: 2 }),
                leftChunks: C("new"), leftSize: 20,
                lastSynced: { vclock: VC({ m: 2 }), chunks: [], size: 0, deleted: true },
            }))).toBe("true-divergent");
        });

        it("untouched file under a dominating tombstone → remote-edit (deletion pending disk apply)", () => {
            expect(classifySyncRelation(input({
                ...tomb,
                leftVCAttributed: true,
                leftVC: VC({ m: 1 }), rightVC: VC({ m: 2 }),
                leftChunks: C("a"), leftSize: 10,
                lastSynced: { vclock: VC({ m: 1 }), chunks: C("a"), size: 10 },
            }))).toBe("remote-edit");
        });

        it("edited file under a dominating tombstone → true-divergent (delete-vs-edit)", () => {
            expect(classifySyncRelation(input({
                ...tomb,
                leftVCAttributed: true,
                leftVC: VC({ m: 1 }), rightVC: VC({ m: 2 }),
                leftChunks: C("edited"), leftSize: 30,
                lastSynced: { vclock: VC({ m: 1 }), chunks: C("a"), size: 10 },
            }))).toBe("true-divergent");
        });

        it("pull site (no attributed vclock): alive doc dominated by tombstone → remote-edit", () => {
            // resolveOnPull compares two real doc vclocks; a dominating
            // tombstone is a legitimate deletion to take, baseline or not.
            expect(classifySyncRelation(input({
                rightDeleted: true, rightChunks: C(), rightSize: 0,
                leftVC: VC({ a: 1 }), rightVC: VC({ a: 2 }),
                leftChunks: C("c"), leftSize: 10,
            }))).toBe("remote-edit");
        });

        it("pull site: alive doc concurrent with tombstone → true-divergent (delete-vs-edit modal)", () => {
            expect(classifySyncRelation(input({
                rightDeleted: true, rightChunks: C(), rightSize: 0,
                leftVC: VC({ a: 1 }), rightVC: VC({ b: 2 }),
                leftChunks: C("c"), leftSize: 10,
            }))).toBe("true-divergent");
        });

        it("alive×alive matrix is untouched by the deleted axis defaults", () => {
            // Omitting leftDeleted/rightDeleted/leftVCAttributed preserves
            // the legacy chunks-only semantics.
            expect(classifySyncRelation(input({
                leftVC: VC({ a: 1 }), rightVC: VC({ a: 2 }),
                leftChunks: C("old"), rightChunks: C("new"),
            }))).toBe("remote-edit");
        });
    });
});
