/**
 * Tests for write-transaction.ts — DbError + classifier.
 */

import { describe, it, expect } from "vitest";
import {
    DbError,
    classifyDexieError,
    toDbError,
} from "../src/db/write-transaction.ts";

function fakeDexieErr(name: string, inner?: { name: string }): any {
    const err: any = new Error(`fake ${name}`);
    err.name = name;
    if (inner) err.inner = inner;
    return err;
}

describe("classifyDexieError", () => {
    it("recognises QuotaExceededError by name", () => {
        expect(classifyDexieError(fakeDexieErr("QuotaExceededError"))).toBe("quota");
    });

    it("recognises AbortError as transient", () => {
        expect(classifyDexieError(fakeDexieErr("AbortError"))).toBe("abort");
    });

    it("recognises InvalidStateError", () => {
        expect(classifyDexieError(fakeDexieErr("InvalidStateError"))).toBe("invalid-state");
    });

    it("recognises ConstraintError", () => {
        expect(classifyDexieError(fakeDexieErr("ConstraintError"))).toBe("constraint");
    });

    it("unwraps Dexie's `inner` property", () => {
        const wrapped = fakeDexieErr("DexieError", { name: "QuotaExceededError" });
        expect(classifyDexieError(wrapped)).toBe("quota");
    });

    it("treats CouchDB-style 409 as conflict", () => {
        const err: any = new Error("Document update conflict");
        err.status = 409;
        expect(classifyDexieError(err)).toBe("conflict");
    });

    it("falls back to message heuristic for quota", () => {
        expect(classifyDexieError(new Error("DB quota exceeded"))).toBe("quota");
    });

    it("returns unknown for plain errors", () => {
        expect(classifyDexieError(new Error("something else"))).toBe("unknown");
    });

    it("preserves DbError.kind through classify", () => {
        const err = new DbError("abort", null);
        expect(classifyDexieError(err)).toBe("abort");
    });
});

describe("DbError", () => {
    it("isTransient is true only for abort", () => {
        expect(new DbError("abort", null).isTransient()).toBe(true);
        expect(new DbError("quota", null).isTransient()).toBe(false);
        expect(new DbError("conflict", null).isTransient()).toBe(false);
    });

    it("default message includes kind", () => {
        const err = new DbError("quota", new Error("disk full"));
        expect(err.message).toMatch(/quota/);
    });
});

describe("toDbError", () => {
    it("returns the same instance for an existing DbError", () => {
        const orig = new DbError("conflict", null, "custom");
        expect(toDbError(orig)).toBe(orig);
    });

    it("wraps raw error with classified kind", () => {
        const wrapped = toDbError(fakeDexieErr("AbortError"));
        expect(wrapped).toBeInstanceOf(DbError);
        expect(wrapped.kind).toBe("abort");
    });
});
