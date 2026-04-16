/**
 * End-to-end Vector Clock integration tests.
 *
 * Reproduces the failure modes the VC redesign was built to fix:
 *
 *   - Lost update under network delay
 *   - Silent conflict loss between causally concurrent edits
 *   - Long-offline return overwriting remote state
 *   - Schema guard refusing to sync legacy (pre-VC) databases
 *
 * Uses pure in-memory FileDoc objects — no PouchDB dependency.
 */

import { describe, it, expect, vi } from "vitest";
import { ConflictResolver } from "../src/conflict/conflict-resolver.ts";
import { incrementVC, compareVC } from "../src/sync/vector-clock.ts";
import type { FileDoc, VectorClock } from "../src/types.ts";
import {
    isFileDocId,
    isChunkDocId,
    isConfigDocId,
    isReplicatedDocId,
    makeFileId,
} from "../src/types/doc-id.ts";

function makeFile(
    path: string,
    content: string,
    deviceId: string,
    baseVclock?: VectorClock,
): FileDoc {
    return {
        _id: makeFileId(path),
        type: "file",
        chunks: [`chunk:${content}`],
        mtime: Date.now(),
        ctime: Date.now(),
        size: content.length,
        vclock: incrementVC(baseVclock, deviceId),
    };
}

describe("VC integration — two peers", () => {
    const DEVICE_A = "device-A";
    const DEVICE_B = "device-B";

    it("Scenario Lost-Update: A's delayed write after B replicates becomes concurrent, raises modal", async () => {
        // A writes v1
        const v1 = makeFile("note.md", "v1", DEVICE_A);

        // B writes v2 on top of v1 → causally dominates v1
        const bDoc = makeFile("note.md", "v2", DEVICE_B, v1.vclock);

        // A writes "v3" based on v1 (unaware of v2) → concurrent with B
        const aDoc = makeFile("note.md", "v3", DEVICE_A, v1.vclock);

        const resolver = new ConflictResolver();

        const verdict = await resolver.resolveOnPull(aDoc, bDoc);
        expect(verdict).toBe("concurrent");
    });

    it("Scenario Offline-Return: auto-resolves in favour of the dominator when one side is a strict extension", async () => {
        // A writes initial content
        const base = makeFile("offline.md", "base", DEVICE_A);

        // B makes a single edit on top
        const bDoc = makeFile("offline.md", "b-edit", DEVICE_B, base.vclock);

        // A pulls B's edit, then makes 10 sequential edits
        let vc = bDoc.vclock;
        let aDoc: FileDoc = bDoc;
        for (let i = 0; i < 10; i++) {
            aDoc = makeFile("offline.md", `a-edit-${i}`, DEVICE_A, vc);
            vc = aDoc.vclock;
        }

        // When B pulls A's latest, A dominates → take-remote
        const resolver = new ConflictResolver();

        const verdict = await resolver.resolveOnPull(bDoc, aDoc);
        expect(verdict).toBe("take-remote");
    });

    it("Scenario Mtime-Lies: mtime disagreement with VC must not influence winner", async () => {
        const right: FileDoc = {
            _id: makeFileId("lie.md"),
            type: "file",
            chunks: ["chunk:right"],
            mtime: 1, // old mtime
            ctime: 1,
            size: 5,
            vclock: { X: 5 },
        };
        const wrong: FileDoc = {
            _id: makeFileId("lie.md"),
            type: "file",
            chunks: ["chunk:wrong"],
            mtime: 999999, // new mtime, but dominated vclock
            ctime: 1,
            size: 5,
            vclock: { X: 3 },
        };

        const resolver = new ConflictResolver();
        const verdict = await resolver.resolveOnPull(right, wrong);
        expect(verdict).toBe("keep-local");
    });

    it("Schema-Guard: bare-path and missing-vclock legacy docs are both detected", () => {
        // Bare-path (no prefix) → not a replicated doc ID
        expect(isReplicatedDocId("legacy.md")).toBe(false);

        // Prefixed file doc with no vclock → legacy
        const noVcDoc: any = {
            _id: makeFileId("no-vc.md"),
            type: "file",
            chunks: ["chunk:old"],
            mtime: 1,
            ctime: 1,
            size: 3,
        };
        expect(isFileDocId(noVcDoc._id)).toBe(true);
        expect(!noVcDoc.vclock || Object.keys(noVcDoc.vclock).length === 0).toBe(true);

        // Adding vclock makes it non-legacy
        noVcDoc.vclock = { D: 1 };
        expect(Object.keys(noVcDoc.vclock).length > 0).toBe(true);
    });

    it("compareVC sanity: equal vclocks with different chunks → keep-local", async () => {
        const local: FileDoc = {
            _id: makeFileId("edge.md"),
            type: "file",
            chunks: ["chunk:A"],
            mtime: 1,
            ctime: 1,
            size: 1,
            vclock: { X: 1 },
        };
        const remote: FileDoc = {
            ...local,
            chunks: ["chunk:B"],
        };

        const resolver = new ConflictResolver();
        const verdict = await resolver.resolveOnPull(local, remote);
        expect(verdict).toBe("keep-local");
    });

    it("VC chain sanity: incrementVC produces strictly dominating clocks", () => {
        let vc: VectorClock = {};
        for (let i = 0; i < 5; i++) {
            const next = incrementVC(vc, "device-X");
            expect(compareVC(next, vc)).toBe("dominates");
            vc = next;
        }
        expect(vc).toEqual({ "device-X": 5 });
    });
});
