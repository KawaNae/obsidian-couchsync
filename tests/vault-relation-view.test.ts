import { describe, it, expect } from "vitest";
import {
    cloneAvailability, encryptionChangedElsewhere, vaultRelationView,
} from "../src/settings-tab/vault-relation-view.ts";
import {
    VaultEncryptionPausedError, type VaultOutcome, type VaultRelation,
} from "../src/sync/vault-binding.ts";
import { AuthBlockedError } from "../src/db/sync/auth-gate.ts";
import { UserFacingError } from "../src/ui/describe-error.ts";

function rel(patch: Partial<VaultRelation> = {}): VaultRelation {
    return {
        state: "tested", serverTested: true, busy: null,
        lastOp: null, lastCheck: null, dbCheck: null, ...patch,
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
        const v = vaultRelationView(rel({ lastCheck: outcome({ op: "agreement", error: pause }) }), null);
        expect(v.tone).toBe("error");
        expect(v.text).toBe(`Last encryption check: ${pause.userMessage}`);
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

    it("shows the newer of a failed operation and a failed check", () => {
        const v = vaultRelationView(rel({
            lastOp: outcome({ at: 5, error: new UserFacingError("op") }),
            lastCheck: outcome({ op: "agreement", at: 9, error: new UserFacingError("check") }),
        }), null);
        expect(v.text).toBe("Last encryption check: check");
    });

    it("without failures, the state speaks", () => {
        expect(vaultRelationView(rel({ state: "settingUp" }), null).text).toMatch(/^Setup did not finish/);
        expect(vaultRelationView(rel(), null).text).toBe("Choose how to initialize this vault.");
        expect(vaultRelationView(rel({ state: "setupDone" }), null).tone).toBe("ok");
        expect(vaultRelationView(rel({ state: "syncing" }), null).text).toMatch(/^Live sync is on/);
    });
});

describe("cloneAvailability", () => {
    const check = (result: any) => ({ at: 1, against: "t", result });

    it("without a check, asks for one instead of calling the DB empty", () => {
        const c = cloneAvailability(null, true);
        expect(c.enabled).toBe(false);
        expect(c.desc).toMatch(/Press Check in Step 2/);
        expect(c.desc).not.toMatch(/empty/);
    });

    it("an empty or new DB points to Init; a failed check to Step 2", () => {
        expect(cloneAvailability(check({ status: "exists", docCount: 0 }), true).desc).toMatch(/empty/);
        expect(cloneAvailability(check({ status: "created" }), true).desc).toMatch(/empty/);
        expect(cloneAvailability(check({ status: "error", error: new Error("x") }), true).desc).toMatch(/check failed/);
    });

    it("a DB with documents enables Clone when the setup state allows it", () => {
        expect(cloneAvailability(check({ status: "exists", docCount: 3 }), true).enabled).toBe(true);
        expect(cloneAvailability(check({ status: "exists", docCount: 3 }), false).enabled).toBe(false);
    });
});

describe("encryptionChangedElsewhere", () => {
    it("only for a pause because another device changed encryption", () => {
        const changed = new VaultEncryptionPausedError("encryption-changed", { remoteEncrypted: false });
        const wrong = new VaultEncryptionPausedError("passphrase-mismatch");
        expect(encryptionChangedElsewhere(rel({ lastCheck: outcome({ op: "agreement", error: changed }) }))).toBe(true);
        expect(encryptionChangedElsewhere(rel({ lastCheck: outcome({ op: "agreement", error: wrong }) }))).toBe(false);
        expect(encryptionChangedElsewhere(rel())).toBe(false);
    });
});
