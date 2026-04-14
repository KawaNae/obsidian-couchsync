/**
 * Tests for the builder-form `DexieStore.runWrite(builder)` API.
 *
 * Focused on the new invariants:
 *   - builder sees a fresh snapshot; returning null is a no-op
 *   - onCommit fires after a successful commit, not on abort
 *   - CAS conflicts trigger internal re-snapshot + retry
 *   - conflict exhaustion surfaces a DbError(kind:"conflict", recovery:"fail")
 *   - quota errors surface as DbError(kind:"quota", recovery:"halt")
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { DexieStore } from "../src/db/dexie-store.ts";
import { DbError } from "../src/db/write-transaction.ts";
import { makeFileId } from "../src/types/doc-id.ts";
import type { FileDoc } from "../src/types.ts";

let store: DexieStore<any>;

function makeFile(path: string, vclock: Record<string, number> = {}): FileDoc {
    const id = makeFileId(path);
    return {
        _id: id,
        type: "file",
        chunks: [],
        mtime: 1,
        ctime: 1,
        size: 0,
        vclock,
    } as FileDoc;
}

beforeEach(() => {
    store = new DexieStore<any>(`doc-store-${Date.now()}-${Math.random()}`);
});

afterEach(async () => {
    await store.destroy();
});

describe("runWrite(builder)", () => {
    it("commits a tx built from the snapshot", async () => {
        const fileId = makeFileId("a.md");
        const committed = await store.runWrite(async (snap) => {
            const existing = await snap.get(fileId);
            expect(existing).toBeNull();
            return {
                docs: [{ doc: makeFile("a.md", { A: 1 }) }],
                vclocks: [{ path: "a.md", op: "set", clock: { A: 1 } }],
            };
        });
        expect(committed).toBe(true);
        const got = await store.get(fileId);
        expect((got as FileDoc).vclock).toEqual({ A: 1 });
    });

    it("returns false (no-op) when builder returns null", async () => {
        const before = await store.info();
        const committed = await store.runWrite(async () => null);
        expect(committed).toBe(false);
        const after = await store.info();
        expect(after.updateSeq).toBe(before.updateSeq);
    });

    it("fires onCommit once, after the tx succeeds", async () => {
        let fired = 0;
        await store.runWrite(async () => ({
            meta: [{ op: "put", key: "k", value: 1 }],
            onCommit: () => { fired++; },
        }));
        expect(fired).toBe(1);
        expect(await store.getMeta("k")).toBe(1);
    });

    it("does NOT fire onCommit when builder aborts", async () => {
        let fired = 0;
        await store.runWrite(async () => null);
        // builder returned null → no onCommit even if the tx object had one
        // (null means "no tx at all"). Explicit check below: a builder that
        // returns a tx with onCommit, but the commit fails → onCommit skipped.
        await expect(
            store.runWrite(async () => ({
                docs: [{
                    doc: makeFile("z.md", { Z: 99 }),
                    expectedVclock: { ghost: 42 }, // will CAS-fail
                }],
                onCommit: () => { fired++; },
            }), { maxAttempts: 1 }),
        ).rejects.toThrow(/CAS|conflict/);
        expect(fired).toBe(0);
    });

    it("retries internally when CAS conflicts, then succeeds", async () => {
        const path = "race.md";
        const fileId = makeFileId(path);
        // Seed.
        await store.runWrite({
            docs: [{ doc: makeFile(path, { A: 1 }) }],
        });

        // Builder that reads, and on first call supplies a stale expectedVclock
        // to force a conflict; on second call supplies the fresh one.
        let calls = 0;
        const committed = await store.runWrite(async (snap) => {
            calls++;
            const current = await snap.get(fileId);
            const curVc = (current as FileDoc).vclock ?? {};
            const stale = calls === 1 ? { A: 0 } : curVc;
            return {
                docs: [{
                    doc: { ...(current as FileDoc), vclock: { A: (curVc.A ?? 0) + 1 } },
                    expectedVclock: stale,
                }],
            };
        });
        expect(committed).toBe(true);
        expect(calls).toBe(2);
        const got = await store.get(fileId);
        expect((got as FileDoc).vclock).toEqual({ A: 2 });
    });

    it("throws DbError(conflict) when CAS exhaustion", async () => {
        const fileId = makeFileId("exh.md");
        await store.runWrite({
            docs: [{ doc: makeFile("exh.md", { A: 1 }) }],
        });
        await expect(
            store.runWrite(async () => ({
                docs: [{
                    doc: makeFile("exh.md", { A: 2 }),
                    expectedVclock: { ghost: 99 }, // always wrong
                }],
            }), { maxAttempts: 3 }),
        ).rejects.toMatchObject({ kind: "conflict", recovery: "fail" });
    });

    it("still exposes legacy runWrite(tx) form", async () => {
        // Regression: the polymorphic overload must not break pre-builder callers.
        const fileId = makeFileId("legacy.md");
        await store.runWrite({
            docs: [{ doc: makeFile("legacy.md", { A: 1 }) }],
            meta: [{ op: "put", key: "lgc", value: true }],
        });
        expect(await store.get(fileId)).not.toBeNull();
        expect(await store.getMeta("lgc")).toBe(true);
    });
});

describe("DbError recovery inference", () => {
    it("quota defaults to halt with a userMessage", () => {
        const e = new DbError("quota", null);
        expect(e.recovery).toBe("halt");
        expect(e.userMessage).toMatch(/容量/);
    });

    it("conflict defaults to fail with no userMessage", () => {
        const e = new DbError("conflict", null);
        expect(e.recovery).toBe("fail");
        expect(e.userMessage).toBeUndefined();
    });

    it("explicit recovery overrides default", () => {
        const e = new DbError("abort", null, "x", { recovery: "halt" });
        expect(e.recovery).toBe("halt");
    });
});
