import { describe, it, expect, vi } from "vitest";
import { Checkpoints } from "../src/db/sync/checkpoints.ts";

/**
 * Test-double for LocalDB matching only the surface Checkpoints touches:
 *   - getMeta / getMetaStoreValue (for legacy migration path)
 *   - runWriteTx / runMetaWriteTx
 */
function makeLocalDb(initialMeta: Record<string, any> = {}): any {
    const docsMeta = { ...initialMeta };
    const metaStoreMeta: Record<string, any> = {};
    return {
        getMeta: vi.fn(async (k: string) => docsMeta[k] ?? null),
        getMetaStoreValue: vi.fn(async (k: string) => metaStoreMeta[k] ?? null),
        runWriteTx: vi.fn(async (tx: any) => {
            if (tx?.meta) for (const m of tx.meta) {
                if (m.op === "put") docsMeta[m.key] = m.value;
                else delete docsMeta[m.key];
            }
            if (tx?.onCommit) await tx.onCommit();
        }),
        runMetaWriteTx: vi.fn(async (tx: any) => {
            if (tx?.meta) for (const m of tx.meta) {
                if (m.op === "put") metaStoreMeta[m.key] = m.value;
                else delete metaStoreMeta[m.key];
            }
        }),
        _meta: docsMeta,
        _legacyMeta: metaStoreMeta,
    };
}

describe("Checkpoints", () => {
    it("starts with zero seqs before load", () => {
        const cp = new Checkpoints(makeLocalDb());
        expect(cp.getRemoteSeq()).toBe(0);
        expect(cp.getLastPushedSeq()).toBe(0);
    });

    it("load reads from docs store meta", async () => {
        const localDb = makeLocalDb({
            "_sync/remote-seq": "42",
            "_sync/push-seq": 7,
        });
        const cp = new Checkpoints(localDb);
        await cp.load();
        expect(cp.getRemoteSeq()).toBe("42");
        expect(cp.getLastPushedSeq()).toBe(7);
    });

    it("setters update in-memory state; save writes atomically", async () => {
        const localDb = makeLocalDb();
        const cp = new Checkpoints(localDb);
        cp.setRemoteSeq("100");
        cp.setLastPushedSeq(50);
        await cp.save();
        expect(localDb._meta["_sync/remote-seq"]).toBe("100");
        expect(localDb._meta["_sync/push-seq"]).toBe(50);
    });

    it("migrates from legacy metaStore on first load", async () => {
        const localDb = makeLocalDb();
        localDb._legacyMeta["_sync/remote-seq"] = "legacy-99";
        localDb._legacyMeta["_sync/push-seq"] = 33;
        const cp = new Checkpoints(localDb);
        await cp.load();
        expect(cp.getRemoteSeq()).toBe("legacy-99");
        expect(cp.getLastPushedSeq()).toBe(33);
        expect(localDb._meta["_sync/remote-seq"]).toBe("legacy-99");
        expect(localDb._legacyMeta["_sync/remote-seq"]).toBeUndefined();
    });

    describe("commitPullBatch", () => {
        function makeCommitLocalDb() {
            const calls: Array<any> = [];
            const runWriteTx = vi.fn(async (tx: any) => {
                calls.push(tx);
                if (tx?.onCommit) await tx.onCommit();
            });
            return {
                runWriteTx,
                getMeta: vi.fn().mockResolvedValue(null),
                getMetaStoreValue: vi.fn().mockResolvedValue(null),
                runMetaWriteTx: vi.fn(),
                _calls: calls,
            } as any;
        }

        it("bundles docs + remote-seq meta into one atomic tx", async () => {
            const localDb = makeCommitLocalDb();
            const cp = new Checkpoints(localDb);
            const doc = { _id: "chunk:a", type: "chunk", data: "x" } as any;

            await cp.commitPullBatch({
                docs: [doc],
                nextRemoteSeq: "42",
                onCommit: async () => {},
            });

            expect(localDb.runWriteTx).toHaveBeenCalledTimes(1);
            const tx = localDb._calls[0];
            expect(tx.docs).toEqual([{ doc }]);
            expect(tx.meta).toEqual([{ op: "put", key: "_sync/remote-seq", value: "42" }]);
        });

        it("advances in-memory remoteSeq inside onCommit, before user onCommit fires", async () => {
            const localDb = makeCommitLocalDb();
            const cp = new Checkpoints(localDb);
            let observedSeq: number | string = -1;

            await cp.commitPullBatch({
                docs: [],
                nextRemoteSeq: "100",
                onCommit: async () => { observedSeq = cp.getRemoteSeq(); },
            });

            expect(observedSeq).toBe("100");
            expect(cp.getRemoteSeq()).toBe("100");
        });

        it("onCommit error propagates (no silent swallow)", async () => {
            const localDb = makeCommitLocalDb();
            const cp = new Checkpoints(localDb);

            await expect(
                cp.commitPullBatch({
                    docs: [],
                    nextRemoteSeq: "7",
                    onCommit: async () => { throw new Error("boom"); },
                }),
            ).rejects.toThrow("boom");
        });
    });

    describe("saveEmptyPullBatch", () => {
        it("advances remoteSeq and persists only META_REMOTE_SEQ", async () => {
            const calls: any[] = [];
            const localDb = makeLocalDb();
            const origRunWriteTx = localDb.runWriteTx;
            localDb.runWriteTx = vi.fn(async (tx: any) => {
                calls.push(tx);
                return origRunWriteTx(tx);
            });
            const cp = new Checkpoints(localDb);
            cp.setLastPushedSeq(5);
            await cp.saveEmptyPullBatch("77");
            expect(cp.getRemoteSeq()).toBe("77");
            expect(localDb._meta["_sync/remote-seq"]).toBe("77");
            expect(calls).toHaveLength(1);
            expect(calls[0].meta).toEqual([
                { op: "put", key: "_sync/remote-seq", value: "77" },
            ]);
        });

        it("does not advance remoteSeq when runWriteTx throws", async () => {
            const localDb = makeLocalDb();
            localDb.runWriteTx = vi.fn(async () => {
                throw new Error("simulated commit failure");
            });
            const cp = new Checkpoints(localDb);
            cp.setRemoteSeq(10);

            await expect(cp.saveEmptyPullBatch("77")).rejects.toThrow(/simulated/);
            expect(cp.getRemoteSeq()).toBe(10);
        });
    });

    describe("commitPushCycle", () => {
        it("advances pushSeq and writes set adds + removes in one tx", async () => {
            const localDb = makeLocalDb();
            const cp = new Checkpoints(localDb);
            cp.setLastPushedSeq(10);
            // Pre-existing entry to be removed.
            localDb._meta["_sync/unpushed/file:gone.md"] = {
                addedAt: 1, reason: "race-stale", attempts: 1,
            };

            await cp.commitPushCycle({
                nextPushSeq: 42,
                unpushedAdd: [
                    { id: "file:new.md", reason: "race-stale", attempts: 1 },
                    { id: "file:diverged.md", reason: "divergent", attempts: 0 },
                ],
                unpushedRemove: ["file:gone.md"],
            });

            expect(cp.getLastPushedSeq()).toBe(42);
            expect(localDb._meta["_sync/push-seq"]).toBe(42);
            expect(localDb._meta["_sync/unpushed/file:gone.md"]).toBeUndefined();
            expect(localDb._meta["_sync/unpushed/file:new.md"]).toMatchObject({
                reason: "race-stale", attempts: 1,
            });
            expect(localDb._meta["_sync/unpushed/file:diverged.md"]).toMatchObject({
                reason: "divergent", attempts: 0,
            });
            // One tx round-trip — atomic with cursor advance.
            expect(localDb.runWriteTx).toHaveBeenCalledTimes(1);
        });

        it("advance is unconditional even with empty add/remove", async () => {
            const localDb = makeLocalDb();
            const cp = new Checkpoints(localDb);
            cp.setLastPushedSeq(0);

            await cp.commitPushCycle({
                nextPushSeq: 17,
                unpushedAdd: [],
                unpushedRemove: [],
            });

            expect(cp.getLastPushedSeq()).toBe(17);
            expect(localDb._meta["_sync/push-seq"]).toBe(17);
        });

        it("removes are applied before adds (in-cycle re-flag wins)", async () => {
            const localDb = makeLocalDb();
            const cp = new Checkpoints(localDb);
            await cp.commitPushCycle({
                nextPushSeq: 1,
                unpushedAdd: [{ id: "file:x.md", reason: "divergent", attempts: 0 }],
                unpushedRemove: ["file:x.md"],
            });
            // The add wins because we apply removes first, then adds.
            expect(localDb._meta["_sync/unpushed/file:x.md"]).toMatchObject({
                reason: "divergent",
            });
        });

        it("entry includes addedAt timestamp", async () => {
            const localDb = makeLocalDb();
            const cp = new Checkpoints(localDb);
            const before = Date.now();
            await cp.commitPushCycle({
                nextPushSeq: 1,
                unpushedAdd: [{ id: "file:x.md", reason: "race-stale", attempts: 2 }],
                unpushedRemove: [],
            });
            const after = Date.now();
            const entry = localDb._meta["_sync/unpushed/file:x.md"];
            expect(entry.addedAt).toBeGreaterThanOrEqual(before);
            expect(entry.addedAt).toBeLessThanOrEqual(after);
            expect(entry.attempts).toBe(2);
        });
    });
});
