/**
 * Install marker: detects when a vault has been copied to a different
 * Obsidian installation. Advisory only — shows a warning but does NOT
 * regenerate deviceId (v0.12+: deviceId is user-managed).
 *
 * ## How it works
 *
 * Keep an install-scoped identifier in `localStorage` (belongs to the
 * Obsidian installation, not the vault). On startup, compare it against
 * the last-seen marker stored in `data.json`. A mismatch means the vault
 * was copied to a new install — warn the user to check their device name.
 */

const MARKER_KEY = "couchsync.installMarker";

export interface InstallMarkerStorage {
    get(key: string): string | null;
    set(key: string, value: string): void;
}

export interface MarkerCheckInput {
    lastInstallMarker: string | undefined;
    storage: InstallMarkerStorage;
    generateUuid: () => string;
}

export interface MarkerCheckResult {
    /** Updated `lastInstallMarker` to persist to settings. */
    nextInstallMarker: string;
    /** True if the marker mismatched (vault may have been copied). */
    markerMismatch: boolean;
}

/**
 * Pure function — no Obsidian dependencies, trivially unit-testable.
 *
 * Call from onload, then persist:
 *   settings.lastInstallMarker = result.nextInstallMarker
 *
 * Show a warning notice when `markerMismatch === true`.
 */
export function checkInstallMarker(input: MarkerCheckInput): MarkerCheckResult {
    const { lastInstallMarker, storage, generateUuid } = input;

    let currentMarker = storage.get(MARKER_KEY);
    if (!currentMarker) {
        currentMarker = generateUuid();
        storage.set(MARKER_KEY, currentMarker);
    }

    // First run: remember the marker.
    if (!lastInstallMarker) {
        return {
            nextInstallMarker: currentMarker,
            markerMismatch: false,
        };
    }

    // Match: same install as last time.
    if (lastInstallMarker === currentMarker) {
        return {
            nextInstallMarker: currentMarker,
            markerMismatch: false,
        };
    }

    // Mismatch: vault was opened on a different install.
    return {
        nextInstallMarker: currentMarker,
        markerMismatch: true,
    };
}

export const INSTALL_MARKER_KEY = MARKER_KEY;
