/**
 * E2E: Init + Clone through the real SetupService + real CouchDB.
 *
 * Init builds vault:meta (deriving crypto when encryption is on) and pushes
 * the whole vault through the real codec stack; Clone fetches the meta,
 * unlocks with the passphrase, pulls everything and rebuilds the vault. This
 * is the setup path real devices run on day one — and the one the migration
 * incident lived on. Asserts the vault reconstructs byte-for-byte, the meta
 * records the chosen codec, and a wrong passphrase is rejected.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createE2EHarness, bytesEqual, type E2EHarness } from "./couch-harness.ts";
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
});
