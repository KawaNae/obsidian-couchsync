/**
 * Install marker: detects when a vault has been copied to a different
 * Obsidian installation so we can regenerate the deviceId and preserve
 * Vector Clock uniqueness.
 *
 * ## The problem
 *
 * `deviceId` lives in `data.json` (Obsidian plugin settings), which travels
 * with the vault folder. If a user copies their vault to another machine
 * (backup restore, Dropbox sync, etc.), the `deviceId` is copied too —
 * and now two physically distinct devices share a Vector Clock key. That
 * breaks the VC uniqueness premise and can silently lose updates.
 *
 * ## The solution
 *
 * Keep a second, **install-scoped** identifier in `localStorage` (which
 * belongs to the Obsidian installation, not the vault). Remember the last
 * install marker a vault saw; on startup, if the current marker disagrees,
 * the vault has been moved to a new install → regenerate `deviceId`.
 *
 * Edge cases:
 *  - **First run**: `lastInstallMarker` is undefined, no regeneration,
 *    just remember the current marker.
 *  - **Normal restart (same install)**: markers match, no-op.
 *  - **Multiple vaults on same install**: each vault has its own
 *    `lastInstallMarker` (stored in its own `data.json`), but they all
 *    match the single install-wide `localStorage` marker, so no
 *    regeneration happens. Correct — they're on the same device.
 *  - **Portable Obsidian moved to a new machine**: the localStorage
 *    travels with the portable install but the machine is different.
 *    We can't detect this case with this scheme, but it's rare enough
 *    to accept (documented in plan risks).
 */

const MARKER_KEY = "couchsync.installMarker";

export interface InstallMarkerStorage {
    get(key: string): string | null;
    set(key: string, value: string): void;
}

export interface MarkerCheckInput {
    lastInstallMarker: string | undefined;
    currentDeviceId: string;
    storage: InstallMarkerStorage;
    generateUuid: () => string;
}

export interface MarkerCheckResult {
    /** Updated `lastInstallMarker` to persist to settings. */
    nextInstallMarker: string;
    /** Updated `deviceId` (either unchanged or newly regenerated). */
    nextDeviceId: string;
    /** True if the marker mismatched and deviceId was regenerated. */
    regenerated: boolean;
    /** The prior deviceId, preserved for UI messaging. Undefined on first run. */
    previousDeviceId?: string;
}

/**
 * Pure function that encapsulates the whole install-marker check — no
 * Obsidian dependencies, so it's trivially unit-testable.
 *
 * Call it from onload, then persist the returned fields:
 *   settings.lastInstallMarker = result.nextInstallMarker
 *   settings.deviceId          = result.nextDeviceId
 *
 * Notify the user only when `regenerated === true`.
 */
export function checkInstallMarker(input: MarkerCheckInput): MarkerCheckResult {
    const { lastInstallMarker, currentDeviceId, storage, generateUuid } = input;

    let currentMarker = storage.get(MARKER_KEY);
    if (!currentMarker) {
        currentMarker = generateUuid();
        storage.set(MARKER_KEY, currentMarker);
    }

    // First run: remember the marker but don't regenerate anything.
    if (!lastInstallMarker) {
        return {
            nextInstallMarker: currentMarker,
            nextDeviceId: currentDeviceId,
            regenerated: false,
        };
    }

    // Markers match: same install as last time, no-op.
    if (lastInstallMarker === currentMarker) {
        return {
            nextInstallMarker: currentMarker,
            nextDeviceId: currentDeviceId,
            regenerated: false,
        };
    }

    // Mismatch: vault was opened on a different install. Regenerate.
    return {
        nextInstallMarker: currentMarker,
        nextDeviceId: generateUuid(),
        regenerated: true,
        previousDeviceId: currentDeviceId,
    };
}

export const INSTALL_MARKER_KEY = MARKER_KEY;
