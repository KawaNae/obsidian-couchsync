import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { ConfigLocalDB } from "../src/db/config-local-db.ts";
import { gcOrphanConfigChunks } from "../src/db/chunk-gc.ts";
import { configLastSyncedKey } from "../src/db/sync/config-last-synced.ts";
import { makeConfigFixture } from "./helpers/config-fixture.ts";
import type { CouchSyncDoc } from "../src/types.ts";

describe("gcOrphanConfigChunks", () => {
    it("keeps the chunks of shared versions and of bases, deletes the rest", async () => {
        const db = new ConfigLocalDB(`cfg-gc-${Date.now()}`);
        db.open();
        try {
            const shared = await makeConfigFixture(".obsidian/app.json", "shared v2");
            const base = await makeConfigFixture(".obsidian/app.json", "base v1");
            const orphan = await makeConfigFixture(".obsidian/old.json", "orphan");
            await db.runWriteTx({
                docs: [{ doc: shared.doc as unknown as CouchSyncDoc }],
                chunks: [...shared.chunks, ...base.chunks, ...orphan.chunks] as unknown as CouchSyncDoc[],
                meta: [{
                    op: "put",
                    key: configLastSyncedKey(".obsidian/app.json"),
                    value: { vclock: base.doc.vclock, size: base.doc.size, chunks: base.doc.chunks },
                }],
            });

            const result = await gcOrphanConfigChunks(db);

            expect(result.deletedChunks).toBe(orphan.chunks.length);
            expect((await db.getChunks(shared.doc.chunks)).length).toBe(shared.chunks.length);
            expect((await db.getChunks(base.doc.chunks)).length).toBe(base.chunks.length);
            expect(await db.getChunks(orphan.doc.chunks)).toEqual([]);
        } finally {
            await db.destroy();
        }
    });
});
