import { describe, it, expect } from "vitest";
import { describeVaultSetupConfirm } from "../src/sync/vault-setup-confirm.ts";

describe("describeVaultSetupConfirm", () => {
    it("Init: names the DB it deletes, what it holds, the codec, and that other devices Clone again", () => {
        const c = describeVaultSetupConfirm({
            op: "init", dbName: "vault-a", docCount: 1234, encryption: true, compression: false,
        });
        expect(c.title).toBe('Init vault database "vault-a"?');
        expect(c.confirmText).toBe("Init");
        expect(c.message).toContain('deletes the vault database "vault-a" on the server');
        expect(c.message).toContain(`${(1234).toLocaleString()} documents. All of them will be deleted.`);
        expect(c.message).toContain("encryption on, compression off");
        expect(c.message).toMatch(/must Clone again/);
        expect(c.message).toMatch(/stops its live sync/);
    });

    it("Init: a missing DB and an empty DB say so instead of a count", () => {
        const base = { op: "init", dbName: "v", encryption: false, compression: true } as const;
        expect(describeVaultSetupConfirm({ ...base, docCount: null }).message)
            .toContain("the database does not exist yet. Init creates it.");
        expect(describeVaultSetupConfirm({ ...base, docCount: 0 }).message)
            .toContain("On the server now: no documents.");
    });

    it("Clone: rebuilds the local DB from the server's and writes its files; the server is not changed", () => {
        const c = describeVaultSetupConfirm({
            op: "clone", dbName: "vault-a", docCount: 1, encryption: false, compression: true,
        });
        expect(c.title).toBe('Clone vault database "vault-a"?');
        expect(c.confirmText).toBe("Clone");
        expect(c.message).toContain('from "vault-a" on the server (1 document, encryption off, compression on)');
        expect(c.message).toMatch(/writes the server's files into this vault/);
        expect(c.message).toContain("The database on the server is not changed.");
    });

    it("paragraphs are separated by a blank line, as the confirm dialog splits them", () => {
        const c = describeVaultSetupConfirm({
            op: "clone", dbName: "v", docCount: 2, encryption: true, compression: true,
        });
        expect(c.message.split(/\n\s*\n/)).toHaveLength(3);
    });
});
