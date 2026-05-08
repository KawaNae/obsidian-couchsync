import { describe, it, expect } from "vitest";
import {
    UNPUSHED_KEY_PREFIX,
    loadAllUnpushed,
    unpushedIdFromKey,
    unpushedKey,
    type UnpushedEntry,
} from "../src/db/sync/unpushed-ids.ts";

function makeReader(rows: Array<{ key: string; value: unknown }>) {
    return {
        getMetaByPrefix: async (prefix: string) =>
            rows.filter((r) => r.key.startsWith(prefix)),
    };
}

describe("unpushed-ids helpers", () => {
    it("unpushedKey / unpushedIdFromKey are round-trip", () => {
        const id = "file:notes/foo.md";
        const k = unpushedKey(id);
        expect(k).toBe(UNPUSHED_KEY_PREFIX + id);
        expect(unpushedIdFromKey(k)).toBe(id);
    });

    it("unpushedIdFromKey rejects keys outside the namespace", () => {
        expect(unpushedIdFromKey("_sync/push-seq")).toBeNull();
        expect(unpushedIdFromKey("_local/vclock/foo")).toBeNull();
    });

    it("loadAllUnpushed returns rows with parsed entries", async () => {
        const entry1: UnpushedEntry = { addedAt: 100, reason: "race-stale", attempts: 1 };
        const entry2: UnpushedEntry = { addedAt: 200, reason: "divergent", attempts: 0 };
        const reader = makeReader([
            { key: unpushedKey("file:a.md"), value: entry1 },
            { key: unpushedKey("file:b.md"), value: entry2 },
            { key: "_sync/push-seq", value: 99 },
        ]);
        const rows = await loadAllUnpushed(reader);
        expect(rows).toEqual([
            { id: "file:a.md", entry: entry1 },
            { id: "file:b.md", entry: entry2 },
        ]);
    });

    it("loadAllUnpushed drops malformed entries silently", async () => {
        const good: UnpushedEntry = { addedAt: 1, reason: "divergent", attempts: 0 };
        const reader = makeReader([
            { key: unpushedKey("file:good.md"), value: good },
            { key: unpushedKey("file:no-reason.md"), value: { addedAt: 1 } },
            { key: unpushedKey("file:bad-reason.md"), value: { reason: "bogus" } },
            { key: unpushedKey("file:null.md"), value: null },
            { key: unpushedKey("file:string.md"), value: "not-an-entry" },
        ]);
        const rows = await loadAllUnpushed(reader);
        expect(rows.map((r) => r.id)).toEqual(["file:good.md"]);
    });

    it("loadAllUnpushed defaults missing numeric fields to 0", async () => {
        const reader = makeReader([
            { key: unpushedKey("file:partial.md"), value: { reason: "race-stale" } },
        ]);
        const rows = await loadAllUnpushed(reader);
        expect(rows[0]?.entry).toEqual({ reason: "race-stale", addedAt: 0, attempts: 0 });
    });
});
