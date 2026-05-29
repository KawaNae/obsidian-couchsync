/**
 * E2E: 2-device concurrent edit → ConflictResolver returns 'concurrent'.
 *
 * The old version hand-seeded B's baseline via runWriteTx, so B never had a
 * real lastSynced baseline and the resolver returned 'take-remote'. Here B
 * establishes its baseline through the REAL pull pipeline (engine.start →
 * catchup), so the vclocks reflect genuine shared history; concurrent edits
 * from that baseline then resolve as 'concurrent', exactly as in production.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createE2EHarness, waitFor, type E2EHarness } from "./couch-harness.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import type { FileDoc } from "../../src/types.ts";

describe("E2E: concurrent edit conflict (real engine + real CouchDB)", () => {
    let h: E2EHarness;

    beforeEach(async () => {
        h = await createE2EHarness({ uniqueDb: true });
    });

    afterEach(async () => {
        if (h) await h.destroyAll();
    });

    it("both devices edit from a real shared baseline → 'concurrent'", async () => {
        const a = h.addDevice("dev-A");
        const b = h.addDevice("dev-B");

        // Baseline on A → push; B pulls it through the real pipeline so B's
        // lastSynced + FileDoc vclock reflect the genuine shared history.
        a.vault.addFile("shared.md", "v0");
        await a.vs.fileToDb("shared.md");
        await a.engine.start();
        await b.engine.start();
        await waitFor(
            async () => (await b.vault.exists("shared.md"))
                && b.vault.readText("shared.md") === "v0",
            { label: "B pulls baseline v0" },
        );

        // Freeze propagation, then edit both sides from the shared baseline.
        a.engine.stop();
        b.engine.stop();

        a.vault.addFile("shared.md", "version A");
        await a.vs.fileToDb("shared.md");
        b.vault.addFile("shared.md", "version B");
        await b.vs.fileToDb("shared.md");

        const fileId = makeFileId("shared.md");
        const localOnB = (await b.db.get(fileId)) as FileDoc;
        const remoteFromA = (await a.db.get(fileId)) as FileDoc;
        const verdict = await b.resolver.resolveOnPull(localOnB, remoteFromA);
        expect(verdict).toBe("concurrent");
    });
});
