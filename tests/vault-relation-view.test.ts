import { describe, it, expect } from "vitest";
import {
    cloneDescription, encryptionChangedElsewhere, vaultRelationView,
} from "../src/settings-tab/vault-relation-view.ts";
import {
    VaultEncryptionPausedError, type VaultOutcome, type VaultRelation,
} from "../src/sync/vault-binding.ts";
import { AuthBlockedError } from "../src/db/sync/auth-gate.ts";
import { UserFacingError } from "../src/ui/describe-error.ts";

function rel(patch: Partial<VaultRelation> = {}): VaultRelation {
    return {
        state: "tested", serverTested: true, busy: null,
        lastOp: null, pause: null, dbCheck: null, ...patch,
    };
}

function outcome(patch: Partial<VaultOutcome> = {}): VaultOutcome {
    return { op: "clone", at: 1, against: "t", error: null, ...patch };
}

describe("vaultRelationView", () => {
    it("asks for the CouchDB tab and Step 2 first", () => {
        expect(vaultRelationView(rel({ serverTested: false }), null).text).toMatch(/CouchDB tab/);
        expect(vaultRelationView(rel({ state: "editing" }), null).text).toBe("Complete Step 2 first.");
    });

    it("a running Init or Clone comes before anything recorded", () => {
        const v = vaultRelationView(rel({ busy: "clone", lastOp: outcome({ error: new Error("x") }) }), null);
        expect(v).toEqual({ text: "Clone is running…", tone: null });
    });

    it("the auth latch comes before a recorded failure", () => {
        const v = vaultRelationView(rel({ lastOp: outcome({ error: new Error("x") }) }), new AuthBlockedError(null));
        expect(v.tone).toBe("error");
        expect(v.text).toMatch(/rejected the credentials/);
    });

    it("an encryption pause says why sync stopped, instead of the generic setup line", () => {
        const pause = new VaultEncryptionPausedError("encryption-changed", { remoteEncrypted: true });
        const v = vaultRelationView(rel({ pause: { at: 1, error: pause } }), null);
        expect(v.tone).toBe("error");
        expect(v.text).toBe(`Last server check: ${pause.userMessage}`);
    });

    it("a failed Clone in its preparation is shown with the unchanged state", () => {
        const v = vaultRelationView(rel({
            state: "setupDone",
            lastOp: outcome({ error: new UserFacingError("The passphrase does not unlock.") }),
        }), null);
        expect(v).toEqual({ text: "Last Clone: The passphrase does not unlock.", tone: "error" });
    });

    it("a failure that left settingUp also says the setup did not finish", () => {
        const v = vaultRelationView(rel({
            state: "settingUp", lastOp: outcome({ op: "init", error: new UserFacingError("disk full.") }),
        }), null);
        expect(v.text).toMatch(/^Last Init: disk full\. Setup did not finish/);
    });

    it("shows the newer of a failed operation and a pause", () => {
        const pause = new VaultEncryptionPausedError("legacy-meta");
        const newerPause = vaultRelationView(rel({
            lastOp: outcome({ at: 5, error: new UserFacingError("op") }),
            pause: { at: 9, error: pause },
        }), null);
        expect(newerPause.text).toBe(`Last server check: ${pause.userMessage}`);
        const newerOp = vaultRelationView(rel({
            lastOp: outcome({ at: 9, error: new UserFacingError("op") }),
            pause: { at: 5, error: pause },
        }), null);
        expect(newerOp.text).toBe("Last Clone: op");
    });

    it("without failures, the state speaks", () => {
        expect(vaultRelationView(rel({ state: "settingUp" }), null).text).toMatch(/^Setup did not finish/);
        expect(vaultRelationView(rel(), null).text).toBe("Choose how to initialize this vault.");
        expect(vaultRelationView(rel({ state: "setupDone" }), null).tone).toBe("ok");
        expect(vaultRelationView(rel({ state: "syncing" }), null).text).toMatch(/^Live sync is on/);
    });
});

describe("cloneDescription", () => {
    const check = (result: any) => ({ at: 1, against: "t", result });
    const ready = "Pull remote database to local vault (2nd+ device)";

    it("without a finding, after a failed check, or for a DB with documents, describes Clone", () => {
        expect(cloneDescription(null)).toBe(ready);
        expect(cloneDescription(check({ status: "error", error: new Error("x") }))).toBe(ready);
        expect(cloneDescription(check({ status: "exists", docCount: 3 }))).toBe(ready);
    });

    it("a DB found empty or new points to Init, and says Clone reads it again", () => {
        for (const result of [{ status: "exists", docCount: 0 }, { status: "created" }]) {
            const d = cloneDescription(check(result));
            expect(d).toMatch(/empty when last read — use Init/);
            expect(d).toMatch(/Clone reads it again/);
        }
    });
});

describe("encryptionChangedElsewhere", () => {
    it("only for a pause because another device changed encryption", () => {
        const changed = new VaultEncryptionPausedError("encryption-changed", { remoteEncrypted: false });
        const wrong = new VaultEncryptionPausedError("passphrase-mismatch");
        expect(encryptionChangedElsewhere(rel({ pause: { at: 1, error: changed } }))).toBe(true);
        expect(encryptionChangedElsewhere(rel({ pause: { at: 1, error: wrong } }))).toBe(false);
        expect(encryptionChangedElsewhere(rel())).toBe(false);
    });
});
