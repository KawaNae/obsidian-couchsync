/**
 * Smoke test for SyncHarness: verifies the factory wires up a usable
 * multi-device sync pair sharing one FakeCouchClient remote.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, afterEach } from "vitest";
import { createSyncHarness } from "./sync-harness.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import type { FileDoc, CouchSyncDoc } from "../../src/types.ts";

describe("SyncHarness — smoke", () => {
    const harnesses: Array<{ destroyAll: () => Promise<void> }> = [];

    afterEach(async () => {
        for (const h of harnesses.splice(0)) await h.destroyAll();
    });

    it("creates a working 2-device setup sharing one couch", () => {
        const h = createSyncHarness();
        harnesses.push(h);

        const a = h.addDevice("dev-A");
        const b = h.addDevice("dev-B");

        expect(a.id).toBe("dev-A");
        expect(b.id).toBe("dev-B");
        expect(a.settings.deviceId).toBe("dev-A");
        expect(b.settings.deviceId).toBe("dev-B");
        expect(h.devices.size).toBe(2);
    });

    it("rejects duplicate device id", () => {
        const h = createSyncHarness();
        harnesses.push(h);
        h.addDevice("only-one");
        expect(() => h.addDevice("only-one")).toThrow(/already exists/);
    });

    it("two devices with separate LocalDBs — writes on A don't leak to B", async () => {
        const h = createSyncHarness();
        harnesses.push(h);
        const a = h.addDevice("dev-A");
        const b = h.addDevice("dev-B");

        a.vault.addFile("notes/a.md", "only A");
        await a.vs.fileToDb("notes/a.md");

        const onA = await a.db.get(makeFileId("notes/a.md"));
        const onB = await b.db.get(makeFileId("notes/a.md"));
        expect(onA).not.toBeNull();
        expect(onB).toBeNull();
    });

    it("manual couch-backed transfer: A's doc propagates to B via shared FakeCouchClient", async () => {
        const h = createSyncHarness();
        harnesses.push(h);
        const a = h.addDevice("dev-A");
        const b = h.addDevice("dev-B");

        a.vault.addFile("shared.md", "from A");
        await a.vs.fileToDb("shared.md");

        // Push A's doc + chunks through the shared couch.
        const fileId = makeFileId("shared.md");
        const docA = (await a.db.get(fileId)) as FileDoc;
        const chunksA = await a.db.getChunks(docA.chunks);
        await h.couch.bulkDocs([
            docA as unknown as CouchSyncDoc,
            ...(chunksA as unknown as CouchSyncDoc[]),
        ]);

        // Pull on B from shared couch via bulkGet, write to B's local DB.
        const ids = [fileId, ...docA.chunks];
        const fetched = await h.couch.bulkGet<CouchSyncDoc>(ids);
        const fileDocs = fetched.filter((d) => d._id === fileId);
        const chunkDocs = fetched.filter((d) => d._id !== fileId);
        await b.db.runWriteTx({
            docs: fileDocs.map((doc) => ({ doc })),
            chunks: chunkDocs,
        });

        // Apply to B's vault via VaultSync.
        const docOnB = (await b.db.get(fileId)) as FileDoc;
        await b.vs.dbToFile(docOnB);

        expect(b.vault.files.has("shared.md")).toBe(true);
        expect(b.vault.readText("shared.md")).toBe("from A");
    });

    it("per-device settings override works", () => {
        const h = createSyncHarness({ baseSettings: { syncDebounceMs: 1234 } });
        harnesses.push(h);
        const a = h.addDevice("dev-A");
        const b = h.addDevice("dev-B", { syncDebounceMs: 9999 });
        expect(a.settings.syncDebounceMs).toBe(1234);
        expect(b.settings.syncDebounceMs).toBe(9999);
    });
});
