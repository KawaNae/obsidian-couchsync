// ── Types ────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "error";

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

type SettingsGetter = () => { showVerboseLog: boolean };
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
    return _getSettings?.().showVerboseLog ?? false;
}

// ── Log functions ───────────────────────────────────────

/** Verbose console.log — gated behind showVerboseLog. Always buffered. */
export function logVerbose(message: string): void {
    pushEntry("debug", message);
    if (isVerbose()) console.log(message);
}

/**
 * Verbose console.log + Obsidian Notice. Use for events the user
 * wants to see on mobile (reconnect decisions, state transitions).
 * Both the console log and the notice are gated behind showVerboseLog.
 * Always buffered.
 */
export function logNotice(message: string, durationMs = 4000): void {
    pushEntry("info", message);
    if (!isVerbose()) return;
    console.log(message);
    _showNotice?.(message, durationMs);
}

/** Error-level log. Always goes to console.error AND the ring buffer. */
export function logError(message: string): void {
    pushEntry("error", message);
    console.error(message);
}
