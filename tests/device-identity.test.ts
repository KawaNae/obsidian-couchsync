import { describe, it, expect } from "vitest";

/** Device name validation — mirrors vault-sync-tab.ts */
const DEVICE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$/;

function validateDeviceName(name: string): string | null {
    if (!name) return "Device name is required.";
    if (name.length < 2) return "Device name must be at least 2 characters.";
    if (name.length > 30) return "Device name must be 30 characters or fewer.";
    if (!DEVICE_NAME_RE.test(name)) {
        return "Use lowercase letters, numbers, and hyphens only (e.g. desktop, iphone-pro).";
    }
    return null;
}

describe("device name validation", () => {
    it("accepts valid names", () => {
        expect(validateDeviceName("desktop")).toBeNull();
        expect(validateDeviceName("iphone")).toBeNull();
        expect(validateDeviceName("iphone-pro")).toBeNull();
        expect(validateDeviceName("tablet-1")).toBeNull();
        expect(validateDeviceName("a1")).toBeNull();
        expect(validateDeviceName("my-device-name-12345678901234")).toBeNull(); // 30 chars
    });

    it("rejects empty", () => {
        expect(validateDeviceName("")).not.toBeNull();
    });

    it("rejects single character", () => {
        expect(validateDeviceName("a")).not.toBeNull();
    });

    it("rejects uppercase", () => {
        expect(validateDeviceName("Desktop")).not.toBeNull();
        expect(validateDeviceName("IPHONE")).not.toBeNull();
    });

    it("rejects spaces", () => {
        expect(validateDeviceName("my device")).not.toBeNull();
    });

    it("rejects leading/trailing hyphens", () => {
        expect(validateDeviceName("-desktop")).not.toBeNull();
        expect(validateDeviceName("desktop-")).not.toBeNull();
    });

    it("rejects unicode/emoji", () => {
        expect(validateDeviceName("デスクトップ")).not.toBeNull();
        expect(validateDeviceName("📱phone")).not.toBeNull();
    });

    it("rejects names longer than 30 characters", () => {
        expect(validateDeviceName("a".repeat(31))).not.toBeNull();
    });
});

describe("isLocalDevice logic", () => {
    function isLocalDevice(
        writerDeviceId: string | null,
        deviceId: string,
        previousDeviceIds: string[],
    ): boolean {
        if (!writerDeviceId) return false;
        if (writerDeviceId === deviceId) return true;
        return previousDeviceIds.includes(writerDeviceId);
    }

    it("matches current deviceId", () => {
        expect(isLocalDevice("desktop", "desktop", [])).toBe(true);
    });

    it("matches a previous UUID deviceId", () => {
        expect(
            isLocalDevice("86f6a0ae-6323-4992-b1f5-e1f2990d1c94", "desktop", [
                "86f6a0ae-6323-4992-b1f5-e1f2990d1c94",
            ]),
        ).toBe(true);
    });

    it("does not match a different device", () => {
        expect(isLocalDevice("iphone", "desktop", [])).toBe(false);
    });

    it("does not match null", () => {
        expect(isLocalDevice(null, "desktop", [])).toBe(false);
    });

    it("matches with multiple previous IDs", () => {
        const previous = ["uuid-old-1", "uuid-old-2", "old-name"];
        expect(isLocalDevice("uuid-old-2", "desktop", previous)).toBe(true);
        expect(isLocalDevice("unknown", "desktop", previous)).toBe(false);
    });
});

describe("legacy deviceId detection", () => {
    const isLegacy = (id: string) => /^[0-9a-f]{8}-/.test(id);

    it("detects UUID-style IDs as legacy", () => {
        expect(isLegacy("86f6a0ae-6323-4992-b1f5-e1f2990d1c94")).toBe(true);
        expect(isLegacy("b440c37b-5965-45c2-a390-6b504e9a5ecc")).toBe(true);
    });

    it("does not flag human-readable names", () => {
        expect(isLegacy("desktop")).toBe(false);
        expect(isLegacy("iphone-pro")).toBe(false);
        expect(isLegacy("tablet-1")).toBe(false);
    });
});
