/**
 * SyncHarness — 複数デバイスの sync 構成要素を 1 行で組み立てるファクトリ。
 *
 * 設計:
 *   - 1 つの `FakeCouchClient` を全デバイスで共有 (= 同一リモートを複数端末が sync する状況の再現)
 *   - 各デバイスは LocalDB (fake-indexeddb) + FakeVaultIO + VaultSync + ChangeTracker + SyncEngine を実体として持つ
 *   - SyncEngine には clientFactory を注入して、engine.start() 時に共有 FakeCouchClient が選ばれるようにする
 *   - 副作用ベースの検証 (vault / db / couch に何が書かれたか) を効率よく書くための基盤
 *
 * 使い方 (最小):
 *   const h = createSyncHarness();
 *   const a = h.addDevice("dev-A");
 *   const b = h.addDevice("dev-B");
 *   a.vault.addFile("notes/x.md", "hello");
 *   await a.vs.fileToDb("notes/x.md");
 *   // ... pipelines / verification
 *   await h.destroyAll();
 *
 * 拡張予定 (後続 Phase):
 *   - ConfigSync (別 FakeCouchClient)
 *   - HistoryCapture (FakeHistoryStorage 必要)
 *   - tickUntilQuiescent (engine.start() 駆動の live ループテスト用)
 */

import "fake-indexeddb/auto";

import { LocalDB } from "../../src/db/local-db.ts";
import { SyncEngine } from "../../src/db/sync-engine.ts";
import { AuthGate } from "../../src/db/sync/auth-gate.ts";
import { VaultSync } from "../../src/sync/vault-sync.ts";
import { ChangeTracker } from "../../src/sync/change-tracker.ts";
import { ConflictResolver } from "../../src/conflict/conflict-resolver.ts";
import { FilesystemVaultWriter } from "../../src/sync/vault-writer.ts";
import type { CouchSyncSettings } from "../../src/settings.ts";
import type { ICouchClient } from "../../src/db/interfaces.ts";

import { FakeCouchClient } from "../helpers/fake-couch-client.ts";
import { FakeVaultIO } from "../helpers/fake-vault-io.ts";
import { FakeVaultEvents } from "../helpers/fake-vault-events.ts";
import { makeSettings } from "../helpers/settings-factory.ts";

// ── Types ─────────────────────────────────────────────

export interface DeviceHarness {
    readonly id: string;
    readonly vault: FakeVaultIO;
    readonly vaultEvents: FakeVaultEvents;
    readonly db: LocalDB;
    readonly vs: VaultSync;
    readonly ct: ChangeTracker;
    readonly engine: SyncEngine;
    readonly resolver: ConflictResolver;
    readonly settings: CouchSyncSettings;
    destroy(): Promise<void>;
}

export interface SyncHarnessOptions {
    /** Settings overrides applied to every device (per-device overrides take precedence). */
    baseSettings?: Partial<CouchSyncSettings>;
}

export interface SyncHarness {
    /** 全デバイスで共有される vault リモート (FakeCouchClient)。 */
    readonly couch: FakeCouchClient;

    /** デバイスを追加して DeviceHarness を返す。per-device 設定上書き可。 */
    addDevice(id: string, overrides?: Partial<CouchSyncSettings>): DeviceHarness;

    /** 追加済みのデバイス一覧 (insertion order)。 */
    readonly devices: ReadonlyMap<string, DeviceHarness>;

    /** 全 device を destroy する。 */
    destroyAll(): Promise<void>;
}

// ── Implementation ────────────────────────────────────

let harnessCounter = 0;

export function createSyncHarness(opts: SyncHarnessOptions = {}): SyncHarness {
    const couch = new FakeCouchClient();
    const devices = new Map<string, DeviceHarness>();
    const harnessId = ++harnessCounter;

    // DB 名はハーネス単位で衝突しないよう一意化する。fake-indexeddb は
    // テストファイル内で共有される — 同一 dbName を複数 LocalDB が開くと
    // 内容が混在して謎の失敗につながる。
    let deviceCounter = 0;
    function uniqueDbName(deviceId: string): string {
        return `harness-${harnessId}-${deviceId}-${++deviceCounter}-${Date.now()}`;
    }

    function addDevice(id: string, overrides?: Partial<CouchSyncSettings>): DeviceHarness {
        if (devices.has(id)) {
            throw new Error(`SyncHarness: device "${id}" already exists`);
        }

        const vault = new FakeVaultIO();
        const vaultEvents = new FakeVaultEvents();
        const db = new LocalDB(uniqueDbName(id));
        db.open();

        // Settings: base → harness defaults → per-device overrides
        const settings = makeSettings({
            deviceId: id,
            // URL 系は clientFactory が無視するので任意値でOK。connectionState を
            // syncing 以外にしておき、engine.start() を意図せず走らせないように。
            couchdbUri: "http://fake",
            couchdbDbName: "fake-remote",
            couchdbUser: "test",
            couchdbPassword: "test",
            ...(opts.baseSettings ?? {}),
            ...(overrides ?? {}),
        });
        // getSettings が最新の settings を返すようクロージャで保持
        const settingsRef = { current: settings };
        const getSettings = () => settingsRef.current;

        const auth = new AuthGate();
        // clientFactory: 全デバイスが同じ couch を共有する。
        const clientFactory = (_s: CouchSyncSettings): ICouchClient => couch;
        const engine = new SyncEngine(db, getSettings, /* isMobile */ false, auth, clientFactory);

        const writer = new FilesystemVaultWriter(vault);
        const vs = new VaultSync(vault, db, getSettings, writer);
        const ct = new ChangeTracker(vaultEvents, vs, getSettings);

        const resolver = new ConflictResolver();
        engine.setConflictResolver(resolver);

        const device: DeviceHarness = {
            id,
            vault,
            vaultEvents,
            db,
            vs,
            ct,
            engine,
            resolver,
            get settings() {
                return settingsRef.current;
            },
            async destroy() {
                ct.stop();
                // Capture the live session BEFORE engine.stop nulls it
                // out, so we can await its loops settling. Without this
                // await, db.destroy() can race the still-running pull
                // longpoll / push poll loops and hang the test process.
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

    async function destroyAll(): Promise<void> {
        for (const dev of devices.values()) {
            await dev.destroy();
        }
        devices.clear();
        await couch.destroy();
    }

    return { couch, addDevice, devices, destroyAll };
}
