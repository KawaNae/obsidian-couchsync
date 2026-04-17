import { describe, it, expect, vi } from "vitest";
import { Checkpoints } from "../src/db/sync/checkpoints.ts";

function makeLocalDb(initialMeta: Record<string, any> = {}): any {
    const meta = { ...initialMeta };
    const legacyMeta: Record<string, any> = {};
    const docsStore = {
        getMeta: vi.fn(async (k: string) => meta[k] ?? null),
        runWriteTx: vi.fn(async (tx: any) => {
            if (tx?.meta) for (const m of tx.meta) {
                if (m.op === "put") meta[m.key] = m.value;
                else delete meta[m.key];
            }
        }),
    };
    const metaStore = {
        getMeta: vi.fn(async (k: string) => legacyMeta[k] ?? null),
        runWriteTx: vi.fn(async (tx: any) => {
            if (tx?.meta) for (const m of tx.meta) {
                if (m.op === "put") legacyMeta[m.key] = m.value;
                else delete legacyMeta[m.key];
            }
        }),
    };
    return {
        getStore: () => docsStore,
        getMetaStore: () => metaStore,
        _meta: meta,
        _legacyMeta: legacyMeta,
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
                getStore: () => ({ getMeta: vi.fn().mockResolvedValue(null), runWriteTx: vi.fn() }),
                getMetaStore: () => ({ getMeta: vi.fn().mockResolvedValue(null), runWriteTx: vi.fn() }),
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

            // User onCommit ran after the cached seq was already advanced,
            // keeping durable write, in-memory cursor, and side effects
            // observable together.
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
        it("advances remoteSeq and persists via save()", async () => {
            const localDb = makeLocalDb();
            const cp = new Checkpoints(localDb);
            cp.setLastPushedSeq(5);
            await cp.saveEmptyPullBatch("77");
            expect(cp.getRemoteSeq()).toBe("77");
            expect(localDb._meta["_sync/remote-seq"]).toBe("77");
            expect(localDb._meta["_sync/push-seq"]).toBe(5);
        });
    });
});
