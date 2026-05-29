import { describe, it, expect } from "vitest";
import {
    assertSchemaVersion,
    SchemaVersionMismatchError,
} from "../src/db/sync/schema-gate.ts";
import { classifyError } from "../src/db/sync/errors.ts";

describe("schema-gate", () => {
    it("passes when the version matches", () => {
        expect(() =>
            assertSchemaVersion({ _id: "file:a.md", schemaVersion: 2 }, 2, "file"),
        ).not.toThrow();
    });

    it("throws SchemaVersionMismatchError on a mismatch, carrying kind + versions", () => {
        try {
            assertSchemaVersion({ _id: "file:a.md", schemaVersion: 3 }, 2, "file");
            expect.unreachable("should have thrown");
        } catch (e) {
            expect(e).toBeInstanceOf(SchemaVersionMismatchError);
            const err = e as SchemaVersionMismatchError;
            expect(err.kind).toBe("file");
            expect(err.remoteVersion).toBe(3);
            expect(err.expectedVersion).toBe(2);
            expect(err.nonRetriable).toBe(true);
            expect(err.userMessage).toContain("Init");
        }
    });

    it("treats an undefined schemaVersion as a mismatch", () => {
        expect(() =>
            assertSchemaVersion({ _id: "config:x", schemaVersion: undefined }, 3, "config"),
        ).toThrow(SchemaVersionMismatchError);
    });

    it("config-kind message names the config commands", () => {
        const err = new SchemaVersionMismatchError("config:x", 2, "config", 3);
        expect(err.userMessage).toContain("Config Init");
        expect(err.userMessage).toContain("Config Pull");
    });

    // The storm-avoidance contract: a schema mismatch must classify as a
    // TERMINAL kind so the SyncEngine halts instead of retrying the same
    // un-decodable batch forever.
    it("classifyError maps SchemaVersionMismatchError to terminal schema-mismatch", () => {
        const err = new SchemaVersionMismatchError("file:a.md", 3, "file", 2);
        const detail = classifyError(err);
        expect(detail.kind).toBe("schema-mismatch");
        // The user-facing migration message is preserved for the notice.
        expect(detail.message).toBe(err.userMessage);
    });

    it("classifyError does not treat ordinary errors as schema-mismatch", () => {
        expect(classifyError(new Error("boom")).kind).not.toBe("schema-mismatch");
        expect(classifyError({ status: 500, message: "x" }).kind).toBe("server");
    });
});
