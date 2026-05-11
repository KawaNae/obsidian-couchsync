/**
 * LogManager — integration tests.
 *
 * The manager subscribes to the module-level emitter in `src/ui/log.ts`,
 * so a fresh vitest module reset is performed in beforeEach to keep the
 * listener list clean across tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { logDebug, logInfo, logWarn, logError } from "../src/ui/log.ts";
import { LogStorage } from "../src/log/log-storage.ts";
import { LogManager, AVG_ENTRY_BYTES } from "../src/log/log-manager.ts";
import type { CouchSyncSettings } from "../src/settings.ts";
import type { IVaultIO, FileStat, VaultFile } from "../src/types/vault-io.ts";

function uniqueVaultName(): string {
    return `test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

class FakeVaultIO implements IVaultIO {
    files = new Map<string, ArrayBuffer>();
    async readBinary(path: string): Promise<ArrayBuffer> {
        const b = this.files.get(path);
        if (!b) throw new Error(`Not found: ${path}`);
        return b;
    }
    async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
        if (!this.files.has(path)) throw new Error(`Not found: ${path}`);
        this.files.set(path, data);
    }
    async createBinary(path: string, data: ArrayBuffer): Promise<void> {
        this.files.set(path, data);
    }
    async delete(path: string): Promise<void> { this.files.delete(path); }
    async exists(path: string): Promise<boolean> { return this.files.has(path); }
    async stat(_path: string): Promise<FileStat | null> { return null; }
    async createFolder(_path: string): Promise<void> {}
    async list(_path: string) { return { files: [...this.files.keys()], folders: [] }; }
    async cachedRead(path: string): Promise<string> {
        const b = this.files.get(path);
        if (!b) throw new Error(`Not found: ${path}`);
        return new TextDecoder().decode(b);
    }
    getFiles(): VaultFile[] { return []; }
}

function makeSettings(overrides: Partial<CouchSyncSettings> = {}): CouchSyncSettings {
    return {
        couchdbUri: "",
        couchdbUser: "",
        couchdbPassword: "",
        couchdbDbName: "",
        couchdbConfigDbName: "",
        syncFilter: "",
        syncIgnore: "",
        maxFileSizeMB: 50,
        configSyncPaths: [],
        syncDebounceMs: 2000,
        syncMinIntervalMs: 0,
        historyRetentionDays: 30,
        historyDebounceMs: 5000,
        historyMinIntervalMs: 60000,
        historyMaxStorageMB: 500,
        mobileStatus: { align: "left", bottom: 50, offset: 8 },
        historyExcludePatterns: [],
        verboseNotice: false,
        connectionState: "editing",
        deviceId: "test-device",
        previousDeviceIds: [],
        logRetentionDays: 7,
        logMaxStorageMB: 50,
        ...overrides,
    };
}

function makeManager(
    storage: LogStorage,
    vault: IVaultIO,
    overrides: { settings?: Partial<CouchSyncSettings>; now?: number } = {},
): LogManager {
    const fixedNow = overrides.now;
    return new LogManager({
        storage,
        getSettings: () => makeSettings(overrides.settings),
        getPluginVersion: () => "0.23.0-test",
        getObsidianVersion: () => "1.6.7",
        getPlatform: () => ({ os: "test", isMobile: false }),
        getSyncDiagnostics: () => ({ state: "test", connectionState: "test" }),
        vault,
        now: fixedNow !== undefined ? () => fixedNow : undefined,
    });
}

describe("LogManager", () => {
    let storage: LogStorage;
    let vault: FakeVaultIO;
    let manager: LogManager;

    beforeEach(() => {
        storage = new LogStorage(uniqueVaultName());
        vault = new FakeVaultIO();
        // Silence the console outputs that logWarn/logError emit unconditionally.
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        manager?.stop();
        storage?.close();
        vi.restoreAllMocks();
    });

    it("trailing throttle: 5 quick logs flush to IDB after 50 ms", async () => {
        manager = makeManager(storage, vault);
        manager.start();

        logInfo("a");
        logInfo("b");
        logInfo("c");
        logInfo("d");
        logInfo("e");

        // Wait > 50 ms for the trailing flush to fire.
        await new Promise((r) => setTimeout(r, 80));

        const all = await storage.getAll();
        expect(all.length).toBe(5);
        expect(all.map((e) => e.message)).toEqual(["a", "b", "c", "d", "e"]);
    });

    it("burst > 100 entries triggers immediate flush via microtask", async () => {
        manager = makeManager(storage, vault);
        manager.start();

        for (let i = 0; i < 150; i++) logInfo(`m${i}`);

        // Allow microtask + dexie commit to complete.
        await new Promise((r) => setTimeout(r, 80));

        const stats = await storage.getStats();
        expect(stats.count).toBe(150);
    });

    it("manager.flush() forces a synchronous-ish drain (for export)", async () => {
        manager = makeManager(storage, vault);
        manager.start();

        for (let i = 0; i < 10; i++) logDebug(`x${i}`);
        await manager.flush();

        const all = await storage.getAll();
        expect(all.length).toBe(10);
    });

    it("stop() detaches the listener — subsequent logs are not persisted", async () => {
        manager = makeManager(storage, vault);
        manager.start();
        logInfo("before-stop");
        await manager.flush();
        manager.stop();

        logInfo("after-stop");
        await new Promise((r) => setTimeout(r, 80));

        const all = await storage.getAll();
        expect(all.map((e) => e.message)).toEqual(["before-stop"]);
    });

    it("captures all four log levels", async () => {
        manager = makeManager(storage, vault);
        manager.start();
        logDebug("d");
        logInfo("i");
        logWarn("w");
        logError("e");
        await manager.flush();
        const stats = await storage.getStats();
        expect(stats.levels).toEqual({ debug: 1, info: 1, warn: 1, error: 1 });
    });

    it("exportToVault writes a .md with frontmatter at vault root", async () => {
        const now = Date.UTC(2026, 4, 11, 23, 15, 42);
        manager = makeManager(storage, vault, { now });
        manager.start();
        logInfo("hello");
        const result = await manager.exportToVault();
        expect(result.path).toBe("couchsync_log_test-device_2026-05-11T23-15-42.md");
        expect(result.count).toBe(1);
        const written = await vault.cachedRead(result.path);
        expect(written).toContain("---");
        expect(written).toContain("device_id: 'test-device'");
        expect(written).toContain("[INFO] hello");
    });

    it("exportToVault appends a numeric suffix on name collision", async () => {
        const now = Date.UTC(2026, 4, 11, 23, 15, 42);
        manager = makeManager(storage, vault, { now });
        manager.start();
        logInfo("first");
        await manager.exportToVault();
        logInfo("second");
        const second = await manager.exportToVault();
        expect(second.path).toBe("couchsync_log_test-device_2026-05-11T23-15-42_1.md");
    });

    it("cleanup drops entries older than logRetentionDays", async () => {
        const now = Date.UTC(2026, 4, 11);
        const dayMs = 24 * 60 * 60 * 1000;
        // Seed directly via storage to avoid timing constraints.
        await storage.bulkAppend([
            { timestamp: now - 10 * dayMs, level: "info", message: "old" },
            { timestamp: now - 3 * dayMs, level: "info", message: "recent" },
            { timestamp: now, level: "info", message: "now" },
        ]);
        manager = makeManager(storage, vault, { settings: { logRetentionDays: 7 }, now });
        // Use the private cleanup indirectly via start() which calls it.
        manager.start();
        // Initial cleanup is fire-and-forget; allow it to settle.
        await new Promise((r) => setTimeout(r, 30));
        const remaining = await storage.getAll();
        expect(remaining.map((e) => e.message)).toEqual(["recent", "now"]);
    });

    it("cleanup trims to count when logMaxStorageMB > 0", async () => {
        const now = Date.UTC(2026, 4, 11);
        // 50 KB cap → 50 * 1024 / 200 = 256 entries cap.
        const tinyCapMB = 50 / 1024;
        const seeded: any[] = [];
        for (let i = 0; i < 400; i++) {
            seeded.push({ timestamp: now - (400 - i) * 1000, level: "info" as const, message: `m${i}` });
        }
        await storage.bulkAppend(seeded);

        manager = makeManager(storage, vault, {
            settings: { logRetentionDays: 365, logMaxStorageMB: tinyCapMB },
            now,
        });
        manager.start();
        await new Promise((r) => setTimeout(r, 30));
        const remaining = await storage.getAll();
        const expected = Math.floor((tinyCapMB * 1024 * 1024) / AVG_ENTRY_BYTES);
        expect(remaining.length).toBe(expected);
        // The trimmed survivors are the newest entries.
        expect(remaining[remaining.length - 1].message).toBe("m399");
    });

    it("logMaxStorageMB === 0 disables size trimming", async () => {
        const now = Date.UTC(2026, 4, 11);
        const seeded: any[] = [];
        for (let i = 0; i < 50; i++) {
            seeded.push({ timestamp: now - 1000, level: "info" as const, message: `m${i}` });
        }
        await storage.bulkAppend(seeded);

        manager = makeManager(storage, vault, {
            settings: { logRetentionDays: 365, logMaxStorageMB: 0 },
            now,
        });
        manager.start();
        await new Promise((r) => setTimeout(r, 30));
        const stats = await storage.getStats();
        expect(stats.count).toBe(50);
    });

    it("clearStoredLogs empties the persistent buffer", async () => {
        manager = makeManager(storage, vault);
        manager.start();
        logInfo("a");
        await manager.flush();
        await manager.clearStoredLogs();
        const stats = await storage.getStats();
        expect(stats.count).toBe(0);
    });
});
