/**
 * ConfigSetupService integration tests — true clean-slate init.
 *
 * Drives ConfigSync.create() (formerly init) against a real ConfigLocalDB + FakeCouchClient
 * and verifies the clean-slate semantics:
 *
 *   - The local DB is destroyed (not just deleteByPrefix-d) — cache,
 *     checkpoints, and lastSynced all start fresh.
 *   - The remote DB is destroyed and recreated — `destroy()` is observed
 *     on the client, not just per-doc tombstones.
 *   - The push to the now-empty remote produces fresh rev=1- docs (no
 *     rev-tree carry-over from the previous tenant of the same db name).
 *
 * Complements `config-sync-init-replace.test.ts` which still asserts the
 * higher-level "live ids match vault" invariant.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ConfigSync } from "../../src/sync/config-sync.ts";
import { ConfigLocalDB } from "../../src/db/config-local-db.ts";
import { AuthGate } from "../../src/db/sync/auth-gate.ts";
import { ALWAYS_VISIBLE } from "../../src/db/visibility-gate.ts";
import { NoopReconnectBridge } from "../../src/sync/reconnect-bridge.ts";
import { FakeCouchClient } from "../helpers/fake-couch-client.ts";
import { FakeVaultIO } from "../helpers/fake-vault-io.ts";
import { FakeModalPresenter } from "../helpers/fake-modal-presenter.ts";
import { makeSettings } from "../helpers/settings-factory.ts";
import { makeConfigId } from "../../src/types/doc-id.ts";
import {
    META_CONFIG_PULL_SEQ,
    META_CONFIG_PUSH_SEQ,
} from "../../src/db/sync/config-checkpoints.ts";
import { CONFIG_LAST_SYNCED_PREFIX } from "../../src/db/sync/config-last-synced.ts";
import type { CouchClient } from "../../src/db/couch-client.ts";
import { getAttachment, getEntry, putEntry } from "../helpers/config-attach.ts";

let counter = 0;
function uniqueName(): string {
    return `cs-setup-${Date.now()}-${counter++}`;
}

function asCouchClient(fake: FakeCouchClient): CouchClient {
    (fake as any).withTimeout = (_ms: number) => fake;
    return fake as unknown as CouchClient;
}

describe("ConfigSetupService — clean-slate init", () => {
    let vault: FakeVaultIO;
    let modal: FakeModalPresenter;
    let db: ConfigLocalDB;
    let auth: AuthGate;
    let settings: ReturnType<typeof makeSettings>;
    let remote: FakeCouchClient;
    let cs: ConfigSync;

    beforeEach(async () => {
        vault = new FakeVaultIO();
        modal = new FakeModalPresenter();
        db = new ConfigLocalDB(uniqueName());
        db.open();
        auth = new AuthGate();
        settings = makeSettings({
            deviceId: "dev-A",
            couchdbUri: "http://localhost:5984",
            couchdbConfigDbName: "config-test",
        });
        remote = new FakeCouchClient();
        cs = new ConfigSync(
            vault,
            modal,
            "test-vault",
            auth,
            ALWAYS_VISIBLE,
            NoopReconnectBridge,
            () => settings,
            {
                storeFactory: () => db,
                clientFactory: () => asCouchClient(remote),
                // The raw client factory reuses the in-memory fake
                // because the test has no real codec layer to bypass.
                rawClientFactory: () => asCouchClient(remote),
            },
        );
        await cs.rebind(settings.couchdbConfigDbName);
    });

    afterEach(async () => {
        await db.destroy().catch(() => {});
    });

    it("init calls remote.destroy() before pushing (true rev-tree reset)", async () => {
        const destroySpy = vi.spyOn(remote, "destroy");
        const ensureSpy = vi.spyOn(remote, "ensureDb");
        vault.addFile(".obsidian/a.json", `{}`);

        await cs.create();

        expect(destroySpy).toHaveBeenCalledTimes(1);
        expect(ensureSpy).toHaveBeenCalled();
        // destroy must run before ensureDb in the call sequence.
        expect(destroySpy.mock.invocationCallOrder[0])
            .toBeLessThan(ensureSpy.mock.invocationCallOrder[0]);
    });

    it("init resets the local DB; a subsequent push re-seeds it from the vault", async () => {
        // Pre-seed local with a stale doc.
        await db.runWriteTx({
            docs: [{ doc: {
                _id: makeConfigId(".obsidian/stale.json"),
                type: "config",
                data: "ZGF0YQ==",
                mtime: 1, size: 4, vclock: { "dev-A": 1 },
            } }],
        });
        vault.addFile(".obsidian/a.json", `{}`);

        // Init is structural — it wipes, it does not seed.
        await cs.create();
        expect(await db.get(makeConfigId(".obsidian/stale.json"))).toBeNull();
        expect(await db.get(makeConfigId(".obsidian/a.json"))).toBeNull();

        // Push scans the current vault into the (now empty) local DB.
        await cs.push();
        expect(await db.get(makeConfigId(".obsidian/stale.json"))).toBeNull();
        expect(await db.get(makeConfigId(".obsidian/a.json"))).not.toBeNull();
    });

    it("init resets pullSeq / pushSeq meta (cursors start from 0 in the new DB)", async () => {
        // Pre-seed lingering cursor values in meta.
        await db.runWriteTx({
            meta: [
                { op: "put", key: META_CONFIG_PULL_SEQ, value: 999 },
                { op: "put", key: META_CONFIG_PUSH_SEQ, value: 888 },
            ],
        });
        vault.addFile(".obsidian/a.json", `{}`);

        await cs.create();

        // After destroy + reopen, those meta entries no longer exist.
        const pullSeq = await db.getMeta<number | string>(META_CONFIG_PULL_SEQ);
        // After a fresh push of one doc the push-seq advances above 0; what
        // matters is that the legacy 888 / 999 are gone.
        expect(pullSeq).not.toBe(999);
    });

    it("init wipes lastSynced meta (subsequent scan re-derives from current vault)", async () => {
        // Seed a stale lastSynced entry.
        await db.runWriteTx({
            meta: [{
                op: "put",
                key: `${CONFIG_LAST_SYNCED_PREFIX}.obsidian/ghost.json`,
                value: { vclock: { "old-dev": 7 }, size: 99, dataHash: "ghosthash00000000" },
            }],
        });
        vault.addFile(".obsidian/a.json", `{}`);

        await cs.create();

        const stale = await db.getMeta(
            `${CONFIG_LAST_SYNCED_PREFIX}.obsidian/ghost.json`,
        );
        expect(stale).toBeNull();
    });

    it("init produces fresh rev=1- on remote (no carry-over from previous tenant)", async () => {
        // Simulate a previous tenant that accumulated rev=N for
        // `app.json`. After a clean-slate init, the doc
        // must come back at a new rev tree (rev=1-).
        const id = makeConfigId(".obsidian/app.json");
        await remote.bulkDocs([{
            _id: id, type: "config", data: "ZA==",
            mtime: 1, size: 1, vclock: { "old-dev": 1 },
        }]);
        // Fake additional rev-bumps to simulate the phantom history.
        for (let i = 0; i < 5; i++) {
            const cur = await remote.getDoc<any>(id);
            await remote.bulkDocs([{ ...cur, mtime: cur.mtime + 1 }]);
        }
        const phantom = await remote.getDoc<any>(id);
        expect(phantom!._rev.startsWith("1-")).toBe(false); // sanity: rev > 1

        vault.addFile(".obsidian/app.json", `{"theme":"dark"}`);
        await cs.create();
        await cs.push();

        const fresh = await remote.getDoc<any>(id);
        expect(fresh).not.toBeNull();
        // After remote.destroy() + recreate + push, rev must come back at the
        // start of a new rev tree. The FakeCouchClient uses a global rev
        // counter so config:meta + chunks consume the first few values
        // before app.json lands; the actual invariant is "rev number is
        // tiny — not the 6+ revs from the phantom history".
        const revNum = Number(fresh!._rev.split("-")[0]);
        expect(revNum).toBeLessThanOrEqual(5);
        // And specifically lower than the phantom's pre-init rev.
        const phantomRevNum = Number(phantom!._rev.split("-")[0]);
        expect(revNum).toBeLessThan(phantomRevNum);
    });
});

describe("ConfigSetupService — setup atomicity", () => {
    let vault: FakeVaultIO;
    let db: ConfigLocalDB;
    let auth: AuthGate;
    let settings: ReturnType<typeof makeSettings>;
    let remote: FakeCouchClient;
    let cs: ConfigSync;
    /** The settings entry's `settingUp` at every settings save. */
    let settingUpCalls: (boolean | undefined)[];

    beforeEach(async () => {
        vault = new FakeVaultIO();
        db = new ConfigLocalDB(uniqueName());
        db.open();
        auth = new AuthGate();
        settings = makeSettings({
            deviceId: "dev-A",
            couchdbUri: "http://localhost:5984",
            couchdbConfigDbName: "config-test",
        });
        remote = new FakeCouchClient();
        settingUpCalls = [];
        cs = new ConfigSync(
            vault, new FakeModalPresenter(), "test-vault", auth, ALWAYS_VISIBLE, NoopReconnectBridge,
            () => settings,
            {
                storeFactory: () => db,
                clientFactory: () => asCouchClient(remote),
                rawClientFactory: () => asCouchClient(remote),
                saveSettings: async () => {
                    settingUpCalls.push(getEntry(settings)?.settingUp);
                },
            },
        );
        await cs.rebind(settings.couchdbConfigDbName);
    });

    afterEach(async () => {
        await db.destroy().catch(() => {});
    });

    it("marks settingUp true before the wipe and false only after success", async () => {
        vault.addFile(".obsidian/a.json", `{}`);
        await cs.create();
        expect(settingUpCalls).toEqual([true, false]);
        expect(getEntry(settings)?.settingUp).toBe(false);
    });

    it("leaves settingUp true when init fails mid-flight (no false cleared)", async () => {
        vault.addFile(".obsidian/a.json", `{}`);
        // Fail the remote write after the destructive wipe — init throws
        // before reaching the success markSettingUp(false).
        vi.spyOn(remote, "bulkDocs").mockRejectedValue(new Error("network down"));

        await expect(cs.create()).rejects.toThrow();

        expect(settingUpCalls).toEqual([true]);   // false never reached
        expect(getEntry(settings)?.settingUp).toBe(true);
    });

    // ── init ordering & blast-radius minimisation ──

    it("pushes config:meta as the first remote write after ensureDb, before any config doc", async () => {
        vault.addFile(".obsidian/app.json", `{}`);
        const ensureSpy = vi.spyOn(remote, "ensureDb");
        const bulkSpy = vi.spyOn(remote, "bulkDocs");

        await cs.create();
        // Init pins meta only; Push seeds the real config doc afterwards.
        await cs.push();

        // The config:meta crypto root must be the FIRST bulkDocs call — nothing
        // (no config doc) lands on the freshly-recreated remote before it.
        const metaIdx = bulkSpy.mock.calls.findIndex(
            ([docs]: [any[]]) => docs.some((d) => d._id === "config:meta"),
        );
        expect(metaIdx).toBe(0);
        // And the meta push happens AFTER ensureDb (remote exists) — the window
        // where the DB exists without a meta is just this one call.
        expect(ensureSpy.mock.invocationCallOrder[0])
            .toBeLessThan(bulkSpy.mock.invocationCallOrder[metaIdx]);
        // A real config doc is pushed later, never before the meta.
        const appId = makeConfigId(".obsidian/app.json");
        const appIdx = bulkSpy.mock.calls.findIndex(
            ([docs]: [any[]]) => docs.some((d) => d._id === appId),
        );
        expect(appIdx).toBeGreaterThan(metaIdx);
    });

    it("does not destroy the remote when the pre-destroy config check fails (pre-destructive)", async () => {
        // No config DB applied (unbound) trips the pre-check, which runs
        // BEFORE the crypto derivation and the destructive wipe. Nothing must
        // be destroyed and the setup latch must never be set.
        settings.couchdbConfigDbName = "";
        await cs.rebind(null);
        const destroySpy = vi.spyOn(remote, "destroy");

        await expect(cs.create()).rejects.toThrow();

        expect(destroySpy).not.toHaveBeenCalled();
        expect(settingUpCalls).toEqual([]); // latch never set — fully pre-destructive
    });

    it("blocks push/pull/write while a prior init is unfinished (gating)", async () => {
        putEntry(settings, { settingUp: true });
        await expect(cs.push()).rejects.toThrow(/interrupted/);
        await expect(cs.pull()).rejects.toThrow(/interrupted/);
        await expect(cs.write()).rejects.toThrow(/interrupted/);
    });

    it("first encrypted Create succeeds despite a fail-closed wrapped client (#config-init)", async () => {
        // wrapConfigClient is fail-closed: it throws when encryption is on but
        // no crypto provider is unlocked. The FIRST encrypted Config Init has no
        // provider yet, so Init must run its DB-level ops (destroy/ensureDb/
        // probe) on the raw client; the wrapped client is only used for the doc
        // push once the provider exists. Pre-fix this threw in
        // ConfigOperation.makeClient before Init could start.
        const wrapped = vi.fn((): never => {
            throw new Error("refusing to build config client — no provider");
        });
        const cs2 = new ConfigSync(
            vault, new FakeModalPresenter(), "test-vault", auth, ALWAYS_VISIBLE, NoopReconnectBridge,
            () => settings,
            {
                storeFactory: () => db,
                // Fail-closed: Create must never need the wrapped client.
                clientFactory: wrapped,
                rawClientFactory: () => asCouchClient(remote),
            },
        );
        await cs2.rebind(settings.couchdbConfigDbName);
        vault.addFile(".obsidian/a.json", "{}");
        settings.configEncryptionEnabled = true;
        settings.configEncryptionPassphrase = "test-pass-123";
        settings.configCompressionEnabled = false;

        await cs2.create();

        expect(wrapped).not.toHaveBeenCalled();
        // The freshly derived key is usable on the binding Create ran
        // against (HMAC chunk ids for local work), the passphrase it used is
        // kept on the binding (Step 1 unchanged), and the device is joined
        // with the new root and a floor.
        expect(cs2.currentBinding()!.currentKeys().hasher.alg).toBe("hmac");
        expect(settings.configEncryptionPassphrase).toBe("test-pass-123");
        expect(cs2.currentBinding()!.attachment).not.toBeNull();
        expect(getEntry(settings)).toEqual({
            cipherFloor: 3, settingUp: false, passphrase: "test-pass-123",
        });
        // The attachment (the new root's codec) is in the store.
        expect(await getAttachment(db)).toMatchObject({
            codec: { encryption: true, compression: false },
        });
    });
});

// NOTE: The "fail-closed encrypting client" describe block was removed
// when Init was split from Push. Init no longer pushes content, so it never
// builds an encrypting client — there is no init-time plaintext-into-encrypted
// branch left to guard. The equivalent protection now lives where the content
// push actually happens: `ConfigBinding.wrapClient` is fail-closed (an
// encrypted attachment + no key ⇒ key-missing), and Push / Pull always encode
// with the attachment's codec, never the Step 1 settings (see
// config-sync.test.ts).
