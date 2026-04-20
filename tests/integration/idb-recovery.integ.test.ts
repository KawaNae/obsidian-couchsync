/**
 * Integration: IDB handle failure → HandleGuard transparent reopen.
 *
 * Reproduces the production scenario that motivated the Step 1-3 refactor:
 * a browser silently invalidates the IndexedDB connection (OS suspend,
 * tab reclaim). Before the refactor this caused a 2s-interval infinite
 * retry storm — `checkpoint load error` + `catchup failed` in a tight
 * loop. After the refactor HandleGuard must absorb the failure inside
 * LocalDB so SyncEngine never sees it and catchup completes normally.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { createSyncHarness, type SyncHarness } from "../harness/sync-harness.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";

const noop = () => {};
beforeAll(() => {
    (globalThis as any).self = (globalThis as any).self ?? globalThis;
    (globalThis as any).window = (globalThis as any).window ?? {
        addEventListener: noop,
        removeEventListener: noop,
    };
    (globalThis as any).document = (globalThis as any).document ?? {
        addEventListener: noop,
        removeEventListener: noop,
        visibilityState: "visible",
    };
});

/** Seed `count` files on device A and publish them to the shared couch so
 *  device B can pull them during catchup. */
async function seedRemote(h: SyncHarness, a: ReturnType<SyncHarness["addDevice"]>, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
        const path = `notes/n${i}.md`;
        a.vault.addFile(path, `content ${i}`);
        await a.vs.fileToDb(path);
        const doc = (await a.db.get(makeFileId(path))) as FileDoc;
        const chunks = await a.db.getChunks(doc.chunks);
        await h.couch.bulkDocs([
            doc as unknown as CouchSyncDoc,
            ...(chunks as unknown as CouchSyncDoc[]),
        ]);
    }
}

describe("SyncEngine + LocalDB resilience to IDB handle failure", () => {
    let h: SyncHarness;

    afterEach(async () => {
        if (h) await h.destroyAll();
    });

    it("catchup completes even when the docs handle is force-closed before start()", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        const b = h.addDevice("dev-B");

        await seedRemote(h, a, 5);

        // Simulate an OS-level handle kill — HandleGuard should reopen
        // lazily inside ensureHealthy() when openSession() begins.
        await b.db.__closeDocsHandleForTest();

        await b.engine.start();

        expect(b.engine.getState()).toBe("connected");
        for (let i = 0; i < 5; i++) {
            const got = await b.db.getFileDoc(`notes/n${i}.md`);
            expect(got).not.toBeNull();
        }
        b.engine.stop();
        a.engine.stop();
    });

    it("catchup completes when the meta handle is force-closed before start()", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        const b = h.addDevice("dev-B");

        await seedRemote(h, a, 3);

        // Checkpoints live in the docs store but the legacy-migration probe
        // reads the meta store — close it to stress that path.
        await b.db.__closeMetaHandleForTest();

        await b.engine.start();

        expect(b.engine.getState()).toBe("connected");
        for (let i = 0; i < 3; i++) {
            expect(await b.db.getFileDoc(`notes/n${i}.md`)).not.toBeNull();
        }
        b.engine.stop();
        a.engine.stop();
    });

    it("handle close mid-session → next sync-loop op reopens transparently", async () => {
        h = createSyncHarness();
        const a = h.addDevice("dev-A");
        const b = h.addDevice("dev-B");

        await seedRemote(h, a, 2);
        await b.engine.start();
        expect(b.engine.getState()).toBe("connected");

        // A fresh session is live. Kill the docs handle out from under it.
        await b.db.__closeDocsHandleForTest();

        // A subsequent user-facing read on LocalDB must reopen the handle
        // transparently — no DbError surfaces to the caller.
        const got = await b.db.getFileDoc("notes/n0.md");
        expect(got).not.toBeNull();

        b.engine.stop();
        a.engine.stop();
    });
});
