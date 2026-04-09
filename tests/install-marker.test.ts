import { describe, it, expect } from "vitest";
import {
    checkInstallMarker,
    INSTALL_MARKER_KEY,
    type InstallMarkerStorage,
} from "../src/sync/install-marker.ts";

/**
 * In-memory storage double — the real one uses window.localStorage but
 * that's unavailable in node. Tests exercise checkInstallMarker as a
 * pure function with injected storage.
 */
function memStorage(initial: Record<string, string> = {}): InstallMarkerStorage & {
    dump(): Record<string, string>;
} {
    const data = { ...initial };
    return {
        get: (k) => data[k] ?? null,
        set: (k, v) => {
            data[k] = v;
        },
        dump: () => ({ ...data }),
    };
}

let uuidCounter = 0;
function fakeUuid(): string {
    uuidCounter += 1;
    return `uuid-${uuidCounter}`;
}

describe("checkInstallMarker", () => {
    it("first run (no lastInstallMarker): generates and stores marker, keeps deviceId", () => {
        uuidCounter = 0;
        const storage = memStorage();
        const result = checkInstallMarker({
            lastInstallMarker: undefined,
            currentDeviceId: "device-A",
            storage,
            generateUuid: fakeUuid,
        });
        expect(result.regenerated).toBe(false);
        expect(result.nextDeviceId).toBe("device-A");
        expect(result.nextInstallMarker).toBe("uuid-1");
        expect(storage.dump()[INSTALL_MARKER_KEY]).toBe("uuid-1");
    });

    it("match (same install): no regeneration, marker stable", () => {
        uuidCounter = 0;
        const storage = memStorage({ [INSTALL_MARKER_KEY]: "install-XYZ" });
        const result = checkInstallMarker({
            lastInstallMarker: "install-XYZ",
            currentDeviceId: "device-A",
            storage,
            generateUuid: fakeUuid,
        });
        expect(result.regenerated).toBe(false);
        expect(result.nextDeviceId).toBe("device-A");
        expect(result.nextInstallMarker).toBe("install-XYZ");
        // No new UUIDs should have been minted
        expect(uuidCounter).toBe(0);
    });

    it("mismatch (vault cloned to new install): regenerates deviceId", () => {
        uuidCounter = 0;
        // Storage has a DIFFERENT marker than what the vault remembers
        const storage = memStorage({ [INSTALL_MARKER_KEY]: "install-NEW" });
        const result = checkInstallMarker({
            lastInstallMarker: "install-OLD",
            currentDeviceId: "device-OLD",
            storage,
            generateUuid: fakeUuid,
        });
        expect(result.regenerated).toBe(true);
        expect(result.previousDeviceId).toBe("device-OLD");
        expect(result.nextDeviceId).toBe("uuid-1");
        expect(result.nextDeviceId).not.toBe("device-OLD");
        expect(result.nextInstallMarker).toBe("install-NEW");
    });

    it("first run with empty storage AND undefined lastInstallMarker bootstraps correctly", () => {
        uuidCounter = 0;
        const storage = memStorage();
        const result = checkInstallMarker({
            lastInstallMarker: undefined,
            currentDeviceId: "",
            storage,
            generateUuid: fakeUuid,
        });
        // Empty deviceId is a pre-condition managed by the caller — the
        // marker check does NOT mint a deviceId on first run, only on
        // mismatch. Document this contract.
        expect(result.nextDeviceId).toBe("");
        expect(result.regenerated).toBe(false);
    });

    it("lastInstallMarker set but localStorage empty → treat as new install", () => {
        // Scenario: localStorage was cleared (user repaired OS install or
        // cleared Obsidian's cache) but data.json still remembers the
        // old marker. Fresh marker is minted and the mismatch triggers
        // regeneration.
        uuidCounter = 0;
        const storage = memStorage();
        const result = checkInstallMarker({
            lastInstallMarker: "install-from-last-session",
            currentDeviceId: "device-OLD",
            storage,
            generateUuid: fakeUuid,
        });
        expect(result.regenerated).toBe(true);
        expect(result.previousDeviceId).toBe("device-OLD");
        // uuid-1 was used for the new marker, uuid-2 for the new deviceId
        expect(result.nextInstallMarker).toBe("uuid-1");
        expect(result.nextDeviceId).toBe("uuid-2");
        // And the marker was persisted
        expect(storage.dump()[INSTALL_MARKER_KEY]).toBe("uuid-1");
    });

    it("does not mutate storage on match", () => {
        uuidCounter = 0;
        const storage = memStorage({ [INSTALL_MARKER_KEY]: "same-marker" });
        const before = storage.dump();
        checkInstallMarker({
            lastInstallMarker: "same-marker",
            currentDeviceId: "device-A",
            storage,
            generateUuid: fakeUuid,
        });
        expect(storage.dump()).toEqual(before);
    });
});
