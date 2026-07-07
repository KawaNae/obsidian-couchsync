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
 * Replicate the take-remote vclock derivation. Kept as a helper so the
 * test can exercise the exact arithmetic without dragging the full
 * orchestrator + LocalDB stack into a unit-shaped test.
 *
 * Post-conflict-loop-fix: non-deletion take-remote adopts remoteDoc.vclock
 * verbatim (Invariant 3: chunks-equal → remote is vclock authority).
 * Deletion conflicts still use mergeVC + incrementVC (Invariant 6).
 */
function deriveTakeRemoteVclock(
    localDoc: FileDoc,
    remoteDoc: FileDoc,
    deviceId: string,
): Record<string, number> {
    const isDeletionConflict = remoteDoc.deleted === true;
    if (isDeletionConflict) {
        return incrementVC(
            mergeVC(localDoc.vclock ?? {}, remoteDoc.vclock ?? {}),
            deviceId,
        );
    }
    return remoteDoc.vclock ?? {};
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

    it("non-deletion concurrent take-remote adopts remote vclock verbatim", async () => {
        // Invariant 3: take-remote adopts remote content → chunks-equal
        // → remote.vclock is the sole authority. No self-component is
        // added — doing so would poison the push churn guard (#sync-005)
        // into skipping the doc forever, causing a permanent conflict loop.
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
            vclock: { "dev-B": 1 },
        };
        const newVclock = deriveTakeRemoteVclock(localDoc, remoteDoc, "dev-self");
        // Remote vclock verbatim — no self-component added.
        expect(newVclock).toEqual({ "dev-B": 1 });
    });

    it("non-deletion take-remote does not cause false concurrent on next remote edit", async () => {
        // After take-remote with verbatim adoption, a subsequent remote
        // edit must be classified as "dominated" (not "concurrent").
        const remoteVC = { "dev-B": 1 };
        const resolvedVC = deriveTakeRemoteVclock(
            { _id: makeFileId("x.md"), type: "file", chunks: ["c:l"], mtime: 0, ctime: 0, size: 1, vclock: { "dev-A": 1 } },
            { _id: makeFileId("x.md"), type: "file", chunks: ["c:r"], mtime: 0, ctime: 0, size: 1, vclock: remoteVC },
            "dev-self",
        );
        // Simulates the next remote edit bumping dev-B.
        const nextRemoteVC = { "dev-B": 2 };
        // The resolved device's doc has resolvedVC = { dev-B: 1 }.
        // The new remote has { dev-B: 2 } which dominates { dev-B: 1 }.
        expect(compareVC(resolvedVC, nextRemoteVC)).toBe("dominated");
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
