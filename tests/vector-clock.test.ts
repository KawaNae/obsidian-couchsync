import { describe, it, expect } from "vitest";
import {
    compareVC,
    mergeVC,
    incrementVC,
    findDominator,
    latestDevice,
    type VectorClock,
} from "../src/sync/vector-clock.ts";

describe("compareVC", () => {
    it("returns equal for two empty clocks", () => {
        expect(compareVC({}, {})).toBe("equal");
    });

    it("returns equal for identical clocks", () => {
        expect(compareVC({ A: 3, B: 2 }, { A: 3, B: 2 })).toBe("equal");
    });

    it("treats missing key as 0 — {} is dominated by {A:1}", () => {
        expect(compareVC({}, { A: 1 })).toBe("dominated");
        expect(compareVC({ A: 1 }, {})).toBe("dominates");
    });

    it("dominates when strictly greater in one key, equal in others", () => {
        expect(compareVC({ A: 2, B: 1 }, { A: 1, B: 1 })).toBe("dominates");
    });

    it("dominated when strictly less in one key, equal in others", () => {
        expect(compareVC({ A: 1, B: 1 }, { A: 2, B: 1 })).toBe("dominated");
    });

    it("concurrent when one is greater and the other is less", () => {
        expect(compareVC({ A: 1, B: 0 }, { A: 0, B: 1 })).toBe("concurrent");
        expect(compareVC({ A: 2, B: 1 }, { A: 1, B: 2 })).toBe("concurrent");
    });

    it("concurrent across disjoint keys", () => {
        expect(compareVC({ A: 1 }, { B: 1 })).toBe("concurrent");
    });

    it("dominates when superset of keys with all >=", () => {
        expect(compareVC({ A: 1, B: 1 }, { A: 1 })).toBe("dominates");
    });
});

describe("mergeVC", () => {
    it("returns per-key max", () => {
        expect(mergeVC({ A: 1, B: 3 }, { A: 2, B: 1, C: 5 })).toEqual({
            A: 2,
            B: 3,
            C: 5,
        });
    });

    it("is commutative", () => {
        const a: VectorClock = { A: 1, B: 3 };
        const b: VectorClock = { A: 2, C: 5 };
        expect(mergeVC(a, b)).toEqual(mergeVC(b, a));
    });

    it("is idempotent", () => {
        const a: VectorClock = { A: 1, B: 3 };
        expect(mergeVC(a, a)).toEqual(a);
    });

    it("does not mutate inputs", () => {
        const a: VectorClock = { A: 1 };
        const b: VectorClock = { B: 2 };
        mergeVC(a, b);
        expect(a).toEqual({ A: 1 });
        expect(b).toEqual({ B: 2 });
    });
});

describe("incrementVC", () => {
    it("initializes a key to 1 from undefined base", () => {
        expect(incrementVC(undefined, "A")).toEqual({ A: 1 });
    });

    it("initializes a key to 1 from empty base", () => {
        expect(incrementVC({}, "A")).toEqual({ A: 1 });
    });

    it("increments an existing key", () => {
        expect(incrementVC({ A: 4 }, "A")).toEqual({ A: 5 });
    });

    it("leaves other keys untouched", () => {
        expect(incrementVC({ A: 4, B: 2 }, "A")).toEqual({ A: 5, B: 2 });
    });

    it("adds a new key without touching others", () => {
        expect(incrementVC({ A: 4 }, "B")).toEqual({ A: 4, B: 1 });
    });

    it("does not mutate the input clock", () => {
        const base: VectorClock = { A: 1 };
        incrementVC(base, "A");
        expect(base).toEqual({ A: 1 });
    });

    it("result dominates the input", () => {
        const base: VectorClock = { A: 4, B: 2 };
        const next = incrementVC(base, "A");
        expect(compareVC(next, base)).toBe("dominates");
    });
});

describe("findDominator", () => {
    it("returns the unique dominator when one exists", () => {
        const a: VectorClock = { X: 1 };
        const b: VectorClock = { X: 2 };
        const c: VectorClock = { X: 3 };
        expect(findDominator([a, b, c])).toBe(c);
    });

    it("returns null when no single entry dominates all others", () => {
        const a: VectorClock = { X: 1, Y: 0 };
        const b: VectorClock = { X: 0, Y: 1 };
        expect(findDominator([a, b])).toBeNull();
    });

    it("returns the single element for a one-item list", () => {
        const a: VectorClock = { X: 1 };
        expect(findDominator([a])).toBe(a);
    });

    it("returns null for empty list", () => {
        expect(findDominator([])).toBeNull();
    });

    it("handles equal duplicates — any is fine as dominator", () => {
        const a: VectorClock = { X: 1 };
        const b: VectorClock = { X: 1 };
        // Equal is acceptable because one trivially "dominates or equals" the other.
        expect(findDominator([a, b])).not.toBeNull();
    });
});

describe("latestDevice", () => {
    it("returns the device whose counter is highest among distinct keys", () => {
        expect(latestDevice({ A: 2, B: 5, C: 1 })).toBe("B");
    });

    it("returns null for empty clock", () => {
        expect(latestDevice({})).toBeNull();
    });

    it("is stable when ties exist (returns one of them)", () => {
        const result = latestDevice({ A: 3, B: 3 });
        expect(["A", "B"]).toContain(result);
    });
});
