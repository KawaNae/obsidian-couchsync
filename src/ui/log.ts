/**
 * Unified logging and notification system.
 *
 * All log functions write to an in-memory ring buffer (visible in Log View)
 * regardless of settings. The `verboseNotice` setting controls only whether
 * console output and Obsidian Notices are emitted for debug/info levels.
 *
 *   logDebug(msg)   → buffer(debug) + console(verbose)
 *   logInfo(msg)    → buffer(info)  + console(verbose) + notice(verbose)
 *   logWarn(msg)    → buffer(warn)  + console(always)
 *   logError(msg)   → buffer(error) + console(always)  + notice(always)
 *   notify(msg, d?) → buffer(info)  + notice(always)   — user-facing
 */

// ── Types ────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
    timestamp: number;
    level: LogLevel;
    message: string;
}

// ── Ring buffer ──────────────────────────────────────────

const MAX_LOG_ENTRIES = 500;
const buffer: LogEntry[] = [];
let listeners: ((entry: LogEntry) => void)[] = [];

function pushEntry(level: LogLevel, message: string): void {
    const entry: LogEntry = { timestamp: Date.now(), level, message };
    buffer.push(entry);
    if (buffer.length > MAX_LOG_ENTRIES) buffer.shift();
    for (const fn of listeners) {
        try { fn(entry); } catch { /* listener errors don't propagate */ }
    }
}

export function getLogEntries(): LogEntry[] {
    return [...buffer];
}

export function clearLog(): void {
    buffer.length = 0;
}

export function onLogEntry(fn: (entry: LogEntry) => void): () => void {
    listeners.push(fn);
    return () => { listeners = listeners.filter((l) => l !== fn); };
}

// ── Init / settings ─────────────────────────────────────

type SettingsGetter = () => { verboseNotice: boolean };
type NoticeFunc = (message: string, durationMs: number) => void;

let _getSettings: SettingsGetter | null = null;
let _showNotice: NoticeFunc | null = null;

/**
 * Call once at plugin startup to wire the settings getter and notice
 * function. Passing the notice function avoids a direct import of
 * obsidian (which would break node-based tests).
 */
export function initLog(
    getSettings: SettingsGetter,
    showNotice: NoticeFunc,
): void {
    _getSettings = getSettings;
    _showNotice = showNotice;
}

function isVerbose(): boolean {
    return _getSettings?.().verboseNotice ?? false;
}

// ── Log functions ───────────────────────────────────────

/** Debug-level log. Always buffered. Console output only when verbose. */
export function logDebug(message: string): void {
    pushEntry("debug", message);
    if (isVerbose()) console.log(message);
}

/** Info-level log. Always buffered. Console + Notice only when verbose. */
export function logInfo(message: string, durationMs = 4000): void {
    pushEntry("info", message);
    if (!isVerbose()) return;
    console.log(message);
    _showNotice?.(message, durationMs);
}

/** Warn-level log. Always buffered + console.warn. */
export function logWarn(message: string): void {
    pushEntry("warn", message);
    console.warn(message);
}

/** Error-level log. Always buffered + console.error + Notice. */
export function logError(message: string): void {
    pushEntry("error", message);
    console.error(message);
    _showNotice?.(message, 8000);
}

/** User-facing notice. Always buffered (info) + Notice. */
export function notify(message: string, durationMs = 5000): void {
    pushEntry("info", message);
    _showNotice?.(message, durationMs);
}
