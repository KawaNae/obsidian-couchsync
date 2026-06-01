import { describe, it, expect } from "vitest";
import { latestDevice, mergeVC, compareVC } from "../../src/sync/vector-clock.ts";

describe("latestDevice", () => {
    it("returns the device with the highest counter", () => {
        expect(latestDevice({ a: 1, b: 3, c: 2 })).toBe("b");
    });

    it("returns null for an empty clock", () => {
        expect(latestDevice({})).toBeNull();
    });

    // H-2 root: the result must be a pure function of the clock's CONTENT, not
    // of its key insertion order. mergeVC can persist the same logical clock
    // with different key order on different devices; an order-dependent
    // latestDevice would then disagree across devices.
    it("breaks ties deterministically, independent of key insertion order", () => {
        expect(latestDevice({ A: 1, C: 1 })).toBe("A");
        expect(latestDevice({ C: 1, A: 1 })).toBe("A"); // not 'C' — lexicographically smallest
        expect(latestDevice({ z: 5, a: 5, m: 5 })).toBe("a");
    });
});

describe("mergeVC key-order (H-2 precondition)", () => {
    it("yields the same logical clock with order depending on argument order", () => {
        const m1 = mergeVC({ A: 1 }, { C: 1 });
        const m2 = mergeVC({ C: 1 }, { A: 1 });
        expect(compareVC(m1, m2)).toBe("equal"); // logically identical
        // ...but the persisted key order differs — which is exactly why
        // latestDevice() must not depend on it (asserted above).
        expect(Object.keys(m1)).toEqual(["A", "C"]);
        expect(Object.keys(m2)).toEqual(["C", "A"]);
        // Despite the key-order divergence, latestDevice agrees:
        expect(latestDevice(m1)).toBe(latestDevice(m2));
    });
});
