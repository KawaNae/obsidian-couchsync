import { describe, it, expect } from "vitest";
import {
    checkInstallMarker,
    INSTALL_MARKER_KEY,
    type InstallMarkerStorage,
} from "../src/sync/install-marker.ts";

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

describe("checkInstallMarker (advisory only)", () => {
    it("first run (no lastInstallMarker): generates and stores marker, no mismatch", () => {
        uuidCounter = 0;
        const storage = memStorage();
        const result = checkInstallMarker({
            lastInstallMarker: undefined,
            storage,
            generateUuid: fakeUuid,
        });
        expect(result.markerMismatch).toBe(false);
        expect(result.nextInstallMarker).toBe("uuid-1");
        expect(storage.dump()[INSTALL_MARKER_KEY]).toBe("uuid-1");
    });

    it("match (same install): no mismatch, marker stable", () => {
        uuidCounter = 0;
        const storage = memStorage({ [INSTALL_MARKER_KEY]: "install-XYZ" });
        const result = checkInstallMarker({
            lastInstallMarker: "install-XYZ",
            storage,
            generateUuid: fakeUuid,
        });
        expect(result.markerMismatch).toBe(false);
        expect(result.nextInstallMarker).toBe("install-XYZ");
        expect(uuidCounter).toBe(0);
    });

    it("mismatch (vault cloned to new install): reports mismatch but does NOT regenerate deviceId", () => {
        uuidCounter = 0;
        const storage = memStorage({ [INSTALL_MARKER_KEY]: "install-NEW" });
        const result = checkInstallMarker({
            lastInstallMarker: "install-OLD",
            storage,
            generateUuid: fakeUuid,
        });
        expect(result.markerMismatch).toBe(true);
        expect(result.nextInstallMarker).toBe("install-NEW");
        // No deviceId field in result — caller's deviceId is unchanged
    });

    it("localStorage cleared → mismatch reported", () => {
        uuidCounter = 0;
        const storage = memStorage();
        const result = checkInstallMarker({
            lastInstallMarker: "install-from-last-session",
            storage,
            generateUuid: fakeUuid,
        });
        expect(result.markerMismatch).toBe(true);
        expect(result.nextInstallMarker).toBe("uuid-1");
        expect(storage.dump()[INSTALL_MARKER_KEY]).toBe("uuid-1");
    });

    it("does not mutate storage on match", () => {
        uuidCounter = 0;
        const storage = memStorage({ [INSTALL_MARKER_KEY]: "same-marker" });
        const before = storage.dump();
        checkInstallMarker({
            lastInstallMarker: "same-marker",
            storage,
            generateUuid: fakeUuid,
        });
        expect(storage.dump()).toEqual(before);
    });
});
