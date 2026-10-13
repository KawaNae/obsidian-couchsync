/**
 * ProgressNotice — the exit of every one-shot operation.
 *
 * The label is added once, by ProgressNotice; the "CouchSync: " prefix is
 * added once, by `noticeText` at the notice exit. When both ProgressNotice
 * and its callers added them, a notice read "CouchSync: CouchSync: Config
 * Pull — Config Pull failed: …".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ProgressNotice, noticeText } from "../src/ui/notices.ts";
import { clearLog, getLogEntries, initLog } from "../src/ui/log.ts";
import { configNotReady } from "../src/sync/config-errors.ts";
import { SchemaVersionMismatchError } from "../src/db/sync/schema-gate.ts";

function abort(userMessage?: string): Error {
    const e: any = new Error("The operation was aborted.");
    e.name = "AbortError";
    if (userMessage) e.userMessage = userMessage;
    return e;
}

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
        const e = configNotReady("busy");
        new ProgressNotice("Config Push").fail(e);
        expect(getLogEntries().filter((x) => x.message.includes("raw error"))).toEqual([]);
    });

    it("a cancellation is a warning, not an error notice", () => {
        new ProgressNotice("Config Join").fail(abort("nothing was changed."));
        const entries = getLogEntries();
        expect(entries.filter((e) => e.level === "error")).toEqual([]);
        expect(entries.find((e) => e.level === "warn")?.message)
            .toBe("Config Join cancelled — nothing was changed.");
        expect(shown).toEqual([]);
    });

    it("a bare cancellation reads '<label> cancelled'", () => {
        new ProgressNotice("Clone").fail(abort());
        expect(getLogEntries().find((e) => e.level === "warn")?.message).toBe("Clone cancelled");
    });

    it("done: '<label> — <summary>', prefixed exactly once", () => {
        new ProgressNotice("Verify").done("0 discrepancy(ies)");
        expect(shown).toEqual(["CouchSync: Verify — 0 discrepancy(ies)"]);
    });
});
