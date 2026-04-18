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

// SyncEngine.start() attaches window/document listeners via EnvListeners.
// Provide minimal stubs so the real engine boots in the Node test runtime.
const __noopEvt = () => {};
(globalThis as any).self = (globalThis as any).self ?? globalThis;
(globalThis as any).window = (globalThis as any).window ?? {
    addEventListener: __noopEvt,
    removeEventListener: __noopEvt,
};
(globalThis as any).document = (globalThis as any).document ?? {
    addEventListener: __noopEvt,
    removeEventListener: __noopEvt,
    visibilityState: "visible",
};

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
import { stripRev } from "../../src/utils/doc.ts";
import type { CouchSyncDoc } from "../../src/types.ts";

// ── Helpers for e2e tests ─────────────────────────────

/**
 * Strip the synthetic `_rev` that LocalDB (`stripInternal`) stamps onto
 * every returned doc before handing them to a real CouchDB's `bulkDocs`.
 * Without this, MVCC rejects the POST with `{error:"conflict"}` because
 * the synthetic rev doesn't match any server-side doc. Production
 * PushPipeline does this via `stripRev` + remote-rev threading; e2e
 * tests that bypass the pipeline must do the strip themselves.
 */
export function stripLocalRevs<T extends { _rev?: string }>(docs: T[]): CouchSyncDoc[] {
    return docs.map((d) => stripRev(d) as unknown as CouchSyncDoc);
}

// ── Config ────────────────────────────────────────────

export interface E2EConfig {
    couchUrl: string;
    user: string;
    password: string;
    dbName: string;
}

let dbNameCounter = 0;

export function e2eConfig(opts?: { uniqueDb?: boolean }): E2EConfig {
    const baseDb = process.env.COUCHDB_DB_NAME ?? "couchsync-e2e-vault";
    const dbName = opts?.uniqueDb
        ? `${baseDb}-${Date.now()}-${++dbNameCounter}`
        : baseDb;
    return {
        couchUrl: process.env.COUCHDB_URL ?? "http://localhost:5984",
        user: process.env.COUCHDB_USER ?? "admin",
        password: process.env.COUCHDB_PASSWORD ?? "admin",
        dbName,
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
     *
     * NOTE: Prefer creating a fresh harness per test (unique dbName) over
     * calling resetCouch — CouchDB's DELETE+PUT cycle is racy because
     * shard files aren't released atomically. resetCouch is kept for
     * tests that intentionally exercise the same DB across iterations.
     */
    resetCouch(): Promise<void>;
    destroyAll(): Promise<void>;
}

// ── Implementation ────────────────────────────────────

let harnessCounter = 0;

export interface CreateE2EHarnessOpts {
    /** When true, the harness uses a unique dbName so multiple tests can
     *  coexist on the same CouchDB without DELETE/PUT races. Recommended
     *  for new tests; default is the legacy shared dbName. */
    uniqueDb?: boolean;
}

export async function createE2EHarness(opts: CreateE2EHarnessOpts = {}): Promise<E2EHarness> {
    const cfg = e2eConfig({ uniqueDb: opts.uniqueDb });
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
                // Mirror sync-harness: capture the live session before
                // engine.stop nulls it, then await its settled so the
                // pull longpoll / push poll loops finish before we drop
                // the local DB or the remote DB beneath them.
                const session = (engine as unknown as {
                    session: { settled: Promise<void> } | null;
                }).session;
                engine.stop();
                if (session) {
                    try { await session.settled; } catch { /* ignore */ }
                }
                await vs.teardown();
                await db.destroy();
            },
        };
        devices.set(id, device);
        return device;
    }

    async function resetCouch(): Promise<void> {
        // CouchDB occasionally returns 500 on DELETE when a previous test's
        // longpoll connection or compaction hasn't fully released the file
        // shard. Retry with backoff until DELETE actually succeeds — we MUST
        // start each test from an empty DB or content-addressed chunk IDs
        // collide with leftover docs and bulkDocs returns "conflict".
        const authHeader = "Basic " + Buffer.from(`${cfg.user}:${cfg.password}`).toString("base64");
        const base = cfg.couchUrl.replace(/\/+$/, "");
        const dbUrl = `${base}/${cfg.dbName}`;

        let lastDelStatus = 0;
        let lastDelBody = "";
        for (let attempt = 0; attempt < 10; attempt++) {
            const r = await fetch(dbUrl, {
                method: "DELETE",
                headers: { Authorization: authHeader },
            });
            if (r.ok || r.status === 404) { lastDelStatus = r.status; break; }
            lastDelStatus = r.status;
            lastDelBody = await r.text().catch(() => "");
            await new Promise((res) => setTimeout(res, 200 * (attempt + 1)));
        }
        if (lastDelStatus !== 200 && lastDelStatus !== 404) {
            throw new Error(
                `resetCouch: DELETE ${cfg.dbName} → ${lastDelStatus} ${lastDelBody}`,
            );
        }

        // PUT — create fresh. CouchDB sometimes returns 412 file_exists
        // immediately after DELETE because the on-disk shard files haven't
        // been released yet. Retry until the filesystem catches up.
        let lastPutStatus = 0;
        let lastPutBody = "";
        for (let attempt = 0; attempt < 10; attempt++) {
            const r = await fetch(dbUrl, {
                method: "PUT",
                headers: { Authorization: authHeader },
            });
            if (r.ok) { lastPutStatus = r.status; lastPutBody = ""; break; }
            lastPutStatus = r.status;
            lastPutBody = await r.text().catch(() => "");
            await new Promise((res) => setTimeout(res, 200 * (attempt + 1)));
        }
        if (lastPutStatus !== 201 && lastPutStatus !== 202) {
            throw new Error(
                `resetCouch: PUT ${cfg.dbName} → ${lastPutStatus} ${lastPutBody}`,
            );
        }
    }

    async function destroyAll(): Promise<void> {
        for (const dev of devices.values()) {
            await dev.destroy();
        }
        devices.clear();
        // For unique-db harnesses, drop the remote DB on teardown so the
        // CouchDB instance doesn't accumulate one DB per test forever.
        if (opts.uniqueDb) {
            const authHeader = "Basic " + Buffer.from(`${cfg.user}:${cfg.password}`).toString("base64");
            const base = cfg.couchUrl.replace(/\/+$/, "");
            try {
                await fetch(`${base}/${cfg.dbName}`, {
                    method: "DELETE",
                    headers: { Authorization: authHeader },
                });
            } catch { /* best-effort cleanup */ }
        }
    }

    return { config: cfg, adminClient, devices, addDevice, resetCouch, destroyAll };
}
