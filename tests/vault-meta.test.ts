import { describe, it, expect } from "vitest";
import {
    VAULT_META_DOC_ID,
    buildInitialVaultMeta,
    fetchVaultMeta,
    pushVaultMeta,
    unlockVaultMeta,
    type VaultMetaDoc,
} from "../src/db/vault-meta.ts";
import { FakeCouchClient } from "./helpers/fake-couch-client.ts";

describe("vault:meta v2", () => {
    it("Init builds a meta doc with the requested encryption + compression flags", async () => {
        const r1 = await buildInitialVaultMeta({
            encryption: true, passphrase: "pass", compression: true,
        });
        expect(r1.meta._id).toBe(VAULT_META_DOC_ID);
        expect(r1.meta.encryption.enabled).toBe(true);
        expect(r1.meta.compression.enabled).toBe(true);
        if (r1.meta.compression.enabled) {
            expect(r1.meta.compression.algorithm).toBe("gzip");
        }
        expect(r1.keys).not.toBeNull();
        expect(r1.crypto).not.toBeNull();

        const r2 = await buildInitialVaultMeta({
            encryption: false, compression: true,
        });
        expect(r2.meta.encryption.enabled).toBe(false);
        expect(r2.meta.compression.enabled).toBe(true);
        expect(r2.keys).toBeNull();
        expect(r2.crypto).toBeNull();

        const r3 = await buildInitialVaultMeta({
            encryption: true, passphrase: "pass", compression: false,
        });
        expect(r3.meta.encryption.enabled).toBe(true);
        expect(r3.meta.compression.enabled).toBe(false);

        const r4 = await buildInitialVaultMeta({
            encryption: false, compression: false,
        });
        expect(r4.meta.encryption.enabled).toBe(false);
        expect(r4.meta.compression.enabled).toBe(false);
    });

    it("Init with encryption=true and no passphrase throws", async () => {
        await expect(buildInitialVaultMeta({
            encryption: true, compression: true,
        })).rejects.toThrow(/passphrase required/);
    });

    it("push + fetch round-trips through the client", async () => {
        const client = new FakeCouchClient();
        const { meta } = await buildInitialVaultMeta({
            encryption: false, compression: true,
        });
        await pushVaultMeta(client, meta);

        const back = await fetchVaultMeta(client);
        expect(back).not.toBeNull();
        expect(back!._id).toBe(VAULT_META_DOC_ID);
        expect(back!.encryption.enabled).toBe(false);
        expect(back!.compression.enabled).toBe(true);
    });

    it("fetchVaultMeta returns null when no doc exists", async () => {
        const client = new FakeCouchClient();
        expect(await fetchVaultMeta(client)).toBeNull();
    });

    it("unlockVaultMeta succeeds with the right passphrase, fails otherwise", async () => {
        const { meta } = await buildInitialVaultMeta({
            encryption: true, passphrase: "correct", compression: true,
        });
        const ok = await unlockVaultMeta(meta, "correct");
        expect(ok).not.toBeNull();

        const bad = await unlockVaultMeta(meta, "wrong");
        expect(bad).toBeNull();
    });

    it("unlockVaultMeta on a plaintext vault returns null (no crypto to derive)", async () => {
        const { meta } = await buildInitialVaultMeta({
            encryption: false, compression: false,
        });
        const r = await unlockVaultMeta(meta as VaultMetaDoc, "any");
        expect(r).toBeNull();
    });

    it("ignores a stale/forged metaHmac field — keyCheck is the sole verifier", async () => {
        // metaHmac was removed (it was a fast offline-guessing oracle).
        // A meta doc carrying a leftover/garbage metaHmac from an older
        // dev build must still unlock purely via keyCheck.
        const { meta } = await buildInitialVaultMeta({
            encryption: true, passphrase: "correct", compression: false,
        });
        (meta.encryption as Record<string, unknown>).metaHmac = "deadbeef";

        const ok = await unlockVaultMeta(meta, "correct");
        expect(ok).not.toBeNull();

        const bad = await unlockVaultMeta(meta, "wrong");
        expect(bad).toBeNull();
    });
});
