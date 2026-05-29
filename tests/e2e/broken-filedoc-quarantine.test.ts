/**
 * E2E (G2): a FileDoc whose chunks are unavailable on this device AND the
 * server (broken / missingReferenced) must be QUARANTINED by the reconciler —
 * not restore-looped (the field ping-pong), not opaque-crashed (G1). Recovers
 * automatically once the chunk reappears.
 *
 * Drives the real Reconciler + real engine.ensureFileChunks against real
 * CouchDB (getAttachment actually returns null for the absent chunk), so this
 * is the end-to-end guard the old e2e suite could never provide.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createE2EHarness, waitFor, type E2EHarness } from "./couch-harness.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import type { FileDoc } from "../../src/types.ts";

describe("E2E: broken FileDoc → quarantine, then recover (real engine + CouchDB)", () => {
    let h: E2EHarness;

    beforeEach(async () => {
        h = await createE2EHarness({ uniqueDb: true });
    });

    afterEach(async () => {
        if (h) await h.destroyAll();
    });

    it("quarantines a file whose chunk is missing everywhere; recovers when it arrives", async () => {
        const a = h.addDevice("dev-A");
        const b = h.addDevice("dev-B");

        // A authors a file locally but does NOT push yet — so its chunk exists
        // only on A, not on the server.
        a.vault.addFile("broken.md", "real content that lives only on A for now");
        await a.vs.fileToDb("broken.md");
        const fileId = makeFileId("broken.md");
        const docFromA = (await a.db.get(fileId)) as FileDoc;
        expect(docFromA.chunks.length).toBeGreaterThan(0);

        // B is handed A's FileDoc (e.g. via a metadata-only path) but has
        // neither the chunk locally nor a vault file — and the server doesn't
        // have the chunk either. This is the "broken" state.
        await b.db.runWriteTx({ docs: [{ doc: docFromA }] });

        await b.engine.start(); // live session so ensureFileChunks consults the server

        // 1. Reconcile: chunk missing locally AND on the server → quarantine,
        //    not a restore that throws / loops.
        const r1 = await b.reconciler.reconcile("manual");
        expect(r1.quarantined).toContain("broken.md");
        expect(r1.restored).toEqual([]);
        expect(await b.vault.exists("broken.md")).toBe(false);
        expect(await b.vs.wasQuarantined("broken.md")).toBe(true);

        // 2. Re-reconcile: stays quarantined, no ping-pong, no throw.
        const r2 = await b.reconciler.reconcile("manual");
        expect(r2.restored).toEqual([]);
        expect(await b.vault.exists("broken.md")).toBe(false);

        // 3. Recovery: A pushes the file (chunk lands on the server), B's pull
        //    delivers the chunk locally, and the next reconcile clears the
        //    quarantine and restores the file.
        await a.engine.start();
        await waitFor(
            async () => {
                await b.reconciler.reconcile("manual");
                return await b.vault.exists("broken.md");
            },
            { label: "B recovers broken.md once the chunk arrives", timeoutMs: 9000 },
        );
        expect(b.vault.readText("broken.md")).toBe("real content that lives only on A for now");
        expect(await b.vs.wasQuarantined("broken.md")).toBe(false);
    });
});
