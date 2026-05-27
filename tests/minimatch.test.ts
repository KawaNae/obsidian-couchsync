import { describe, it, expect } from "vitest";
import { minimatch } from "../src/utils/minimatch.ts";

describe("minimatch", () => {
    describe("basic glob patterns", () => {
        it("matches * (single segment wildcard)", () => {
            expect(minimatch("note.md", "*.md")).toBe(true);
            expect(minimatch("note.txt", "*.md")).toBe(false);
            expect(minimatch("a/b.md", "*.md")).toBe(false);
        });

        it("matches ** (recursive wildcard)", () => {
            expect(minimatch("a/b/c.md", "**")).toBe(true);
            expect(minimatch("file.md", "**")).toBe(true);
        });

        it("matches **/ (directory prefix)", () => {
            expect(minimatch("deep/nested/file.tmp", "**/file.tmp")).toBe(true);
            expect(minimatch("file.tmp", "**/file.tmp")).toBe(true);
            expect(minimatch("file.md", "**/file.tmp")).toBe(false);
        });

        it("matches ? (single char)", () => {
            expect(minimatch("a.md", "?.md")).toBe(true);
            expect(minimatch("ab.md", "?.md")).toBe(false);
            expect(minimatch("/.md", "?.md")).toBe(false);
        });

        it("escapes . as literal dot", () => {
            expect(minimatch("a.md", "a.md")).toBe(true);
            expect(minimatch("axmd", "a.md")).toBe(false);
        });
    });

    describe("regex metacharacter escaping", () => {
        it("treats parentheses as literals", () => {
            expect(minimatch("file(1).md", "file(1).md")).toBe(true);
            expect(minimatch("file1.md", "file(1).md")).toBe(false);
        });

        it("treats + as literal", () => {
            expect(minimatch("a+b.md", "a+b.md")).toBe(true);
            expect(minimatch("aab.md", "a+b.md")).toBe(false);
        });

        it("treats | as literal", () => {
            expect(minimatch("a|b.md", "a|b.md")).toBe(true);
            expect(minimatch("a.md", "a|b.md")).toBe(false);
        });

        it("treats [] as literals", () => {
            expect(minimatch("a[0].md", "a[0].md")).toBe(true);
            expect(minimatch("a0.md", "a[0].md")).toBe(false);
        });

        it("treats ^ and $ as literals", () => {
            expect(minimatch("^start", "^start")).toBe(true);
            expect(minimatch("end$", "end$")).toBe(true);
        });

        it("prevents regex injection via glob pattern", () => {
            expect(minimatch("(a+)+b", "(a+)+b")).toBe(true);
            expect(minimatch("aaaaaaaaab", "(a+)+b")).toBe(false);
        });
    });

    describe("caching", () => {
        it("returns consistent results across calls with same pattern", () => {
            expect(minimatch("a.tmp", "*.tmp")).toBe(true);
            expect(minimatch("b.tmp", "*.tmp")).toBe(true);
            expect(minimatch("c.md", "*.tmp")).toBe(false);
        });
    });
});
