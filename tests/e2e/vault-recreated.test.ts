/**
 * E2E: another device's Init re-creates the vault DB while this device is set
 * up against the old one. This device must stop syncing with the new DB —
 * neither applying what it holds nor pushing into it — until it clones it:
 * the agreement check pauses on the new `vault:meta` (at the start of a
 * session, and during a live session when the pull sees the new meta or a
 * body sealed under the new key), and Clone recovers.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createE2EHarness, waitFor, type E2EHarness, type E2EDeviceHarness } from "./couch-harness.ts";
import { makeFileId } from "../../src/types/doc-id.ts";

const LIVE_TIMEOUT_MS = 20_000;

async function waitLive(d: E2EDeviceHarness): Promise<void> {
    await waitFor(() => d.engine.getState() === "connected", {
        timeoutMs: LIVE_TIMEOUT_MS, label: `${d.id} live`,
    });
}

async function waitPaused(d: E2EDeviceHarness): Promise<void> {
    await waitFor(() => d.settings.vaultPause?.reason === "root-changed", {
        timeoutMs: LIVE_TIMEOUT_MS, intervalMs: 20, label: `${d.id} paused on the re-created DB`,
    });
}

describe("E2E: a vault DB re-created by another device's Init", () => {
    let h: E2EHarness;

    beforeEach(async () => {
        h = await createE2EHarness({ uniqueDb: true });
    });

    afterEach(async () => {
        if (h) await h.destroyAll();
    });

    async function setUp(opts: { encryption: boolean; passphrase?: string }): Promise<{
        a: E2EDeviceHarness; b: E2EDeviceHarness;
    }> {
        const a = h.addDevice("dev-A");
        a.vault.addFile("notes/first.md", "first generation");
        await a.runInit({ ...opts, compression: true });
        const b = h.addDevice("dev-B");
        await b.runClone({ passphrase: opts.passphrase });
        expect(b.vault.readText("notes/first.md")).toBe("first generation");
        return { a, b };
    }

    for (const encryption of [false, true]) {
        const label = encryption ? "encrypted" : "plaintext";
        const passphrase = encryption ? "correct horse battery" : undefined;

        it(`${label}: a live device pauses before applying the new DB, and Clone recovers`, async () => {
            const { a, b } = await setUp({ encryption, passphrase });
            await b.engine.start();
            await waitLive(b);

            a.vault.addFile("notes/second.md", "second generation");
            const t0 = Date.now();
            await a.runInit({ encryption, passphrase, compression: true });
            const initMs = Date.now() - t0;
            await waitPaused(b);
            // eslint-disable-next-line no-console
            console.log(`[${label}] Init took ${initMs}ms; B paused ${Date.now() - t0}ms after Init started`);

            expect(b.settings.connectionState).toBe("tested");
            expect(b.engine.getState()).toBe("error");
            expect(b.engine.getLastErrorDetail()?.kind).toBe("encryption-paused");
            // Nothing of the new DB reached B's vault.
            expect(await b.vault.exists("notes/second.md")).toBe(false);

            // An edit B makes now stays local: the paused session pushes nothing.
            b.vault.addFile("notes/late.md", "written by B after the re-creation");
            await b.vs.fileToDb("notes/late.md");
            await new Promise((r) => setTimeout(r, 3000));
            const late = await h.adminClient.getDoc(makeFileId("notes/late.md"));
            expect(late).toBeNull();

            // Clone binds B to the new DB; live sync runs again.
            await b.runClone({ passphrase });
            expect(b.settings.vaultPause).toBeUndefined();
            expect(b.vault.readText("notes/second.md")).toBe("second generation");
            await b.engine.start();
            await waitLive(b);
            expect(b.settings.connectionState).toBe("syncing");
        });
    }

    it("a device that was offline during the Init pauses when its next session starts", async () => {
        const { a, b } = await setUp({ encryption: false });
        a.vault.addFile("notes/second.md", "second generation");
        await a.runInit({ encryption: false, compression: true });

        await b.engine.start();
        await waitPaused(b);
        expect(b.settings.connectionState).toBe("tested");
        expect(await b.vault.exists("notes/second.md")).toBe(false);
    });

    it("the device that ran the Init keeps syncing with the DB it created", async () => {
        const { a } = await setUp({ encryption: false });
        a.vault.addFile("notes/second.md", "second generation");
        await a.runInit({ encryption: false, compression: true });
        await a.engine.start();
        await waitLive(a);
        expect(a.settings.vaultPause).toBeUndefined();
        expect(a.settings.connectionState).toBe("syncing");
    });
});
