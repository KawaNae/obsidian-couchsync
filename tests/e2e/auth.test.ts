/**
 * E2E: 401 response with bad credentials → AuthGate raises and SyncEngine
 * transitions to "error" with kind="auth".
 *
 * Requires a CouchDB instance that rejects anonymous / bogus credentials
 * for the target DB. Our docker-compose sets admin/admin; we deliberately
 * use wrong credentials here to provoke 401.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createE2EHarness, type E2EHarness } from "./couch-harness.ts";

describe("E2E: auth failure (real CouchDB)", () => {
    let h: E2EHarness;

    beforeAll(async () => {
        h = await createE2EHarness();
    });

    beforeEach(async () => {
        await h.destroyAll();
        await h.resetCouch();
    });

    afterAll(async () => {
        if (h) await h.destroyAll();
    });

    it("bad credentials → AuthGate raises, engine enters error state", async () => {
        const dev = h.addDevice("dev-auth", {
            couchdbPassword: "definitely-not-the-password",
        });

        // Watching the state-change events rather than polling getState() —
        // this is the contract the status bar listens to.
        const states: string[] = [];
        dev.engine.events.on("state-change", ({ state }) => {
            states.push(state);
        });

        await dev.engine.start();

        // Allow a few event-loop turns for session open → catchup → 401.
        await new Promise((r) => setTimeout(r, 1500));

        dev.engine.stop();

        expect(dev.auth.isBlocked()).toBe(true);
        expect(states).toContain("error");
        const detail = dev.engine.getLastErrorDetail();
        expect(detail?.kind).toBe("auth");
    });
});
