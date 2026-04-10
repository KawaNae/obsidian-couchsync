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

/** Verbose console.log — gated behind showVerboseLog. */
export function logVerbose(message: string): void {
    if (isVerbose()) console.log(message);
}

/**
 * Verbose console.log + Obsidian Notice. Use for events the user
 * wants to see on mobile (reconnect decisions, state transitions).
 * Both the console log and the notice are gated behind showVerboseLog.
 */
export function logNotice(message: string, durationMs = 4000): void {
    if (!isVerbose()) return;
    console.log(message);
    _showNotice?.(message, durationMs);
}
