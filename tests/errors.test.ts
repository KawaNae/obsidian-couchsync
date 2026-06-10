import { describe, it, expect } from "vitest";
import { classifyError } from "../src/db/sync/errors.ts";
import { EncryptionError } from "../src/db/codec-errors.ts";

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

    it("non-retriable EncryptionError → schema-mismatch (terminal, #enc-1)", () => {
        // cipherVersion downgrade gate / encBody HMAC mismatch are policy
        // violations: retrying never succeeds, so they must halt like a
        // schema mismatch rather than enter the transient backoff loop.
        const floor = new EncryptionError("cipherVersion-3 floor: refusing unsealed doc", undefined, false);
        const d = classifyError(floor);
        expect(d.kind).toBe("schema-mismatch");
        expect(d.message).toMatch(/floor/);
    });

    it("retriable EncryptionError → unknown (stays transient, #enc-1)", () => {
        // A decrypt failure (key not yet distributed) is transient — it must
        // NOT map to the terminal kind.
        expect(classifyError(new EncryptionError("Failed to decrypt doc x")).kind).toBe("unknown");
        // Default retriable flag is true.
        expect(classifyError(new EncryptionError("boom", new Error("cause"))).kind).toBe("unknown");
    });

    it("AbortError → aborted (inconclusive, not network) (#6)", () => {
        // An abort proves nothing about reachability — it fires both for our
        // own verify timeout AND a mobile suspend-frozen request. Must NOT be
        // mislabeled network/unknown; verifyReachable disambiguates via elapsed.
        expect(classifyError({ name: "AbortError", message: "The operation was aborted." }).kind)
            .toBe("aborted");
        expect(classifyError({ message: "The operation was aborted." }).kind).toBe("aborted");
        const e = new Error("aborted"); e.name = "AbortError";
        expect(classifyError(e).kind).toBe("aborted");
    });

    it("encryptionPaused marker → encryption-paused (terminal, #1c)", () => {
        const e = Object.assign(new Error("Sync paused — wrong passphrase"), { encryptionPaused: true });
        const d = classifyError(e);
        expect(d.kind).toBe("encryption-paused");
        expect(d.message).toMatch(/passphrase/);
    });
});
