import { describe, it, expect } from "vitest";
import { classifyError } from "../src/db/sync/errors.ts";

describe("classifyError", () => {
    it("401/403 → auth", () => {
        expect(classifyError({ status: 401, message: "nope" }).kind).toBe("auth");
        expect(classifyError({ status: 403, message: "nope" }).kind).toBe("auth");
    });

    it("5xx → server", () => {
        expect(classifyError({ status: 500, message: "oops" }).kind).toBe("server");
        expect(classifyError({ status: 503, message: "down" }).kind).toBe("server");
    });

    it("timeout patterns → timeout", () => {
        expect(classifyError({ message: "request timed out" }).kind).toBe("timeout");
        expect(classifyError(new Error("Catchup timed out")).kind).toBe("timeout");
    });

    it("network patterns → network", () => {
        expect(classifyError({ message: "ECONNREFUSED" }).kind).toBe("network");
        expect(classifyError({ message: "Failed to fetch" }).kind).toBe("network");
        expect(classifyError({ message: "ENOTFOUND host.example" }).kind).toBe("network");
    });

    it("iOS/Safari 'Load failed' → network (not unknown)", () => {
        // Observed in 2026-04-22 mobile log: WebKit reports fetch failure
        // as "Load failed" rather than "Failed to fetch". Must still be
        // classified as a network error so the retry path runs.
        expect(classifyError({ message: "Load failed" }).kind).toBe("network");
        expect(classifyError(new Error("Load failed")).kind).toBe("network");
    });

    it("unknown fallback", () => {
        expect(classifyError({ message: "something weird" }).kind).toBe("unknown");
    });

    it("HTTP code takes priority over message text", () => {
        expect(classifyError({ status: 401, message: "connection timed out" }).kind).toBe("auth");
    });

    it("preserves status code in detail", () => {
        expect(classifyError({ status: 503, message: "down" }).code).toBe(503);
    });

    it("builds an auth message with the status code", () => {
        const d = classifyError({ status: 403, message: "nope" });
        expect(d.code).toBe(403);
        expect(d.message).toMatch(/403/);
    });

    it("builds a server message embedding the raw message", () => {
        const d = classifyError({ status: 500, message: "oops" });
        expect(d.code).toBe(500);
        expect(d.message).toMatch(/500/);
        expect(d.message).toMatch(/oops/);
    });
});
