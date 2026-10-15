/**
 * describeError — the sentence every one-shot failure is shown with.
 *
 * Transport failures used to reach the user as the transport's own words
 * (`Failed to fetch`), with no cause and no fix. Each classified kind now
 * names both and keeps the raw message in parentheses; a domain error's own
 * `userMessage` wins over classification; a cancellation is not a failure.
 */
import { describe, it, expect } from "vitest";
import { BusyError, cancellation, describeError, UserFacingError } from "../src/ui/describe-error.ts";
import { configNotReady, type ConfigNotReadyKind } from "../src/sync/config-errors.ts";
import { AuthGate } from "../src/db/sync/auth-gate.ts";
import { SchemaVersionMismatchError } from "../src/db/sync/schema-gate.ts";

function httpError(status: number, message: string): Error {
    const e: any = new Error(message);
    e.status = status;
    return e;
}

const abort = cancellation;

describe("describeError — classified transport failures", () => {
    it.each([
        ["network", new TypeError("Failed to fetch"), /could not be reached.*server URI in the CouchDB tab/],
        ["timeout", new Error("CouchDB request timed out after 15000ms"), /did not respond in time/],
        ["auth", httpError(401, "unauthorized"), /rejected the credentials \(401\).*CouchDB tab.*Test/],
        ["auth 403", httpError(403, "forbidden"), /rejected the credentials \(403\)/],
        ["server", httpError(503, "unavailable"), /returned an error \(503\)/],
        ["not-found", httpError(404, "not_found"), /not found on the server \(404\)/],
    ])("%s: names the cause and the fix, then the raw message", (_k, err, pattern) => {
        const d = describeError(err);
        expect(d.outcome).toBe("failed");
        expect(d.text).toMatch(pattern);
        expect(d.text.endsWith(`(${(err as Error).message})`)).toBe(true);
    });

    it("an interrupted request (not a cancel) says so", () => {
        const d = describeError(new Error("the request was aborted by the OS"));
        expect(d.outcome).toBe("failed");
        expect(d.text).toMatch(/interrupted/);
    });

    it("an unknown error is shown as thrown", () => {
        expect(describeError(new Error("boom"))).toEqual({ text: "boom", outcome: "failed" });
        expect(describeError("plain string")).toEqual({ text: "plain string", outcome: "failed" });
    });
});

describe("describeError — userMessage wins over classification", () => {
    it("a ConfigNotReadyError is shown as written", () => {
        const e = configNotReady("unattached", { db: "cfg" });
        expect(describeError(e)).toEqual({ text: e.message, outcome: "failed" });
    });

    it("a sentence that happens to contain transport words is not reclassified", () => {
        const e = new UserFacingError("Could not fetch the plan; nothing was changed.");
        expect(describeError(e).text).toBe("Could not fetch the plan; nothing was changed.");
    });

    it("a schema mismatch shows its migration instruction", () => {
        const e = new SchemaVersionMismatchError("config:x", 1, "config", 3);
        expect(describeError(e).text).toBe(e.userMessage);
    });

    it("an auth latch refusal points to the CouchDB tab", () => {
        const gate = new AuthGate();
        gate.raise(401, "bad");
        expect(describeError(gate.blockedError()).text)
            .toMatch(/rejected the credentials \(401\).*CouchDB tab, then press Test/);
    });

    it("key and passphrase problems never suggest Create", () => {
        const kinds: ConfigNotReadyKind[] = [
            "key-missing", "passphrase-missing", "passphrase-mismatch",
            "root-changed", "encryption-removed", "cipher-downgrade",
        ];
        for (const kind of kinds) {
            expect(describeError(configNotReady(kind, { db: "cfg" })).text, kind)
                .not.toMatch(/\bCreate\b/);
        }
    });
});

describe("describeError — cancellation", () => {
    it("an AbortError is a cancellation, not a failure", () => {
        expect(describeError(abort())).toEqual({ text: "", outcome: "cancelled" });
    });

    it("keeps what the cancel left behind", () => {
        expect(describeError(abort("Nothing was changed."))).toEqual({
            text: "Nothing was changed.", outcome: "cancelled",
        });
    });
});

describe("describeError — refusal", () => {
    it("another operation running is a refusal, worded by what runs", () => {
        expect(describeError(new BusyError("Init is running — wait for it to finish."))).toEqual({
            text: "Init is running — wait for it to finish.", outcome: "refused",
        });
    });

    it("the other preconditions stay failures", () => {
        const auth = new AuthGate();
        auth.raise(401, "bad");
        expect(describeError(auth.blockedError()).outcome).toBe("failed");
        expect(describeError(configNotReady("unattached", { db: "cfg" })).outcome).toBe("failed");
        expect(describeError(new UserFacingError("The database is empty.")).outcome).toBe("failed");
    });
});
