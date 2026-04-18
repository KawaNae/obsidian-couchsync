/**
 * E2E harness — Phase 1 の SyncHarness と同じ shape を持つが、内部で実 CouchClient
 * を使う。fake-indexeddb は再利用 (LocalDB 側はテストごとに fresh)。
 *
 * 前提: docker-compose up で CouchDB 3.3 が :5984 で起動済み。
 *       admin 資格情報は環境変数 (COUCHDB_USER/COUCHDB_PASSWORD) で上書き可。
 *
 * 使い方:
 *   const h = await createE2EHarness();
 *   const a = h.addDevice("dev-A");
 *   const b = h.addDevice("dev-B");
 *   // ...
 *   await h.destroyAll();
 */

import "fake-indexeddb/auto";

import { LocalDB } from "../../src/db/local-db.ts";
import { SyncEngine } from "../../src/db/sync-engine.ts";
import { AuthGate } from "../../src/db/sync/auth-gate.ts";
import { VaultSync } from "../../src/sync/vault-sync.ts";
import { ChangeTracker } from "../../src/sync/change-tracker.ts";
import { ConflictResolver } from "../../src/conflict/conflict-resolver.ts";
import { CouchClient, makeCouchClient } from "../../src/db/couch-client.ts";
import type { CouchSyncSettings } from "../../src/settings.ts";
import type { ICouchClient } from "../../src/db/interfaces.ts";

import { FakeVaultIO } from "../helpers/fake-vault-io.ts";
import { FakeVaultEvents } from "../helpers/fake-vault-events.ts";
import { makeSettings } from "../helpers/settings-factory.ts";

// ── Config ────────────────────────────────────────────

export interface E2EConfig {
    couchUrl: string;
    user: string;
    password: string;
    dbName: string;
}

export function e2eConfig(): E2EConfig {
    return {
        couchUrl: process.env.COUCHDB_URL ?? "http://localhost:5984",
        user: process.env.COUCHDB_USER ?? "admin",
        password: process.env.COUCHDB_PASSWORD ?? "admin",
        dbName: process.env.COUCHDB_DB_NAME ?? "couchsync-e2e-vault",
    };
}

// ── Types ─────────────────────────────────────────────

export interface E2EDeviceHarness {
    readonly id: string;
    readonly vault: FakeVaultIO;
    readonly vaultEvents: FakeVaultEvents;
    readonly db: LocalDB;
    readonly vs: VaultSync;
    readonly ct: ChangeTracker;
    readonly engine: SyncEngine;
    readonly resolver: ConflictResolver;
    readonly settings: CouchSyncSettings;
    /** The client pointing at the shared test CouchDB. */
    readonly client: CouchClient;
    destroy(): Promise<void>;
}

export interface E2EHarness {
    readonly config: E2EConfig;
    readonly adminClient: CouchClient;
    readonly devices: ReadonlyMap<string, E2EDeviceHarness>;
    addDevice(id: string, overrides?: Partial<CouchSyncSettings>): E2EDeviceHarness;
    /**
     * Reset CouchDB for a fresh test (drop + recreate the vault DB).
     * Intended to be called in beforeEach.
     */
    resetCouch(): Promise<void>;
    destroyAll(): Promise<void>;
}

// ── Implementation ────────────────────────────────────

let harnessCounter = 0;

export async function createE2EHarness(): Promise<E2EHarness> {
    const cfg = e2eConfig();
    const adminClient = makeCouchClient(cfg.couchUrl, cfg.dbName, cfg.user, cfg.password);
    await adminClient.ensureDb();

    const devices = new Map<string, E2EDeviceHarness>();
    const harnessId = ++harnessCounter;
    let deviceCounter = 0;

    function uniqueDbName(deviceId: string): string {
        return `e2e-${harnessId}-${deviceId}-${++deviceCounter}-${Date.now()}`;
    }

    function addDevice(id: string, overrides?: Partial<CouchSyncSettings>): E2EDeviceHarness {
        if (devices.has(id)) {
            throw new Error(`E2EHarness: device "${id}" already exists`);
        }

        const vault = new FakeVaultIO();
        const vaultEvents = new FakeVaultEvents();
        const db = new LocalDB(uniqueDbName(id));
        db.open();

        const settings = makeSettings({
            deviceId: id,
            couchdbUri: cfg.couchUrl,
            couchdbDbName: cfg.dbName,
            couchdbUser: cfg.user,
            couchdbPassword: cfg.password,
            ...(overrides ?? {}),
        });
        const settingsRef = { current: settings };
        const getSettings = () => settingsRef.current;

        const client = makeCouchClient(
            settings.couchdbUri,
            settings.couchdbDbName,
            settings.couchdbUser,
            settings.couchdbPassword,
        );

        const auth = new AuthGate();
        const clientFactory = (_s: CouchSyncSettings): ICouchClient => client;
        const engine = new SyncEngine(db, getSettings, /* isMobile */ false, auth, clientFactory);

        const vs = new VaultSync(vault, db, getSettings);
        const ct = new ChangeTracker(vaultEvents, vs, getSettings);
        vs.setWriteIgnore(ct);

        const resolver = new ConflictResolver();
        engine.setConflictResolver(resolver);

        const device: E2EDeviceHarness = {
            id,
            vault,
            vaultEvents,
            db,
            vs,
            ct,
            engine,
            resolver,
            client,
            get settings() {
                return settingsRef.current;
            },
            async destroy() {
                ct.stop();
                engine.stop();
                await vs.teardown();
                await db.destroy();
            },
        };
        devices.set(id, device);
        return device;
    }

    async function resetCouch(): Promise<void> {
        // DELETE + PUT via a fetch against _all_dbs endpoint would be cleaner,
        // but we don't have a generic admin API here. Easiest: issue the HTTP
        // DELETE / PUT directly via fetch since we have the credentials.
        const authHeader = "Basic " + Buffer.from(`${cfg.user}:${cfg.password}`).toString("base64");
        const base = cfg.couchUrl.replace(/\/+$/, "");
        // DELETE — ignore 404 (not present yet).
        const delResp = await fetch(`${base}/${cfg.dbName}`, {
            method: "DELETE",
            headers: { Authorization: authHeader },
        });
        if (!delResp.ok && delResp.status !== 404) {
            throw new Error(`resetCouch: DELETE ${cfg.dbName} → ${delResp.status}`);
        }
        // PUT — create fresh.
        const putResp = await fetch(`${base}/${cfg.dbName}`, {
            method: "PUT",
            headers: { Authorization: authHeader },
        });
        if (!putResp.ok) {
            throw new Error(`resetCouch: PUT ${cfg.dbName} → ${putResp.status}`);
        }
    }

    async function destroyAll(): Promise<void> {
        for (const dev of devices.values()) {
            await dev.destroy();
        }
        devices.clear();
    }

    return { config: cfg, adminClient, devices, addDevice, resetCouch, destroyAll };
}
