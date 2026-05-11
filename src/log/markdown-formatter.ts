/**
 * Pure formatter for log exports. Produces the .md snapshot body written
 * to the vault: YAML frontmatter with diagnostic metadata + plain-text
 * log lines.
 *
 * Designed to be a pure function so the markdown shape is unit-testable
 * with snapshot tests, and so the export path can be exercised without a
 * vault adapter.
 */

import type { LogLevel } from "../ui/log.ts";
import type { PersistedLogEntry } from "./log-storage.ts";

export interface ExportMeta {
    /** Empty string is replaced by "unset" in both filename and frontmatter. */
    deviceId: string;
    pluginVersion: string;
    obsidianVersion: string;
    platform: {
        os: string;
        isMobile: boolean;
    };
    /** Epoch milliseconds at which the export was performed. */
    exportedAt: number;
    /** Snapshot of sync engine state at export time. */
    syncState: {
        state: string;
        connectionState: string;
        lastPushedSeq?: number;
        remoteSeq?: string;
    };
}

const LEVEL_KEYS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** Build the file name for a log export. */
export function buildExportFileName(deviceId: string, exportedAtMs: number): string {
    const id = deviceId.trim() || "unset";
    // Replace any character not safe across desktop + mobile filesystems.
    const safeId = id.replace(/[^A-Za-z0-9_\-]/g, "_");
    const ts = new Date(exportedAtMs).toISOString().slice(0, 19).replace(/:/g, "-");
    return `couchsync_log_${safeId}_${ts}.md`;
}

/** Quote a YAML scalar value safely. Uses single-quoted form (no escape
 *  processing) for any value that could be misparsed; doubles internal
 *  single quotes per the YAML spec. */
function yamlScalar(value: string): string {
    // Empty and any string with special chars goes through single quoting.
    if (value === "") return "''";
    const needsQuote = /[:#&*!|>'"%@`{}\[\],?\-\s]|^[\d]/.test(value);
    if (!needsQuote) return value;
    return `'${value.replace(/'/g, "''")}'`;
}

function formatFrontmatter(entries: PersistedLogEntry[], meta: ExportMeta): string {
    const levels: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const e of entries) levels[e.level] = (levels[e.level] ?? 0) + 1;

    const oldest = entries.length > 0 ? entries[0].timestamp : meta.exportedAt;
    const newest = entries.length > 0 ? entries[entries.length - 1].timestamp : meta.exportedAt;
    const deviceId = meta.deviceId.trim() || "unset";

    const lines: string[] = ["---"];
    lines.push(`device_id: ${yamlScalar(deviceId)}`);
    lines.push(`plugin_version: ${yamlScalar(meta.pluginVersion)}`);
    lines.push(`obsidian_version: ${yamlScalar(meta.obsidianVersion)}`);
    lines.push(`platform:`);
    lines.push(`  os: ${yamlScalar(meta.platform.os)}`);
    lines.push(`  mobile: ${meta.platform.isMobile}`);
    lines.push(`exported_at: ${yamlScalar(new Date(meta.exportedAt).toISOString())}`);
    lines.push(`log_count: ${entries.length}`);
    lines.push(`buffer_range:`);
    lines.push(`  from: ${yamlScalar(new Date(oldest).toISOString())}`);
    lines.push(`  to: ${yamlScalar(new Date(newest).toISOString())}`);
    lines.push(`levels:`);
    for (const k of LEVEL_KEYS) lines.push(`  ${k}: ${levels[k]}`);
    lines.push(`sync_state:`);
    lines.push(`  state: ${yamlScalar(meta.syncState.state)}`);
    lines.push(`  connection_state: ${yamlScalar(meta.syncState.connectionState)}`);
    if (meta.syncState.lastPushedSeq !== undefined) {
        lines.push(`  last_pushed_seq: ${meta.syncState.lastPushedSeq}`);
    }
    if (meta.syncState.remoteSeq !== undefined) {
        lines.push(`  remote_seq: ${yamlScalar(meta.syncState.remoteSeq)}`);
    }
    lines.push("---");
    return lines.join("\n");
}

function formatBody(entries: PersistedLogEntry[]): string {
    const lines: string[] = [];
    for (const e of entries) {
        const ts = new Date(e.timestamp).toISOString();
        // One log line per entry. Embedded newlines in messages are
        // preserved as-is — they are rare and we want to keep the export
        // faithful to what was logged.
        lines.push(`${ts} [${e.level.toUpperCase()}] ${e.message}`);
    }
    return lines.join("\n");
}

/** Compose the full export string: frontmatter + body + trailing newline. */
export function formatLogExport(
    entries: PersistedLogEntry[],
    meta: ExportMeta,
): string {
    const fm = formatFrontmatter(entries, meta);
    const body = formatBody(entries);
    return body.length > 0 ? `${fm}\n\n${body}\n` : `${fm}\n`;
}
