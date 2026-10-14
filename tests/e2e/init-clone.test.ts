/**
 * E2E: Init + Clone through the real SetupService + real CouchDB.
 *
 * Init builds vault:meta (deriving crypto when encryption is on) and pushes
 * the whole vault through the real codec stack; Clone fetches the meta,
 * unlocks with the passphrase, pulls everything and rebuilds the vault. This
 * is the setup path real devices run on day one, and the one every
 * destructive migration (Init on one device, Clone on the rest) runs. Asserts the vault reconstructs byte-for-byte, the meta
 * records the chosen codec, and a wrong passphrase is rejected.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createE2EHarness, bytesEqual, waitFor, type E2EHarness } from "./couch-harness.ts";
import { makeFileId } from "../../src/types/doc-id.ts";
import { fetchVaultMeta } from "../../src/db/vault-meta.ts";

describe("E2E: Init + Clone (real setup + real CouchDB)", () => {
    let h: E2EHarness;

    beforeEach(async () => {
        h = await createE2EHarness({ uniqueDb: true });
    });

    afterEach(async () => {
        if (h) await h.destroyAll();
    });

    it("encrypted + compressed: A inits, B clones, vault rebuilt; wrong passphrase rejected", async () => {
        const a = h.addDevice("dev-A");
        a.vault.addFile("notes/n1.md", "first note");
        a.vault.addFile("notes/n2.md", "second note ".repeat(50));
        const blob = new Uint8Array([0, 1, 2, 254, 255, 0, 128, 7]);
        a.vault.addBinaryFile("attach/blob.bin", blob.buffer);

        await a.runInit({ encryption: true, passphrase: "correct horse battery", compression: true });

        // Meta on the remote records the chosen codec (and is itself plaintext).
        const meta = await fetchVaultMeta(h.adminClient);
        expect(meta?.encryption.enabled).toBe(true);
        expect(meta?.compression.enabled).toBe(true);

        // Wrong passphrase → clone rejected before any vault write.
        const bad = h.addDevice("dev-bad");
        await expect(bad.runClone({ passphrase: "wrong passphrase" })).rejects.toThrow(/passphrase/i);
        expect(await bad.vault.exists("notes/n1.md")).toBe(false);

        // Correct passphrase → clone rebuilds the vault byte-for-byte.
        const b = h.addDevice("dev-B");
        await b.runClone({ passphrase: "correct horse battery" });
        expect(b.vault.readText("notes/n1.md")).toBe("first note");
        expect(b.vault.readText("notes/n2.md")).toBe("second note ".repeat(50));
        expect(bytesEqual(await b.vault.readBinary("attach/blob.bin"), blob.buffer)).toBe(true);
    });

    it("plaintext (no encryption, no compression): A inits, B clones without a passphrase", async () => {
        const a = h.addDevice("a2");
        a.vault.addFile("plain.md", "no crypto here");
        await a.runInit({ encryption: false, compression: false });

        const meta = await fetchVaultMeta(h.adminClient);
        expect(meta?.encryption.enabled).toBe(false);
        expect(meta?.compression.enabled).toBe(false);

        const b = h.addDevice("b2");
        await b.runClone(); // no passphrase needed
        expect(b.vault.readText("plain.md")).toBe("no crypto here");
    });

    it("Clone counts the files it wrote, not deletions or files kept out by the filter", async () => {
        const a = h.addDevice("a3");
        a.vault.addFile("keep/one.md", "one");
        a.vault.addFile("keep/two.md", "two");
        a.vault.addFile("gone.md", "deleted before the clone");
        a.vault.addFile("private/secret.md", "filtered on the cloning device");
        await a.runInit({ encryption: false, compression: false });
        await a.vault.delete("gone.md");
        await a.vs.markDeleted("gone.md");
        await a.engine.start();
        await waitFor(async () => (await h.adminClient.getDoc<{ deleted?: boolean }>(makeFileId("gone.md")))?.deleted === true, {
            label: "tombstone pushed",
        });
        await a.engine.stop();

        const b = h.addDevice("b3", { syncIgnore: "^private/" });
        const summary = await b.runClone();
        expect(summary).toBe("2 files written.");
        expect(b.progress).toContain("Writing 2 vault files...");
        expect(b.progress.filter((m) => m.startsWith("Writing: "))).toEqual([
            expect.stringMatching(/\(1\/2\)$/), expect.stringMatching(/\(2\/2\)$/),
        ]);
        expect(b.vault.getFiles().map((f) => f.path).sort()).toEqual(["keep/one.md", "keep/two.md"]);
    });

    it("Init counts the files it pushed, not files kept out by the filter", async () => {
        const a = h.addDevice("a4", { syncIgnore: "^private/" });
        a.vault.addFile("keep/one.md", "one");
        a.vault.addFile("keep/two.md", "two");
        a.vault.addFile("private/secret.md", "kept out on the initialising device");
        const summary = await a.runInit({ encryption: false, compression: false });
        expect(summary).toMatch(/^2 files, \d+ docs pushed\.$/);
        expect(await h.adminClient.getDoc(makeFileId("private/secret.md"))).toBeNull();
    });
});
