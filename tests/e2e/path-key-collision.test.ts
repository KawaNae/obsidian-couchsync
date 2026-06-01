/**
 * E2E: PathKey (case) collision convergence through the REAL engine + real
 * CouchDB — the scripts/Scripts incident.
 *
 * FakeVaultIO is case-SENSITIVE (exact-string Map keys), so it models an
 * Android-class FS where `scripts/X` and `Scripts/X` are two real files.
 * Device A creates BOTH (same content → one shared content-addressed chunk),
 * pushes them, and B pulls both docs. Reconcile Case F must converge to a
 * single canonical case across both devices, and the non-canonical tombstone
 * must propagate back to A.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createE2EHarness, waitFor, type E2EHarness } from "./couch-harness.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import type { FileDoc } from "../../src/types.ts";

describe("E2E: PathKey collision convergence (real engine + real CouchDB)", () => {
    let h: E2EHarness;

    beforeEach(async () => {
        h = await createE2EHarness({ uniqueDb: true });
    });

    afterEach(async () => {
        if (h) await h.destroyAll();
    });

    it("two case-variant docs converge to one canonical case on every device", async () => {
        const a = h.addDevice("dev-A");
        const b = h.addDevice("dev-B");

        // A (case-sensitive FS) holds BOTH variants with identical content.
        a.vault.addFile("Scripts/X.md", "same content");
        a.vault.addFile("scripts/X.md", "same content");
        await a.vs.fileToDb("Scripts/X.md");
        await a.vs.fileToDb("scripts/X.md");

        await a.engine.start();
        await b.engine.start();

        // B pulls BOTH docs (the collision lands in B's LocalDB).
        await waitFor(
            async () => (await b.db.getFileDoc("Scripts/X.md")) != null
                && (await b.db.getFileDoc("scripts/X.md")) != null,
            { label: "B pulls both case-variant docs" },
        );

        // Reconcile Case F resolves the collision: vclocks are equal, so the
        // deterministic tiebreak (id order) keeps the uppercase variant.
        const r = await b.reconciler.reconcile("manual");
        expect(r.collisionsResolved).toEqual(["Scripts/X.md"]);

        // B converged: one alive doc, one tombstone, one physical file — the
        // collision resolved end-to-end through a real CouchDB pull + reconcile.
        const upperB = (await b.db.getFileDoc("Scripts/X.md")) as FileDoc;
        const lowerB = (await b.db.getFileDoc("scripts/X.md")) as FileDoc;
        expect(upperB.deleted).toBeFalsy();
        expect(lowerB.deleted).toBe(true);
        expect(await b.vault.exists("Scripts/X.md")).toBe(true);
        expect(await b.vault.exists("scripts/X.md")).toBe(false);

        // The tombstone must propagate back to A through real CouchDB — proving
        // the #sync-005 churn-guard fix (a tombstone is chunk-equal to the alive
        // remote yet must still push). A's lowercase file is removed by the
        // case-safe pull-deletion, leaving A converged to the same canonical.
        await waitFor(
            async () => {
                const d = await a.db.getFileDoc("scripts/X.md");
                return d != null && d.deleted === true;
            },
            { label: "A's LocalDB receives the scripts/X.md tombstone", timeoutMs: 20000 },
        );
        await waitFor(
            async () => !(await a.vault.exists("scripts/X.md"))
                && (await a.vault.exists("Scripts/X.md")),
            { label: "A converges to the canonical case via the pulled tombstone", timeoutMs: 20000 },
        );
        expect(await a.vault.exists("scripts/X.md")).toBe(false);
        expect(await a.vault.exists("Scripts/X.md")).toBe(true);
    }, 45000);
});
