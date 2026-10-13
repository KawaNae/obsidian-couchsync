/**
 * E2E: the first live session after Init or Clone writes nothing to the
 * server. Init pushed every doc and Clone pulled every doc, so the server
 * already holds all of them; a chunk is content-addressed, so one the
 * server holds is never sent again (a new revision of identical content
 * would only advance the DB's sequence and wake every other device's pull).
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createE2EHarness, waitFor, type E2EHarness, type E2EDeviceHarness } from "./couch-harness.ts";

const LIVE_TIMEOUT_MS = 8_000;
/** Longer than the push pipeline's poll interval, so a push cycle ran. */
const PUSH_SETTLE_MS = 3_000;

async function liveForAWhile(d: E2EDeviceHarness): Promise<void> {
    await d.engine.start();
    await waitFor(() => d.engine.getState() === "connected", {
        timeoutMs: LIVE_TIMEOUT_MS, label: `${d.id} live`,
    });
    await new Promise((r) => setTimeout(r, PUSH_SETTLE_MS));
    await d.engine.stop();
}

describe("E2E: live sync after Init / Clone", () => {
    let h: E2EHarness;

    beforeEach(async () => {
        h = await createE2EHarness({ uniqueDb: true });
    });

    afterEach(async () => {
        if (h) await h.destroyAll();
    });

    for (const encryption of [false, true]) {
        const label = encryption ? "encrypted" : "plaintext";
        const passphrase = encryption ? "correct horse battery" : undefined;

        it(`${label}: neither the Init device nor the Clone device re-sends what the server holds`, async () => {
            const a = h.addDevice("dev-A");
            a.vault.addFile("notes/one.md", "first note");
            a.vault.addFile("notes/two.md", "second note ".repeat(40));
            await a.runInit({ encryption, passphrase, compression: true });
            const afterInit = (await h.adminClient.info()).update_seq;

            await liveForAWhile(a);
            expect((await h.adminClient.info()).update_seq).toBe(afterInit);

            const b = h.addDevice("dev-B");
            await b.runClone({ passphrase });
            await liveForAWhile(b);
            expect((await h.adminClient.info()).update_seq).toBe(afterInit);
        }, 20_000);
    }
});
