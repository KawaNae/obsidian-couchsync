/**
 * Integration test for ConfigSync.init() — verifies that init truly
 * replaces the remote state with the current local vault scan, NOT
 * just additively pushes.
 *
 * The bug this guards against: prior to v0.20.6, `pushDocs(deletedIds
 * ∪ currentIds)` silently skipped any id whose local doc had been
 * deleted (which is *every* deletedId, by construction), so files
 * removed from `.obsidian/` between inits stayed on the remote
 * forever. Re-running init never recovered.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { ConfigSync } from "../src/sync/config-sync.ts";
import { ConfigLocalDB } from "../src/db/config-local-db.ts";
import { AuthGate } from "../src/db/sync/auth-gate.ts";
import { ALWAYS_VISIBLE } from "../src/db/visibility-gate.ts";
import { NoopReconnectBridge } from "../src/sync/reconnect-bridge.ts";
import { FakeCouchClient } from "./helpers/fake-couch-client.ts";
import { FakeVaultIO } from "./helpers/fake-vault-io.ts";
import { FakeModalPresenter } from "./helpers/fake-modal-presenter.ts";
import { makeSettings } from "./helpers/settings-factory.ts";
import { makeConfigId } from "../src/types/doc-id.ts";
import type { CouchClient } from "../src/db/couch-client.ts";

let counter = 0;
function uniqueName() { return `cs-init-${Date.now()}-${counter++}`; }

/** Wrap a FakeCouchClient so it satisfies the CouchClient surface
 *  (specifically, `withTimeout`) without actually changing anything. */
function asCouchClient(fake: FakeCouchClient): CouchClient {
    (fake as any).withTimeout = (_ms: number) => fake;
    return fake as unknown as CouchClient;
}

describe("ConfigSync.init() — wipe-and-replace remote", () => {
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

    it("first init: pushes scanned config docs to an empty remote", async () => {
        vault.addFile(".obsidian/app.json", `{"theme":"dark"}`);
        vault.addFile(".obsidian/hotkeys.json", `{}`);

        const scanned = await cs.init();

        expect(scanned).toBe(2);
        const allRows = await remote.allDocs<any>({
            startkey: "config:",
            endkey: "config:￰",
        });
        const liveIds = allRows.rows.filter((r) => !r.value?.deleted).map((r) => r.id);
        expect(liveIds.sort()).toEqual([
            makeConfigId(".obsidian/app.json"),
            makeConfigId(".obsidian/hotkeys.json"),
        ].sort());
    });

    it("second init after vault deletion: tombstones the removed file on remote", async () => {
        // First init: 2 files on vault → both pushed.
        vault.addFile(".obsidian/app.json", `{}`);
        vault.addFile(".obsidian/hotkeys.json", `{}`);
        await cs.init();

        // User removes hotkeys.json from .obsidian/.
        await vault.delete(".obsidian/hotkeys.json");

        // Second init: should tombstone hotkeys on remote.
        await cs.init();

        const allRows = await remote.allDocs<any>({
            startkey: "config:",
            endkey: "config:￰",
        });
        const liveIds = allRows.rows.filter((r) => !r.value?.deleted).map((r) => r.id);
        expect(liveIds).toEqual([makeConfigId(".obsidian/app.json")]);
    });

    it("re-init with same vault state is idempotent (remote unchanged)", async () => {
        vault.addFile(".obsidian/app.json", `{}`);
        vault.addFile(".obsidian/hotkeys.json", `{}`);
        await cs.init();
        const before = (await remote.allDocs<any>({
            startkey: "config:",
            endkey: "config:￰",
        })).rows.filter((r) => !r.value?.deleted).map((r) => r.id).sort();

        await cs.init();

        const after = (await remote.allDocs<any>({
            startkey: "config:",
            endkey: "config:￰",
        })).rows.filter((r) => !r.value?.deleted).map((r) => r.id).sort();
        expect(after).toEqual(before);
    });

    it("init wipes local DB before scanning (stale local docs do not survive)", async () => {
        // Pre-seed local DB with a stale doc that no longer corresponds
        // to a vault file.
        await db.runWriteTx({
            docs: [{ doc: {
                _id: makeConfigId(".obsidian/stale.json"),
                type: "config",
                data: "ZGF0YQ==",
                mtime: 1, size: 4, vclock: { "dev-A": 1 },
            } }],
        });

        // Scan only sees app.json.
        vault.addFile(".obsidian/app.json", `{}`);
        await cs.init();

        // After init, local DB only has app.json.
        const localIds = (await db.allConfigDocs()).map((d) => d._id);
        expect(localIds).toEqual([makeConfigId(".obsidian/app.json")]);
    });
});
