import { describe, it, expect } from "vitest";
import {
    formatLogExport,
    buildExportFileName,
    type ExportMeta,
} from "../src/log/markdown-formatter.ts";
import type { PersistedLogEntry } from "../src/log/log-storage.ts";

const META: ExportMeta = {
    deviceId: "melchior-main",
    pluginVersion: "0.23.0",
    obsidianVersion: "1.6.7",
    platform: { os: "win32", isMobile: false },
    exportedAt: Date.UTC(2026, 4, 11, 23, 15, 42),  // 2026-05-11T23:15:42Z
    syncState: {
        state: "connected",
        connectionState: "syncing",
        lastPushedSeq: 802249,
        remoteSeq: "44751-abcdef",
    },
};

const SAMPLE_ENTRIES: PersistedLogEntry[] = [
    { timestamp: Date.UTC(2026, 4, 4, 10, 30, 0), level: "info", message: "Plugin loaded" },
    { timestamp: Date.UTC(2026, 4, 4, 10, 30, 1), level: "debug", message: "checkpoints loaded" },
    { timestamp: Date.UTC(2026, 4, 11, 23, 15, 42), level: "warn", message: "stale handle" },
];

describe("buildExportFileName", () => {
    it("uses ISO timestamp with colons replaced", () => {
        const name = buildExportFileName("melchior-main", Date.UTC(2026, 4, 11, 23, 15, 42));
        expect(name).toBe("couchsync_log_melchior-main_2026-05-11T23-15-42.md");
    });

    it("substitutes unset for empty deviceId", () => {
        const name = buildExportFileName("", Date.UTC(2026, 4, 11, 23, 15, 42));
        expect(name).toBe("couchsync_log_unset_2026-05-11T23-15-42.md");
    });

    it("substitutes unset for whitespace-only deviceId", () => {
        const name = buildExportFileName("   ", Date.UTC(2026, 4, 11, 23, 15, 42));
        expect(name).toBe("couchsync_log_unset_2026-05-11T23-15-42.md");
    });

    it("sanitises unsafe characters in deviceId", () => {
        const name = buildExportFileName("dev/box:1", Date.UTC(2026, 4, 11, 23, 15, 42));
        expect(name).toBe("couchsync_log_dev_box_1_2026-05-11T23-15-42.md");
    });

});

describe("formatLogExport", () => {
    it("emits frontmatter + body for a non-empty buffer", () => {
        const out = formatLogExport(SAMPLE_ENTRIES, META);
        expect(out).toMatchInlineSnapshot(`
"---
device_id: 'melchior-main'
plugin_version: '0.23.0'
obsidian_version: '1.6.7'
platform:
  os: win32
  mobile: false
exported_at: '2026-05-11T23:15:42.000Z'
log_count: 3
buffer_range:
  from: '2026-05-04T10:30:00.000Z'
  to: '2026-05-11T23:15:42.000Z'
levels:
  debug: 1
  info: 1
  warn: 1
  error: 0
sync_state:
  state: connected
  connection_state: syncing
  last_pushed_seq: 802249
  remote_seq: '44751-abcdef'
---

2026-05-04T10:30:00.000Z [INFO] Plugin loaded
2026-05-04T10:30:01.000Z [DEBUG] checkpoints loaded
2026-05-11T23:15:42.000Z [WARN] stale handle
"
        `);
    });

    it("emits frontmatter-only for empty buffer", () => {
        const out = formatLogExport([], META);
        expect(out.endsWith("---\n")).toBe(true);
        expect(out.includes("log_count: 0")).toBe(true);
        // Falls back to exportedAt for both range bounds.
        expect(out.includes("from: '2026-05-11T23:15:42.000Z'")).toBe(true);
    });

    it("omits last_pushed_seq / remote_seq when undefined", () => {
        const out = formatLogExport([], {
            ...META,
            syncState: { state: "disconnected", connectionState: "editing" },
        });
        expect(out.includes("last_pushed_seq:")).toBe(false);
        expect(out.includes("remote_seq:")).toBe(false);
    });

    it("omits the device block entirely when device is absent (back-compat)", () => {
        const out = formatLogExport([], META);
        expect(out.includes("device:")).toBe(false);
    });

    it("renders a full desktop device block", () => {
        const out = formatLogExport([], {
            ...META,
            device: {
                cpuCores: 16,
                userAgent: "obsidian/1.6.7",
                jsHeapUsedMb: 55,
                jsHeapLimitMb: 4096,
                deviceMemoryGb: 8,
                cpuModel: "AMD Ryzen 7 9800X3D",
                totalRamGb: 61.6,
                freeRamGb: 33.2,
                arch: "x64",
                osRelease: "10.0.26200",
            },
        });
        expect(out).toContain("device:");
        expect(out).toContain("  cpu_cores: 16");
        expect(out).toContain("  js_heap_limit_mb: 4096");
        expect(out).toContain("  total_ram_gb: 61.6");
        expect(out).toContain("  cpu_model: 'AMD Ryzen 7 9800X3D'");
        expect(out).toContain("  os_release: '10.0.26200'");
    });

    it("emits only the fields present (iOS: cores + UA, no heap/deviceMemory)", () => {
        const out = formatLogExport([], {
            ...META,
            device: { cpuCores: 6, userAgent: "iPadOS WebKit" },
        });
        expect(out).toContain("  cpu_cores: 6");
        expect(out).toContain("  user_agent: 'iPadOS WebKit'");
        // Absent platform-asymmetric fields must not appear (not "unknown").
        expect(out.includes("js_heap_limit_mb")).toBe(false);
        expect(out.includes("device_memory_gb")).toBe(false);
        expect(out.includes("cpu_model")).toBe(false);
    });

    it("omits the device block when the collected object is empty", () => {
        const out = formatLogExport([], { ...META, device: {} });
        expect(out.includes("device:")).toBe(false);
    });

    it("escapes deviceId containing single quote", () => {
        const out = formatLogExport([], { ...META, deviceId: "user's-laptop" });
        expect(out.includes("device_id: 'user''s-laptop'")).toBe(true);
    });

    it("falls back to unset for empty deviceId in frontmatter", () => {
        const out = formatLogExport([], { ...META, deviceId: "" });
        expect(out.includes("device_id: unset")).toBe(true);
    });

    it("preserves messages with special characters as-is in body", () => {
        const out = formatLogExport(
            [{ timestamp: Date.UTC(2026, 0, 1), level: "info", message: "→ a/b.md: ok [1]" }],
            META,
        );
        expect(out.includes("[INFO] → a/b.md: ok [1]")).toBe(true);
    });

    it("counts all four levels", () => {
        const entries: PersistedLogEntry[] = [
            { timestamp: 0, level: "debug", message: "d" },
            { timestamp: 1, level: "debug", message: "d" },
            { timestamp: 2, level: "info", message: "i" },
            { timestamp: 3, level: "warn", message: "w" },
            { timestamp: 4, level: "warn", message: "w" },
            { timestamp: 5, level: "warn", message: "w" },
            { timestamp: 6, level: "error", message: "e" },
        ];
        const out = formatLogExport(entries, META);
        expect(out.includes("debug: 2")).toBe(true);
        expect(out.includes("info: 1")).toBe(true);
        expect(out.includes("warn: 3")).toBe(true);
        expect(out.includes("error: 1")).toBe(true);
    });
});
