/**
 * The "CouchSync: " prefix is added once per exit: by log.ts for the
 * console and by `showNotice` (notices.ts) for every Obsidian Notice.
 * Message text carries no prefix, so the ring buffer and the Log View keep
 * the bare text and a notice or console line never reads
 * "CouchSync: CouchSync: …".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
    PLUGIN_PREFIX, clearLog, getLogEntries, initLog,
    logDebug, logError, logInfo, logWarn, notify,
} from "../src/ui/log.ts";
import { noticeText } from "../src/ui/notices.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const path = join(dir, e.name);
        if (e.isDirectory()) return sourceFiles(path);
        return e.name.endsWith(".ts") ? [path] : [];
    });
}

function findLines(pattern: RegExp, allowed: string[]): string[] {
    const hits: string[] = [];
    for (const file of sourceFiles(SRC)) {
        const rel = relative(ROOT, file).split("\\").join("/");
        if (allowed.includes(rel)) continue;
        readFileSync(file, "utf8").split("\n").forEach((line, i) => {
            if (pattern.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    return hits;
}

describe("plugin prefix in the source", () => {
    it("no message text starts with the prefix", () => {
        const hits = findLines(/["'`]CouchSync:/, [
            // Defines PLUGIN_PREFIX.
            "src/ui/log.ts",
            // A dialog heading, not a notice or a log line.
            "src/ui/passphrase-modal.ts",
        ]);
        expect(hits).toEqual([]);
    });

    it("every Obsidian Notice is created by showNotice", () => {
        expect(findLines(/new Notice\(/, ["src/ui/notices.ts"])).toEqual([]);
    });
});

describe("plugin prefix at the exits", () => {
    let shown: string[];
    let consoleLines: string[];

    beforeEach(() => {
        clearLog();
        shown = [];
        consoleLines = [];
        initLog(() => ({ verboseNotice: true }), (msg) => { shown.push(noticeText(msg)); });
        const capture = (...args: unknown[]) => { consoleLines.push(String(args[0])); };
        vi.spyOn(console, "log").mockImplementation(capture);
        vi.spyOn(console, "warn").mockImplementation(capture);
        vi.spyOn(console, "error").mockImplementation(capture);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        initLog(() => ({ verboseNotice: false }), () => {});
    });

    it("console and notices get the prefix once; the log keeps the bare text", () => {
        logDebug("d");
        logInfo("i");
        logWarn("w");
        logError("e");
        notify("n");
        expect(consoleLines).toEqual(["d", "i", "w", "e"].map((m) => PLUGIN_PREFIX + m));
        expect(shown).toEqual(["i", "e", "n"].map((m) => PLUGIN_PREFIX + m));
        expect(getLogEntries().map((e) => e.message)).toEqual(["d", "i", "w", "e", "n"]);
    });
});
