/**
 * ProgressNotice — the exit of every one-shot operation.
 *
 * The label is added once, by ProgressNotice; the "CouchSync: " prefix is
 * added once, by `noticeText` at the notice exit. When both ProgressNotice
 * and its callers added them, a notice read "CouchSync: CouchSync: Config
 * Pull — Config Pull failed: …".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ProgressNotice, noticeText, reportError } from "../src/ui/notices.ts";
import { clearLog, getLogEntries, initLog } from "../src/ui/log.ts";
import { configNotReady } from "../src/sync/config-errors.ts";
import { SchemaVersionMismatchError } from "../src/db/sync/schema-gate.ts";
import { BusyError, cancellation } from "../src/ui/describe-error.ts";
import { AuthGate } from "../src/db/sync/auth-gate.ts";

const abort = cancellation;

describe("ProgressNotice", () => {
    let shown: string[];

    beforeEach(() => {
        clearLog();
        shown = [];
        // The text the host's sink (`showNotice`) puts on each notice.
        initLog(() => ({ verboseNotice: false }), (msg) => { shown.push(noticeText(msg)); });
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        initLog(() => ({ verboseNotice: false }), () => {});
    });

    it("fail: '<label> failed — <cause and fix>', prefixed exactly once", () => {
        new ProgressNotice("Config Pull").fail(new TypeError("Failed to fetch"));
        const errors = getLogEntries().filter((e) => e.level === "error");
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toMatch(/^Config Pull failed — The server could not be reached/);
        expect(shown).toHaveLength(1);
        expect(shown[0]).toMatch(/^CouchSync: Config Pull failed — /);
        expect(shown[0]).not.toMatch(/CouchSync: CouchSync:/);
    });

    it("fail with a domain error shows its sentence and logs the raw error at debug", () => {
        const e = new SchemaVersionMismatchError("config:x", 1, "config", 3);
        new ProgressNotice("Config Pull").fail(e);
        const entries = getLogEntries();
        expect(entries.find((x) => x.level === "error")?.message)
            .toBe(`Config Pull failed — ${e.userMessage}`);
        expect(entries.some((x) => x.level === "debug" && x.message.includes(e.message))).toBe(true);
    });

    it("fail does not repeat a message the sentence already contains", () => {
        const e = configNotReady("unattached", { db: "cfg" });
        new ProgressNotice("Config Push").fail(e);
        expect(getLogEntries().filter((x) => x.message.includes("raw error"))).toEqual([]);
    });

    it("a cancellation is a warning, not an error notice", () => {
        new ProgressNotice("Config Join").fail(abort("Nothing was changed."));
        const entries = getLogEntries();
        expect(entries.filter((e) => e.level === "error")).toEqual([]);
        expect(entries.find((e) => e.level === "warn")?.message)
            .toBe("Config Join cancelled — Nothing was changed.");
        expect(shown).toEqual([]);
    });

    it("a bare cancellation reads '<label> cancelled'", () => {
        new ProgressNotice("Clone").fail(abort());
        expect(getLogEntries().find((e) => e.level === "warn")?.message).toBe("Clone cancelled");
    });

    it("a refusal (another operation runs) is '<label> not started — <what runs>', a warning", () => {
        new ProgressNotice("Init").fail(new BusyError("Config Pull is running — wait for it to finish."));
        const entries = getLogEntries();
        expect(entries.filter((e) => e.level === "error")).toEqual([]);
        expect(entries.find((e) => e.level === "warn")?.message)
            .toBe("Init not started — Config Pull is running — wait for it to finish.");
        expect(shown).toEqual([]);
    });

    it("a precondition that is not another operation running stays a failure", () => {
        const auth = new AuthGate();
        auth.raise(401, "unauthorized");
        new ProgressNotice("Clone").fail(auth.blockedError());
        new ProgressNotice("Config Pull").fail(configNotReady("unattached", { db: "cfg" }));
        const errors = getLogEntries().filter((e) => e.level === "error").map((e) => e.message);
        expect(errors).toEqual([
            expect.stringMatching(/^Clone failed — /),
            expect.stringMatching(/^Config Pull failed — This device has not joined/),
        ]);
    });

    it("done: '<label> — <summary>', prefixed exactly once", () => {
        new ProgressNotice("Verify").done("0 discrepancy(ies)");
        expect(shown).toEqual(["CouchSync: Verify — 0 discrepancy(ies)"]);
    });
});

describe("reportError — the end of an action without a ProgressNotice", () => {
    let shown: string[];

    beforeEach(() => {
        clearLog();
        shown = [];
        initLog(() => ({ verboseNotice: false }), (msg) => { shown.push(noticeText(msg)); });
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        initLog(() => ({ verboseNotice: false }), () => {});
    });

    it("words a refusal as ProgressNotice does, as a warning", () => {
        reportError("Server change", new BusyError("Init is running — wait for it to finish."));
        const entries = getLogEntries();
        expect(entries.filter((e) => e.level === "error")).toEqual([]);
        expect(entries.find((e) => e.level === "warn")?.message)
            .toBe("Server change not started — Init is running — wait for it to finish.");
    });

    it("words a failure as ProgressNotice does, as an error", () => {
        reportError("Config database change", new TypeError("Failed to fetch"));
        expect(getLogEntries().filter((e) => e.level === "error").map((e) => e.message)).toEqual([
            expect.stringMatching(/^Config database change failed — The server could not be reached/),
        ]);
        expect(shown).toEqual([expect.stringMatching(/^CouchSync: Config database change failed — /)]);
    });
});
