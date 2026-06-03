/**
 * pending-conflict persistence — kind round-trip + backward-compat.
 *
 * Covers the Phase 3 addition of the `edit-vs-edit` kind: it must persist and
 * load cleanly, while an unknown/legacy kind from a future or corrupt build is
 * defensively dropped (never crashes the load path, never re-presents garbage).
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LocalDB } from "../src/db/local-db.ts";
import {
    loadAllPendingConflict,
    clearPendingConflict,
    pendingConflictKey,
} from "../src/db/sync/pending-conflict.ts";
import { makeFileId } from "../src/types/doc-id.ts";

let counter = 0;
function uniqueDbName() { return `pending-conflict-test-${Date.now()}-${counter++}`; }

describe("pending-conflict persistence", () => {
    let db: LocalDB;

    beforeEach(() => {
        db = new LocalDB(uniqueDbName());
        db.open();
    });
    afterEach(async () => {
        await db.destroy();
    });

    async function putRaw(docId: string, value: unknown): Promise<void> {
        await db.runWriteTx({ meta: [{ op: "put", key: pendingConflictKey(docId), value }] });
    }

    it("round-trips the edit-vs-edit kind", async () => {
        const id = makeFileId("Periodic/DailyNotes/2026-05-31.md");
        await putRaw(id, { addedAt: 123, kind: "edit-vs-edit" });

        const rows = await loadAllPendingConflict(db);
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(id);
        expect(rows[0].entry.kind).toBe("edit-vs-edit");
        expect(rows[0].entry.addedAt).toBe(123);
    });

    it("round-trips all three known kinds and clears them individually", async () => {
        const ids = {
            del: makeFileId("a.md"),
            rev: makeFileId("b.md"),
            edit: makeFileId("c.md"),
        };
        await putRaw(ids.del, { addedAt: 1, kind: "pull-delete-vs-edit" });
        await putRaw(ids.rev, { addedAt: 2, kind: "local-delete-vs-remote-edit" });
        await putRaw(ids.edit, { addedAt: 3, kind: "edit-vs-edit" });

        expect(await loadAllPendingConflict(db)).toHaveLength(3);

        await clearPendingConflict(db, ids.edit);
        const remaining = await loadAllPendingConflict(db);
        expect(remaining.map((r) => r.entry.kind).sort()).toEqual(
            ["local-delete-vs-remote-edit", "pull-delete-vs-edit"],
        );
    });

    it("defensively drops an unknown/legacy kind (forward/backward compat)", async () => {
        await putRaw(makeFileId("future.md"), { addedAt: 1, kind: "some-future-kind" });
        await putRaw(makeFileId("garbage.md"), "not-an-object");
        await putRaw(makeFileId("ok.md"), { addedAt: 2, kind: "edit-vs-edit" });

        const rows = await loadAllPendingConflict(db);
        // Only the well-formed, known-kind entry survives.
        expect(rows).toHaveLength(1);
        expect(rows[0].entry.kind).toBe("edit-vs-edit");
    });
});
