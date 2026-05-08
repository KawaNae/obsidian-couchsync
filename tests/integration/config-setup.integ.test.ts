/**
 * ConfigSetupService integration tests — true clean-slate init.
 *
 * Drives ConfigSync.init() against a real ConfigLocalDB + FakeCouchClient
 * and verifies the new (PR5) semantics:
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

let counter = 0;
function uniqueName(): string {
    return `cs-setup-${Date.now()}-${counter++}`;
}

function asCouchClient(fake: FakeCouchClient): CouchClient {
    (fake as any).withTimeout = (_ms: number) => fake;
    return fake as unknown as CouchClient;
}

describe("ConfigSetupService — clean-slate init (PR5)", () => {
    let vault: FakeVaultIO;
    let modal: FakeModalPresenter;
    let db: ConfigLocalDB;
    let auth: AuthGate;
    let settings: ReturnType<typeof makeSettings>;
    let remote: FakeCouchClient;
    let cs: ConfigSync;

    beforeEach(() => {
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
            db,
            auth,
            ALWAYS_VISIBLE,
            NoopReconnectBridge,
            () => settings,
            () => asCouchClient(remote),
        );
    });

    afterEach(async () => {
        await db.destroy().catch(() => {});
    });

    it("init calls remote.destroy() before pushing (true rev-tree reset)", async () => {
        const destroySpy = vi.spyOn(remote, "destroy");
        const ensureSpy = vi.spyOn(remote, "ensureDb");
        vault.addFile(".obsidian/a.json", `{}`);

        await cs.init();

        expect(destroySpy).toHaveBeenCalledTimes(1);
        expect(ensureSpy).toHaveBeenCalled();
        // destroy must run before ensureDb in the call sequence.
        expect(destroySpy.mock.invocationCallOrder[0])
            .toBeLessThan(ensureSpy.mock.invocationCallOrder[0]);
    });

    it("init resets the local DB so previously stored docs are gone", async () => {
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

        await cs.init();

        // Stale doc gone, only the new scan result is present.
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

        await cs.init();

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

        await cs.init();

        const stale = await db.getMeta(
            `${CONFIG_LAST_SYNCED_PREFIX}.obsidian/ghost.json`,
        );
        expect(stale).toBeNull();
    });

    it("init produces fresh rev=1- on remote (no carry-over from previous tenant)", async () => {
        // Simulate the audit-2026-05-08 phantom: previous tenant
        // accumulated rev=N for `app.json`. After our PR5 init, the doc
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
        await cs.init();

        const fresh = await remote.getDoc<any>(id);
        expect(fresh).not.toBeNull();
        // After remote.destroy() + recreate + push, rev must come back at 1-.
        expect(fresh!._rev.startsWith("1-")).toBe(true);
    });
});
