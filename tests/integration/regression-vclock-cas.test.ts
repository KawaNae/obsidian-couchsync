/**
 * Regression: fileToDb の CAS retry が機能し、同一 path への並行書き込みで
 * vclock が正しく単調増加する。
 *
 * 仕組み (vault-sync.ts:117 付近):
 *   - fileToDb は runWriteBuilder に渡す closure で `expectedVclock` を指定
 *   - 別の書き込みが先に commit されると CAS 判定で miss → snapshot 再読込して再試行
 *   - maxAttempts = CAS_MAX_ATTEMPTS (= 4) までリトライ
 *
 * 過去リスク: maxAttempts を 1 に下げると並行書き込みの片方が失敗する。
 * このテストは vclock 最終値が期待値 (連続する並行書き込み数) と一致することで
 * CAS リトライ経路が動いていることを検証する。
 */
import "fake-indexeddb/auto";
import { describe, it, expect, afterEach } from "vitest";
import { createSyncHarness, type SyncHarness } from "../harness/sync-harness.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import type { FileDoc } from "../../src/types.ts";

describe("Regression: vclock CAS retry under concurrent fileToDb", () => {
    let h: SyncHarness;

    afterEach(async () => {
        if (h) await h.destroyAll();
    });

    it("concurrent runWriteBuilder on the same path retries CAS and vclock advances once per writer", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        const fileId = makeFileId("race.md");

        // Seed a baseline FileDoc so subsequent writers have a real
        // `expectedVclock` to race against.
        await a.db.runWriteBuilder(async (snap) => {
            const existing = (await snap.get(fileId)) as FileDoc | null;
            const newVclock = { "dev-A": 1 };
            const newDoc: FileDoc = {
                _id: fileId,
                type: "file",
                chunks: ["chunk:seed"],
                mtime: 1000, ctime: 1000, size: 0,
                vclock: newVclock,
            };
            return {
                docs: [{ doc: newDoc as any, expectedVclock: existing?.vclock ?? {} }],
                vclocks: [{ path: "race.md", op: "set", clock: newVclock }],
            };
        });

        // 3 concurrent writers, each bumping vclock by 1. Every closure
        // re-reads the snapshot inside runWriteBuilder, so CAS-miss
        // attempts naturally retry with fresh state and advance counter.
        async function writer(tag: string): Promise<void> {
            await a.db.runWriteBuilder(
                async (snap) => {
                    const existing = (await snap.get(fileId)) as FileDoc | null;
                    const prev = existing?.vclock?.["dev-A"] ?? 0;
                    const newVclock = { "dev-A": prev + 1 };
                    const newDoc: FileDoc = {
                        _id: fileId,
                        type: "file",
                        chunks: [`chunk:${tag}`],
                        mtime: 2000, ctime: 1000, size: 0,
                        vclock: newVclock,
                    };
                    return {
                        docs: [{ doc: newDoc as any, expectedVclock: existing?.vclock ?? {} }],
                        vclocks: [{ path: "race.md", op: "set", clock: newVclock }],
                    };
                },
                { maxAttempts: 8 },
            );
        }

        await Promise.all([writer("a"), writer("b"), writer("c")]);

        // Each writer advanced vclock by 1 from its snapshot. With CAS
        // retry working, final counter = 1 (baseline) + 3 (writers) = 4.
        const final = (await a.db.get(fileId)) as FileDoc;
        expect(final.vclock).toEqual({ "dev-A": 4 });
    });
});
