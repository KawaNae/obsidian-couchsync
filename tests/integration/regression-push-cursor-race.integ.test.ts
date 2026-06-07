/**
 * Regression: push cursor lost-update race (2026-06-03 search1.jpeg
 * incident, HIGH).
 *
 * `DexieStore.changes()` used to read `_update_seq` in a separate IDB
 * transaction from the row query; a write committing in the gap was
 * covered by `last_seq` but never enumerated. `commitPushCycle` advanced
 * the cursor past it — for a tombstone (no further vault events) the
 * deletion became permanently unpushable: not in the changes feed, not in
 * the unpushed-set, not in any log. The deleted file then resurrected on
 * every other device.
 *
 * Two layers asserted here:
 *  1. structural fix — `last_seq` derives from the enumerated rows, so a
 *     row committed after enumeration is always picked up next cycle;
 *  2. recovery sweep — `runPushBackfill` re-enqueues docs already stranded
 *     behind the cursor (the existing fleet damage) into the persistent
 *     unpushed-set, where the normal push machinery picks them up.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, afterEach } from "vitest";
import { LocalDB } from "../../src/db/local-db.ts";
import { FakeCouchClient } from "../helpers/fake-couch-client.ts";
import { runPushBackfill, PUSH_BACKFILL_FLAG_KEY } from "../../src/db/sync/push-backfill.ts";
import { loadAllUnpushed, unpushedKey } from "../../src/db/sync/unpushed-ids.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";

let counter = 0;
function uniqueDbName() { return `cursor-race-${Date.now()}-${counter++}`; }

function fileDoc(path: string, vc: Record<string, number>, extra: Partial<FileDoc> = {}): FileDoc {
    return {
        _id: makeFileId(path), type: "file", chunks: [],
        mtime: 1, ctime: 1, size: 0, vclock: vc, ...extra,
    };
}

describe("regression: push cursor lost-update race", () => {
    let db: LocalDB;
    afterEach(async () => { await db.destroy(); });

    it("a tombstone committed after enumeration is enumerated next cycle (structural fix)", async () => {
        db = new LocalDB(uniqueDbName());
        db.open();
        await db.runWriteTx({ docs: [{ doc: fileDoc("a.md", { m: 1 }) as unknown as CouchSyncDoc }] });

        // Cycle 1 enumerates a.md; the race then commits a tombstone for
        // b.md AFTER the row query of cycle 1.
        const cycle1 = await db.changes(0);
        await db.runWriteTx({
            docs: [{ doc: fileDoc("b.md", { m: 2 }, { deleted: true }) as unknown as CouchSyncDoc }],
        });

        // The old implementation: cycle1.last_seq already covered b.md's
        // seq, so cycle 2 (since=last_seq) never saw it. Fixed: last_seq is
        // the max enumerated row seq, so cycle 2 MUST return b.md.
        const cycle2 = await db.changes(cycle1.last_seq);
        expect(cycle2.results.map((r) => r.id)).toContain(makeFileId("b.md"));
    });

    describe("push-backfill sweep (recovery for already-stranded docs)", () => {
        it("re-enqueues a stranded local tombstone that dominates the remote live doc (search1 shape)", async () => {
            db = new LocalDB(uniqueDbName());
            db.open();
            const couch = new FakeCouchClient();
            // Remote: alive at {m:1} (the tombstone push was lost).
            await couch.bulkDocs([fileDoc("search1.jpeg", { m: 1 })]);
            // Local: tombstone at {m:2}, stranded behind the cursor (no
            // unpushed entry, no changes row beyond the cursor — we simply
            // don't enumerate; backfill works from the doc sets alone).
            await db.runWriteTx({
                docs: [{ doc: fileDoc("search1.jpeg", { m: 2 }, { deleted: true }) as unknown as CouchSyncDoc }],
            });
            // Unrelated converged doc — must NOT be enqueued.
            await couch.bulkDocs([fileDoc("ok.md", { m: 1 })]);
            await db.runWriteTx({ docs: [{ doc: fileDoc("ok.md", { m: 1 }) as unknown as CouchSyncDoc }] });

            const r = await runPushBackfill({ localDb: db, remote: couch as any });
            expect(r.skippedByFlag).toBe(false);
            expect(r.enqueued).toBe(1);
            const rows = await loadAllUnpushed(db);
            expect(rows.map((x) => x.id)).toEqual([makeFileId("search1.jpeg")]);
            expect(rows[0].entry).toMatchObject({ reason: "race-stale", attempts: 0 });
        });

        it("re-enqueues local-only docs (created in the race window, never pushed)", async () => {
            db = new LocalDB(uniqueDbName());
            db.open();
            const couch = new FakeCouchClient();
            await db.runWriteTx({ docs: [{ doc: fileDoc("orphan.md", { m: 1 }) as unknown as CouchSyncDoc }] });

            const r = await runPushBackfill({ localDb: db, remote: couch as any });
            expect(r.enqueued).toBe(1);
            expect((await loadAllUnpushed(db)).map((x) => x.id)).toEqual([makeFileId("orphan.md")]);
        });

        it("does NOT enqueue docs where remote dominates or diverges (pull/conflict territory)", async () => {
            db = new LocalDB(uniqueDbName());
            db.open();
            const couch = new FakeCouchClient();
            await couch.bulkDocs([fileDoc("newer-remote.md", { m: 2 })]);
            await db.runWriteTx({ docs: [{ doc: fileDoc("newer-remote.md", { m: 1 }) as unknown as CouchSyncDoc }] });
            await couch.bulkDocs([fileDoc("concurrent.md", { m: 1, i: 1 })]);
            await db.runWriteTx({ docs: [{ doc: fileDoc("concurrent.md", { m: 1, x: 1 }) as unknown as CouchSyncDoc }] });

            const r = await runPushBackfill({ localDb: db, remote: couch as any });
            expect(r.enqueued).toBe(0);
        });

        it("one-time flag short-circuits the second run; force re-sweeps", async () => {
            db = new LocalDB(uniqueDbName());
            db.open();
            const couch = new FakeCouchClient();
            const first = await runPushBackfill({ localDb: db, remote: couch as any });
            expect(first.skippedByFlag).toBe(false);
            expect(await db.getMeta(PUSH_BACKFILL_FLAG_KEY)).toBeTruthy();

            const second = await runPushBackfill({ localDb: db, remote: couch as any });
            expect(second.skippedByFlag).toBe(true);

            // A doc strands later; the manual (force) path still finds it.
            await db.runWriteTx({ docs: [{ doc: fileDoc("late.md", { m: 1 }) as unknown as CouchSyncDoc }] });
            const forced = await runPushBackfill({ localDb: db, remote: couch as any, force: true });
            expect(forced.skippedByFlag).toBe(false);
            expect(forced.enqueued).toBe(1);
        });

        it("preserves the attempts counter of ids already in the unpushed-set", async () => {
            db = new LocalDB(uniqueDbName());
            db.open();
            const couch = new FakeCouchClient();
            await db.runWriteTx({ docs: [{ doc: fileDoc("retrying.md", { m: 2 }, { deleted: true }) as unknown as CouchSyncDoc }] });
            await couch.bulkDocs([fileDoc("retrying.md", { m: 1 })]);
            // Already mid-escalation in the set.
            await db.runWriteTx({
                meta: [{
                    op: "put", key: unpushedKey(makeFileId("retrying.md")),
                    value: { reason: "race-stale", attempts: 2, addedAt: 1 },
                }],
            });

            const r = await runPushBackfill({ localDb: db, remote: couch as any });
            expect(r.enqueued).toBe(0); // already tracked — not clobbered
            const rows = await loadAllUnpushed(db);
            expect(rows[0].entry.attempts).toBe(2);
        });
    });
});
