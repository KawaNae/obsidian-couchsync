/**
 * Regression: ChangeTracker.ignoreWrite が pull-driven modify イベントを
 * 抑制し、vault 側のイベントで spurious な fileToDb 呼び出しが発生しない。
 *
 * 仕組み (vault-sync.ts:193 周辺):
 *   - VaultSync.dbToFile は vault 書き込み直前に writeIgnore.ignoreWrite(path) を呼ぶ
 *   - vault.writeBinary/createBinary が "modify"/"create" イベントを発火
 *   - ChangeTracker の handler が pendingWriteIgnores から path を削除したら handler は早期 return する
 *
 * 過去リスク: handler の pendingWriteIgnores チェックが脱落すると、pulled file
 * の modify/create が local edit と誤判定され、fileToDb が走る → echo storm /
 * 意図しない push / 書き込みループ。
 *
 * 検証戦略:
 *   - B の DB は空の状態から開始
 *   - vault にファイルを足し (pull-driven write の代替)、ignoreWrite を登録してから event を発火
 *   - debounce 経過後、DB に FileDoc が作られていないことを確認
 *   - ChangeTracker の抑制が効いていれば fileToDb が呼ばれず、DB は空のまま
 *   - 抑制が壊れていれば fileToDb が呼ばれ、DB に FileDoc が作られる
 */
import "fake-indexeddb/auto";
import { describe, it, afterEach } from "vitest";
import { createSyncHarness, type SyncHarness } from "../harness/sync-harness.ts";
import { expectDb } from "../harness/assertions.ts";

describe("Regression: ChangeTracker.ignoreWrite suppresses pull-driven modify echo", () => {
    let h: SyncHarness;

    afterEach(async () => {
        if (h) await h.destroyAll();
    });

    it("create event on an ignored path does NOT call fileToDb", async () => {
        // syncDebounceMs=0 so a single event-loop tick drains scheduled work.
        h = createSyncHarness({ baseSettings: { syncDebounceMs: 0, syncMinIntervalMs: 0 } });
        const b = h.addDevice("dev-B");
        b.ct.start();

        // Simulate a pull-driven vault write by: putting the file in the
        // vault (as dbToFile would), registering the ignore token (as
        // dbToFile does via writeIgnore), then firing the create event
        // (as Obsidian would synchronously during createBinary).
        b.vault.addFile("pull-driven.md", "content written by pull");
        b.ct.ignoreWrite("pull-driven.md");
        const stat = (await b.vault.stat("pull-driven.md"))!;
        b.vaultEvents.emit("create", "pull-driven.md", stat);

        // Drain any scheduled timer. syncDebounceMs=0 → setTimeout(fn, 0).
        await new Promise((r) => setTimeout(r, 20));

        // If ChangeTracker handled the event (echo suppression broken),
        // it would have called vs.fileToDb → DB gets a FileDoc for this path.
        // With echo suppression working, DB remains empty for this path.
        await expectDb(b.db).toNotHaveFileDoc("pull-driven.md");

        b.ct.stop();
    });
});
