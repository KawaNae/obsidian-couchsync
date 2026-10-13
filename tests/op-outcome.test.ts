import { describe, it, expect } from "vitest";
import { OutcomeLedger, type OpOutcome } from "../src/sync/op-outcome.ts";

type Op = "write" | "probe";

function o(patch: Partial<OpOutcome<Op>>): OpOutcome<Op> {
    return { op: "write", at: 1, against: "t", error: null, ...patch };
}

describe("OutcomeLedger", () => {
    const ledger = () => new OutcomeLedger<Op>((op) => op === "probe");

    it("keeps operations and checks in separate slots", () => {
        const l = ledger();
        l.record(o({ op: "write", at: 1, error: new Error("w") }));
        l.record(o({ op: "probe", at: 2 }));
        expect(l.view("t")).toMatchObject({
            lastOp: { op: "write", error: expect.any(Error) },
            lastCheck: { op: "probe", error: null },
        });
    });

    it("drops an outcome that started before the recorded one", () => {
        const l = ledger();
        l.record(o({ at: 10 }));
        l.record(o({ at: 5, error: new Error("late") }));
        expect(l.view("t").lastOp).toMatchObject({ at: 10, error: null });
    });

    it("a successful operation clears an earlier failed check, not a later one", () => {
        const l = ledger();
        l.record(o({ op: "probe", at: 10, error: new Error("p") }));
        l.record(o({ op: "write", at: 5 }));
        expect(l.view("t").lastCheck).not.toBeNull();
        l.record(o({ op: "write", at: 20 }));
        expect(l.view("t").lastCheck).toBeNull();
    });

    it("a successful check does not clear a failed operation", () => {
        const l = ledger();
        l.record(o({ op: "write", at: 1, error: new Error("w") }));
        l.record(o({ op: "probe", at: 2 }));
        expect(l.view("t").lastOp?.error).toBeInstanceOf(Error);
    });

    it("shows only outcomes about the target asked for", () => {
        const l = ledger();
        l.record(o({ against: "old", error: new Error("old") }));
        expect(l.view("new")).toEqual({ lastOp: null, lastCheck: null });
        expect(l.view("old").lastOp).not.toBeNull();
    });
});
