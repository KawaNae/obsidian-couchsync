/**
 * Device name validation for CouchSync.
 *
 * Device names are used as vclock keys and CouchDB doc identifiers,
 * so they must be lowercase alphanumeric with optional hyphens.
 */

const DEVICE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$/;

/** Returns an error message if invalid, or null if valid. */
export function validateDeviceName(name: string): string | null {
    if (!name) return "Device name is required.";
    if (name.length < 2) return "Device name must be at least 2 characters.";
    if (name.length > 30) return "Device name must be 30 characters or fewer.";
    if (!DEVICE_NAME_RE.test(name)) {
        return "Use lowercase letters, numbers, and hyphens only (e.g. desktop, iphone-pro).";
    }
    return null;
}
