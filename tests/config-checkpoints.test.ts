/**
 * ConfigCheckpoints — unit tests for config-side sync progress cursors.
 *
 * Mirror of tests/checkpoints.test.ts but against ConfigLocalDB. Uses a
 * minimal stub instead of a real Dexie store — same approach as the vault
 * checkpoints tests, since this module only touches `getMeta` and
 * `runWriteTx`.
 */
import { describe, it, expect, vi } from "vitest";
import {
    ConfigCheckpoints,
    META_CONFIG_PULL_SEQ,
    META_CONFIG_PUSH_SEQ,
} from "../src/db/sync/config-checkpoints.ts";

function makeConfigDb(initialMeta: Record<string, any> = {}): any {
    const meta = { ...initialMeta };
    return {
        getMeta: vi.fn(async (k: string) => meta[k] ?? null),
        runWriteTx: vi.fn(async (tx: any) => {
            if (tx?.meta) {
                for (const m of tx.meta) {
                    if (m.op === "put") meta[m.key] = m.value;
                    else delete meta[m.key];
                }
            }
            if (tx?.onCommit) await tx.onCommit();
        }),
        _meta: meta,
    };
}

describe("ConfigCheckpoints", () => {
    it("starts with zero seqs before load", () => {
        const cp = new ConfigCheckpoints(makeConfigDb());
        expect(cp.getPullSeq()).toBe(0);
        expect(cp.getPushSeq()).toBe(0);
    });

    it("load reads stored seqs from meta", async () => {
        const db = makeConfigDb({
            [META_CONFIG_PULL_SEQ]: "42",
            [META_CONFIG_PUSH_SEQ]: 7,
        });
        const cp = new ConfigCheckpoints(db);
        await cp.load();
        expect(cp.getPullSeq()).toBe("42");
        expect(cp.getPushSeq()).toBe(7);
    });

    it("load is a no-op when no meta is stored (backwards-compat)", async () => {
        const db = makeConfigDb();
        const cp = new ConfigCheckpoints(db);
        await cp.load();
        expect(cp.getPullSeq()).toBe(0);
        expect(cp.getPushSeq()).toBe(0);
    });

    it("setters update in-memory state; save persists atomically", async () => {
        const db = makeConfigDb();
        const cp = new ConfigCheckpoints(db);
        cp.setPullSeq("100");
        cp.setPushSeq(50);
        await cp.save();
        expect(db._meta[META_CONFIG_PULL_SEQ]).toBe("100");
        expect(db._meta[META_CONFIG_PUSH_SEQ]).toBe(50);
        // Single transaction (one runWriteTx call).
        expect(db.runWriteTx).toHaveBeenCalledTimes(1);
    });

    describe("commitPullBatch", () => {
        it("commits docs + new pullSeq in a single runWriteTx", async () => {
            const db = makeConfigDb();
            const cp = new ConfigCheckpoints(db);
            const onCommit = vi.fn(async () => {});

            await cp.commitPullBatch({
                docs: [
                    { _id: "config:.obsidian/app.json", type: "config", data: "x", mtime: 0, size: 1, vclock: { a: 1 } } as any,
                ],
                nextPullSeq: "200",
                onCommit,
            });

            expect(db.runWriteTx).toHaveBeenCalledTimes(1);
            expect(db._meta[META_CONFIG_PULL_SEQ]).toBe("200");
            expect(cp.getPullSeq()).toBe("200");
            expect(onCommit).toHaveBeenCalled();
        });

        it("advances in-memory pullSeq before caller onCommit fires", async () => {
            const db = makeConfigDb();
            const cp = new ConfigCheckpoints(db);
            let observedSeq: number | string = 0;
            const onCommit = vi.fn(async () => {
                observedSeq = cp.getPullSeq();
            });

            await cp.commitPullBatch({
                docs: [],
                nextPullSeq: 999,
                onCommit,
            });

            // Caller observed the advanced cursor — same atomicity guarantee
            // as Checkpoints (vault).
            expect(observedSeq).toBe(999);
        });

        it("does not advance pullSeq when runWriteTx throws", async () => {
            const db = makeConfigDb();
            db.runWriteTx = vi.fn(async () => {
                throw new Error("simulated commit failure");
            });
            const cp = new ConfigCheckpoints(db);
            cp.setPullSeq(10);

            await expect(
                cp.commitPullBatch({ docs: [], nextPullSeq: 100, onCommit: vi.fn() }),
            ).rejects.toThrow(/simulated commit failure/);
            expect(cp.getPullSeq()).toBe(10); // unchanged
        });
    });

    describe("saveEmptyPullBatch", () => {
        it("advances pullSeq and persists both seqs", async () => {
            const db = makeConfigDb({ [META_CONFIG_PUSH_SEQ]: 5 });
            const cp = new ConfigCheckpoints(db);
            await cp.load();
            await cp.saveEmptyPullBatch("301");
            expect(cp.getPullSeq()).toBe("301");
            expect(db._meta[META_CONFIG_PULL_SEQ]).toBe("301");
            expect(db._meta[META_CONFIG_PUSH_SEQ]).toBe(5);
        });
    });

    describe("backwards-compat", () => {
        it("first run after PR2 deploy sees pullSeq=0 and pushSeq=0", async () => {
            // Simulates a user upgrading from pre-PR2: no _sync/* meta exists.
            // ConfigPullWriter will then do `since=0` catchup, which matches
            // the current pullByPrefix full-fetch semantics.
            const db = makeConfigDb();
            const cp = new ConfigCheckpoints(db);
            await cp.load();
            expect(cp.getPullSeq()).toBe(0);
            expect(cp.getPushSeq()).toBe(0);
        });
    });
});
