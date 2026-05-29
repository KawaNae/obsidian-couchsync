import { describe, it, expect } from "vitest";
import {
    PENDING_APPLY_KEY_PREFIX,
    loadAllPendingApply,
    pendingApplyIdFromKey,
    pendingApplyKey,
    type PendingApplyEntry,
} from "../src/db/sync/pending-apply.ts";

function makeReader(rows: Array<{ key: string; value: unknown }>) {
    return {
        getMetaByPrefix: async (prefix: string) =>
            rows.filter((r) => r.key.startsWith(prefix)),
    };
}

describe("pending-apply helpers", () => {
    it("pendingApplyKey / pendingApplyIdFromKey are round-trip", () => {
        const id = "file:notes/foo.md";
        const k = pendingApplyKey(id);
        expect(k).toBe(PENDING_APPLY_KEY_PREFIX + id);
        expect(pendingApplyIdFromKey(k)).toBe(id);
    });

    it("pendingApplyIdFromKey rejects keys outside the namespace", () => {
        expect(pendingApplyIdFromKey("_sync/remote-seq")).toBeNull();
        expect(pendingApplyIdFromKey("_sync/unpushed/file:a.md")).toBeNull();
    });

    it("loadAllPendingApply returns rows with parsed entries", async () => {
        const entry1: PendingApplyEntry = { addedAt: 100, reason: "missing-chunks", attempts: 1 };
        const entry2: PendingApplyEntry = { addedAt: 200, reason: "missing-chunks", attempts: 0 };
        const reader = makeReader([
            { key: pendingApplyKey("file:a.md"), value: entry1 },
            { key: pendingApplyKey("file:b.md"), value: entry2 },
            { key: "_sync/remote-seq", value: 99 },
        ]);
        const rows = await loadAllPendingApply(reader);
        expect(rows).toEqual([
            { id: "file:a.md", entry: entry1 },
            { id: "file:b.md", entry: entry2 },
        ]);
    });

    it("loadAllPendingApply drops malformed entries silently", async () => {
        const good: PendingApplyEntry = { addedAt: 1, reason: "missing-chunks", attempts: 0 };
        const reader = makeReader([
            { key: pendingApplyKey("file:good.md"), value: good },
            { key: pendingApplyKey("file:bad-reason.md"), value: { reason: "bogus" } },
            { key: pendingApplyKey("file:null.md"), value: null },
            { key: pendingApplyKey("file:string.md"), value: "not-an-entry" },
        ]);
        const rows = await loadAllPendingApply(reader);
        expect(rows.map((r) => r.id)).toEqual(["file:good.md"]);
    });

    it("loadAllPendingApply defaults missing numeric fields to 0", async () => {
        const reader = makeReader([
            { key: pendingApplyKey("file:partial.md"), value: { reason: "missing-chunks" } },
        ]);
        const rows = await loadAllPendingApply(reader);
        expect(rows[0]?.entry).toEqual({ reason: "missing-chunks", addedAt: 0, attempts: 0 });
    });
});
