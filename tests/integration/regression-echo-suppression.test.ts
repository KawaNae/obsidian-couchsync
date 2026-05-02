/**
 * Regression: pull-driven modify events do not generate spurious
 * pushes back to remote.
 *
 * Old mechanism (pre-VaultWriter): a writeIgnore token set by
 * `dbToFile` made `ChangeTracker` drop the next modify event for the
 * path. The token was synchronous-coupled to `vault.modifyBinary`.
 *
 * New mechanism (post-VaultWriter): echo suppression flows through
 * data-level idempotency. When pull commits a FileDoc to localDB,
 * `dbToFile` then writes the same content to vault. The modify event
 * triggers `fileToDb`, which splits the disk content into chunks and
 * compares with the existing FileDoc inside `runWriteBuilder`. Equal
 * chunks → builder returns null → no push.
 *
 * This regression test simulates the steady state and verifies that a
 * `fileToDb` invocation against content matching the existing FileDoc
 * leaves the doc rev unchanged (no spurious write).
 */
import "fake-indexeddb/auto";
import { describe, it, expect, afterEach } from "vitest";
import { createSyncHarness, type SyncHarness } from "../harness/sync-harness.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import type { FileDoc } from "../../src/types.ts";

describe("Regression: pull-driven modify echo does not push", () => {
    let h: SyncHarness;

    afterEach(async () => {
        if (h) await h.destroyAll();
    });

    it("fileToDb on disk content matching existing FileDoc is a no-op", async () => {
        h = createSyncHarness({ baseSettings: { syncDebounceMs: 0, syncMinIntervalMs: 0 } });
        const b = h.addDevice("dev-B");

        // Steady state: vault has a file and localDB has its FileDoc,
        // chunks identical (this is the post-pull post-dbToFile state).
        b.vault.addFile("pull-driven.md", "content written by pull");
        await b.vs.fileToDb("pull-driven.md");
        const before = await b.db.get(makeFileId("pull-driven.md")) as FileDoc;
        expect(before).not.toBeNull();
        const beforeRev = (before as unknown as { _rev: string })._rev;

        // Simulate a pull-driven modify: same content, same chunks.
        // Real Obsidian would fire modify here; we call fileToDb
        // directly because that's what ChangeTracker would do after
        // its debounce.
        await b.vs.fileToDb("pull-driven.md");

        const after = await b.db.get(makeFileId("pull-driven.md")) as FileDoc;
        const afterRev = (after as unknown as { _rev: string })._rev;
        // chunksEqual short-circuit kept the rev untouched.
        expect(afterRev).toBe(beforeRev);
    });
});
