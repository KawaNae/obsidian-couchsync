/**
 * Regression: PR-D fake-tombstone vclock pollution.
 *
 * Pre-PR-D the `applyConflictChoice` take-remote branch always seeded
 * its `incrementVC` from `remoteDoc.vclock`. For the remote-deleted
 * vs local-edit shape the `remoteDoc` is a **fake tombstone** built by
 * `pull-writer.handlePulledDeletion` with `vclock: {}` — CouchDB's
 * `_changes` doesn't expose deleted-doc bodies, so the pull side
 * cannot recover the deleting device's true vclock. Seeding from `{}`
 * produced a tombstone with vclock `{deviceId: 1}` that did NOT
 * dominate `localDoc.vclock`, so peer devices treated it as concurrent
 * (or out-of-order) and bulkDocs returned 409. Spurious retries, no
 * data loss but rev-tree inflation.
 *
 * Post-PR-D the deletion branch detects `remoteDoc.deleted === true`
 * and seeds from `mergeVC(localDoc.vclock, {}) = localDoc.vclock`.
 * The bumped tombstone strictly dominates `localDoc`, so the deletion
 * propagates cleanly.
 */
import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { incrementVC, mergeVC, compareVC } from "../../src/sync/vector-clock.ts";
import type { FileDoc } from "../../src/types.ts";
import { makeFileId } from "../../src/types/doc-id.ts";

/**
 * Mirror the fake-tombstone construction at
 * `pull-writer.ts:handlePulledDeletion` so the test stays grounded in
 * the actual data shape.
 */
function makeFakeTombstone(localDoc: FileDoc): FileDoc {
    return {
        _id: localDoc._id,
        type: "file",
        chunks: [],
        mtime: localDoc.mtime,
        ctime: localDoc.ctime,
        size: 0,
        deleted: true,
        vclock: {},  // intentional — flag carrier only
    };
}

/**
 * Replicate the PR-D take-remote vclock derivation. Kept as a helper
 * so the test can exercise the exact arithmetic without dragging the
 * full orchestrator + LocalDB stack into a unit-shaped test.
 */
function deriveTakeRemoteVclock(
    localDoc: FileDoc,
    remoteDoc: FileDoc,
    deviceId: string,
): Record<string, number> {
    const isDeletionConflict = remoteDoc.deleted === true;
    const seedVC = isDeletionConflict
        ? mergeVC(localDoc.vclock ?? {}, remoteDoc.vclock ?? {})
        : (remoteDoc.vclock ?? {});
    return incrementVC(seedVC, deviceId);
}

describe("regression: PR-D fake tombstone vclock derivation", () => {
    it("take-remote on a fake tombstone produces a vclock that dominates localDoc", async () => {
        // Local has been edited and pushed a few times; vclock reflects
        // multi-device history.
        const localDoc: FileDoc = {
            _id: makeFileId("notes/contended.md"),
            type: "file",
            chunks: ["chunk:local"],
            mtime: 1000,
            ctime: 1000,
            size: 5,
            vclock: { "dev-A": 5, "dev-B": 3 },
        };
        const tombstone = makeFakeTombstone(localDoc);
        expect(tombstone.vclock).toEqual({});

        const newVclock = deriveTakeRemoteVclock(localDoc, tombstone, "dev-self");

        // Strict domination: every local component is matched, and at
        // least one component (dev-self) is strictly greater.
        expect(compareVC(newVclock, localDoc.vclock)).toBe("dominates");
        // The seed merge preserved local's history.
        expect(newVclock).toEqual({ "dev-A": 5, "dev-B": 3, "dev-self": 1 });
    });

    it("non-deletion concurrent take-remote keeps the legacy remote-seeded vclock", async () => {
        // For real concurrent edits remoteDoc.vclock is the genuine
        // causality from the remote rev; we keep using it as the seed
        // (no behaviour change vs pre-PR-D).
        const localDoc: FileDoc = {
            _id: makeFileId("notes/edit-conflict.md"),
            type: "file",
            chunks: ["chunk:local"],
            mtime: 1000, ctime: 1000, size: 5,
            vclock: { "dev-A": 1 },
        };
        const remoteDoc: FileDoc = {
            ...localDoc,
            chunks: ["chunk:remote"],
            // Real remote rev — concurrent vclock with a non-empty body.
            vclock: { "dev-B": 1 },
        };
        const newVclock = deriveTakeRemoteVclock(localDoc, remoteDoc, "dev-self");
        // Seeded from remote.vclock per legacy behaviour.
        expect(newVclock).toEqual({ "dev-B": 1, "dev-self": 1 });
    });

    it("pre-PR-D shape would NOT dominate localDoc (regression evidence)", async () => {
        // Same inputs as the first case, but using the legacy seeding
        // (remoteDoc.vclock as-is, even if empty). This documents the
        // exact failure mode being fixed: dominated check fails.
        const localDoc: FileDoc = {
            _id: makeFileId("notes/contended.md"),
            type: "file",
            chunks: ["chunk:local"],
            mtime: 1000, ctime: 1000, size: 5,
            vclock: { "dev-A": 5, "dev-B": 3 },
        };
        const tombstone = makeFakeTombstone(localDoc);
        const legacyVclock = incrementVC(tombstone.vclock ?? {}, "dev-self");
        expect(legacyVclock).toEqual({ "dev-self": 1 });
        // Pre-PR-D failure: legacy vclock is concurrent with localDoc,
        // not dominating — peers receiving this rev as a tombstone would
        // treat it as a concurrent change.
        expect(compareVC(legacyVclock, localDoc.vclock)).toBe("concurrent");
    });

    it("derived tombstone propagates cleanly to a third device", async () => {
        // device-C state: knows local rev, hasn't seen the deletion yet.
        const cView: FileDoc = {
            _id: makeFileId("notes/contended.md"),
            type: "file",
            chunks: ["chunk:local"],
            mtime: 1000, ctime: 1000, size: 5,
            vclock: { "dev-A": 5, "dev-B": 3 },
        };
        // device-self resolves the conflict via take-remote (PR-D logic).
        const tombstone = makeFakeTombstone(cView);
        const propagated = deriveTakeRemoteVclock(cView, tombstone, "dev-self");
        // device-C resolver compares its local rev to the propagated rev.
        const relation = compareVC(cView.vclock ?? {}, propagated);
        // Local C dominated by propagated → take-remote (= apply deletion).
        // No 409, no concurrent modal on device C.
        expect(relation).toBe("dominated");
    });
});
