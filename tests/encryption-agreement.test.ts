import { describe, it, expect } from "vitest";
import { FakeCouchClient } from "./helpers/fake-couch-client.ts";
import { checkEncryptionAgreement } from "../src/db/encryption-agreement.ts";
import { VAULT_META_DOC_ID, type VaultMetaDoc } from "../src/db/vault-meta.ts";

function metaDoc(cipherVersion: 2 | 3): VaultMetaDoc {
    return {
        _id: VAULT_META_DOC_ID,
        type: "vault-meta",
        schemaVersion: 2,
        encryption: {
            enabled: true,
            kdfVersion: 1,
            cipherVersion,
            salt: "c2FsdA==",
            keyCheck: "x",
        },
        compression: { enabled: false },
    };
}

async function seed(cipherVersion: 2 | 3): Promise<FakeCouchClient> {
    const inner = new FakeCouchClient();
    await inner.bulkDocs([metaDoc(cipherVersion)]);
    return inner;
}

describe("checkEncryptionAgreement — cipherVersion non-downgrade gate", () => {
    it("flags a remote downgrade below the local floor (#1)", async () => {
        // Local device recorded floor 3; a curious server rewrote meta to v2.
        const client = await seed(2);
        const res = await checkEncryptionAgreement(client, true, VAULT_META_DOC_ID, 3);
        expect(res.status).toBe("cipher-downgrade-detected");
        if (res.status === "cipher-downgrade-detected") {
            expect(res.localFloor).toBe(3);
        }
    });

    it("accepts remote == floor", async () => {
        const client = await seed(3);
        const res = await checkEncryptionAgreement(client, true, VAULT_META_DOC_ID, 3);
        expect(res.status).toBe("agreed-encrypted");
    });

    it("accepts remote > floor (legit forward upgrade)", async () => {
        const client = await seed(3);
        const res = await checkEncryptionAgreement(client, true, VAULT_META_DOC_ID, 2);
        expect(res.status).toBe("agreed-encrypted");
    });

    it("legit v2 vault with floor 2 is not a downgrade", async () => {
        const client = await seed(2);
        const res = await checkEncryptionAgreement(client, true, VAULT_META_DOC_ID, 2);
        expect(res.status).toBe("agreed-encrypted");
    });

    it("undefined floor (first observation) skips the gate", async () => {
        const client = await seed(2);
        const res = await checkEncryptionAgreement(client, true, VAULT_META_DOC_ID, undefined);
        expect(res.status).toBe("agreed-encrypted");
    });
});
