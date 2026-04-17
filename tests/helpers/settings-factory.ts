/**
 * Shared settings factory for tests. Returns a CouchSyncSettings
 * with sensible defaults that can be overridden per-test.
 */

import { type CouchSyncSettings, DEFAULT_SETTINGS } from "../../src/settings.ts";

export function makeSettings(
    overrides?: Partial<CouchSyncSettings>,
): CouchSyncSettings {
    return {
        ...DEFAULT_SETTINGS,
        deviceId: "test-device",
        ...overrides,
    };
}
