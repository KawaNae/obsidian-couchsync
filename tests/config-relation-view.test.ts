/**
 * configRelationView — the Config Sync tab's Step 3 status line.
 *
 * The line used to evaluate "not joined" before the last result, so a Join
 * that failed on a wrong passphrase still read "Not joined yet. First
 * device: Create. …". The priority is now fixed in one pure function.
 */
import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { configRelationView } from "../src/settings-tab/config-relation-view.ts";
import type { ConfigOutcome, ConfigRelation } from "../src/sync/config-binding.ts";
import { configNotReady } from "../src/sync/config-errors.ts";
import { AuthGate } from "../src/db/sync/auth-gate.ts";
import { ConfigBinding } from "../src/sync/config-binding.ts";
import { ConfigLocalDB } from "../src/db/config-local-db.ts";
import { makeSettings } from "./helpers/settings-factory.ts";
import { putAttachment } from "./helpers/config-attach.ts";

const ATT = { codec: { encryption: true, compression: false }, metaFingerprint: "sha256:aa" };

function rel(patch: Partial<ConfigRelation> = {}): ConfigRelation {
    return { dbName: "cfg", attachment: ATT, settingUp: false, lastOp: null, lastCheck: null, ...patch };
}

function outcome(patch: Partial<ConfigOutcome> = {}): ConfigOutcome {
    return { op: "pull", at: 1, against: ATT.metaFingerprint, error: null, ...patch };
}

function authError(): unknown {
    const g = new AuthGate();
    g.raise(401, "nope");
    return g.blockedError();
}

const failed = outcome({ error: new TypeError("Failed to fetch") });

describe("configRelationView — priority", () => {
    it("1. disabled wins over everything", () => {
        const v = configRelationView({ enabled: false, relation: rel({ lastOp: failed }) }, authError());
        expect(v).toEqual({ text: "Apply a config database name in Step 2 first.", tone: null });
    });

    it("2. a store that could not be opened", () => {
        const v = configRelationView({ enabled: true, relation: null }, authError());
        expect(v.tone).toBe("error");
        expect(v.text).toMatch(/local config store could not be opened/);
    });

    it("3. the auth latch comes before the relation", () => {
        const v = configRelationView(
            { enabled: true, relation: rel({ settingUp: true, lastOp: failed }) }, authError(),
        );
        expect(v.tone).toBe("error");
        expect(v.text).toMatch(/rejected the credentials \(401\).*CouchDB tab/);
    });

    it("4. an unfinished Create comes before the last failure", () => {
        const v = configRelationView({ enabled: true, relation: rel({ settingUp: true, lastOp: failed }) }, null);
        expect(v.tone).toBe("error");
        expect(v.text).toMatch(/Create was interrupted/);
    });

    it("5. the last failure, worded with its cause and fix", () => {
        const v = configRelationView({ enabled: true, relation: rel({ lastOp: failed }) }, null);
        expect(v.tone).toBe("error");
        expect(v.text).toMatch(/^Last Pull: The server could not be reached.*\(Failed to fetch\)$/);
    });

    it("5. also when not joined: a failed Join says why", () => {
        const err = configNotReady("passphrase-mismatch", { db: "cfg" });
        const v = configRelationView({
            enabled: true,
            relation: rel({ attachment: null, lastOp: outcome({ op: "join", against: null, error: err }) }),
        }, null);
        expect(v).toEqual({ text: `Last Join: ${err.message}`, tone: "error" });
        expect(v.text).not.toMatch(/\bCreate\b/);
    });

    it("5. a failed check is shown too", () => {
        const v = configRelationView({
            enabled: true, relation: rel({ lastCheck: outcome({ op: "check", error: new Error("boom") }) }),
        }, null);
        expect(v.text).toBe("Last check: boom");
    });

    it("6. not joined", () => {
        const v = configRelationView({ enabled: true, relation: rel({ attachment: null }) }, null);
        expect(v).toEqual({ text: "Not joined yet. First device: Create. Other devices: Join.", tone: null });
    });

    it("5. a failed operation is shown although a later check succeeded", () => {
        const v = configRelationView({
            enabled: true,
            relation: rel({
                lastOp: outcome({ op: "push", at: 1, error: new TypeError("Failed to fetch") }),
                lastCheck: outcome({ op: "check", at: 2 }),
            }),
        }, null);
        expect(v.tone).toBe("error");
        expect(v.text).toMatch(/^Last Push: The server could not be reached/);
    });

    it("5. when the operation and the check both failed, the later one is shown", () => {
        const push = outcome({ op: "push", at: 1, error: new Error("write refused") });
        const check = outcome({ op: "check", at: 2, error: new Error("list refused") });
        expect(configRelationView({ enabled: true, relation: rel({ lastOp: push, lastCheck: check }) }, null).text)
            .toBe("Last check: list refused");
        expect(configRelationView({
            enabled: true, relation: rel({ lastOp: { ...push, at: 3 }, lastCheck: check }),
        }, null).text).toBe("Last Push: write refused");
    });

    it("7. the last success: ready", () => {
        const v = configRelationView({ enabled: true, relation: rel({ lastOp: outcome() }) }, null);
        expect(v).toEqual({ text: 'Joined "cfg" — ready to Push and Pull.', tone: "ok" });
    });

    it("7. a successful check alone is enough for ready", () => {
        const v = configRelationView({ enabled: true, relation: rel({ lastCheck: outcome({ op: "check" }) }) }, null);
        expect(v.tone).toBe("ok");
    });

    it("8. joined, nothing checked yet", () => {
        const v = configRelationView({ enabled: true, relation: rel() }, null);
        expect(v.tone).toBeNull();
        expect(v.text).toMatch(/^Joined "cfg"\. The server has not been checked/);
    });
});

describe("ConfigBinding.relation / record", () => {
    async function openBinding(att: typeof ATT | null) {
        const settings = makeSettings({ couchdbUri: "http://localhost:5984", couchdbConfigDbName: "cfg" });
        const store = new ConfigLocalDB(`relation-${Date.now()}-${Math.random()}`);
        store.open();
        if (att) await putAttachment(store, att);
        const binding = await ConfigBinding.open(
            "v", settings.couchdbUri, "cfg",
            { getSettings: () => settings, saveSettings: async () => {} },
            () => store,
        );
        return { binding, store };
    }

    it("drops an outcome evaluated against another attachment", async () => {
        const { binding, store } = await openBinding(ATT);
        binding.record(outcome({ against: "sha256:other", error: new Error("old root") }));
        binding.record(outcome({ op: "check", against: "sha256:other", error: new Error("old root") }));
        expect(binding.relation()).toMatchObject({ lastOp: null, lastCheck: null });
        binding.record(outcome({ at: 2 }));
        expect(binding.relation().lastOp).toMatchObject({ at: 2, error: null });
        await binding.close();
        await store.destroy();
    });

    it("a failed Push stays after a later check succeeds", async () => {
        const { binding, store } = await openBinding(ATT);
        const err = new TypeError("Failed to fetch");
        binding.record(outcome({ op: "push", at: 10, error: err }));
        binding.record(outcome({ op: "check", at: 20 }));
        const r = binding.relation();
        expect(r.lastOp).toMatchObject({ op: "push", error: err });
        expect(configRelationView({ enabled: true, relation: r }, null).text).toMatch(/^Last Push: /);
        await binding.close();
        await store.destroy();
    });

    it("a failed Push is cleared by a later Push that succeeds", async () => {
        const { binding, store } = await openBinding(ATT);
        binding.record(outcome({ op: "push", at: 10, error: new Error("boom") }));
        binding.record(outcome({ op: "push", at: 20 }));
        expect(configRelationView({ enabled: true, relation: binding.relation() }, null))
            .toEqual({ text: 'Joined "cfg" — ready to Push and Pull.', tone: "ok" });
        await binding.close();
        await store.destroy();
    });

    it("a failed check is cleared by a later operation that succeeds, not by an earlier one", async () => {
        const { binding, store } = await openBinding(ATT);
        binding.record(outcome({ op: "pull", at: 5 }));
        binding.record(outcome({ op: "check", at: 10, error: new Error("list refused") }));
        expect(binding.relation().lastCheck).toMatchObject({ error: expect.any(Error) });
        binding.record(outcome({ op: "pull", at: 20 }));
        expect(binding.relation().lastCheck).toBeNull();
        expect(configRelationView({ enabled: true, relation: binding.relation() }, null).tone).toBe("ok");
        await binding.close();
        await store.destroy();
    });

    it("a failed check is cleared by a later check that succeeds", async () => {
        const { binding, store } = await openBinding(ATT);
        binding.record(outcome({ op: "check", at: 10, error: new Error("list refused") }));
        binding.record(outcome({ op: "check", at: 20 }));
        expect(binding.relation().lastCheck).toMatchObject({ at: 20, error: null });
        await binding.close();
        await store.destroy();
    });

    it("keeps the outcome that started last: an overtaken check does not overwrite an op", async () => {
        const { binding, store } = await openBinding(ATT);
        binding.record(outcome({ op: "push", at: 20 }));
        // A check that started before the Push finishes after it.
        binding.record(outcome({ op: "check", at: 10, error: new Error("stale") }));
        binding.record(outcome({ op: "pull", at: 15, error: new Error("stale op") }));
        expect(binding.relation().lastOp).toMatchObject({ op: "push", at: 20, error: null });
        await binding.close();
        await store.destroy();
    });

    it("an unattached binding matches outcomes recorded against no attachment", async () => {
        const { binding, store } = await openBinding(null);
        const err = configNotReady("passphrase-mismatch", { db: "cfg" });
        binding.record(outcome({ op: "join", against: null, error: err }));
        expect(binding.relation()).toMatchObject({ attachment: null, lastOp: { op: "join", error: err } });
        await binding.close();
        await store.destroy();
    });
});
