import { describe, it, expect } from "vitest";
import { toPathKey, unsafeVaultPathReason } from "../../src/utils/path.ts";
import { VCLOCK_KEY_PREFIX, vclockMetaKey } from "../../src/db/dexie-store.ts";

describe("toPathKey", () => {
    it("lowercases ASCII paths", () => {
        expect(toPathKey("Notes/AGENTS.md")).toBe("notes/agents.md");
    });

    it("treats different case as equal keys", () => {
        expect(toPathKey("Note.md")).toBe(toPathKey("note.md"));
        expect(toPathKey("FOO/BAR.md")).toBe(toPathKey("foo/bar.md"));
    });

    it("normalizes Unicode (NFC) so canonically-equivalent paths match", () => {
        // 'é' as precomposed (U+00E9) vs decomposed (U+0065 U+0301)
        const precomposed = "caf\u00e9.md";
        const decomposed = "cafe\u0301.md";
        expect(toPathKey(precomposed)).toBe(toPathKey(decomposed));
    });

    it("preserves path separators and structure", () => {
        expect(toPathKey("A/B/C.md")).toBe("a/b/c.md");
    });

    it("is idempotent", () => {
        const once = toPathKey("Foo/Bar.md");
        expect(toPathKey(once)).toBe(once);
    });
});

describe("unsafeVaultPathReason — remote path trust boundary (#3)", () => {
    it("accepts ordinary vault-relative paths", () => {
        expect(unsafeVaultPathReason("Notes/agents.md")).toBeNull();
        expect(unsafeVaultPathReason("a/b/c.md")).toBeNull();
        expect(unsafeVaultPathReason("file.md")).toBeNull();
        // Leading "." (hidden / .obsidian config) is in-vault, not escape.
        expect(unsafeVaultPathReason(".obsidian/plugins/x/data.json")).toBeNull();
        // Dot-containing names that are NOT exactly ".." are legitimate.
        expect(unsafeVaultPathReason("...rc.md")).toBeNull();
        expect(unsafeVaultPathReason("a/..foo/b.md")).toBeNull();
    });

    it("rejects parent-directory traversal", () => {
        expect(unsafeVaultPathReason("../evil.md")).toMatch(/traversal/);
        expect(unsafeVaultPathReason("a/../../etc/passwd")).toMatch(/traversal/);
        expect(unsafeVaultPathReason("../../.bashrc")).toMatch(/traversal/);
    });

    it("rejects absolute paths and drive letters", () => {
        expect(unsafeVaultPathReason("/etc/passwd")).toMatch(/absolute/);
        expect(unsafeVaultPathReason("C:/Users/Public/x")).toMatch(/drive/);
        expect(unsafeVaultPathReason("c:\\x")).toBeTruthy();
    });

    it("rejects backslash separators (Windows / UNC)", () => {
        expect(unsafeVaultPathReason("..\\..\\x")).toMatch(/backslash/);
        expect(unsafeVaultPathReason("a\\b")).toMatch(/backslash/);
    });

    it("rejects empty paths", () => {
        expect(unsafeVaultPathReason("")).toMatch(/empty/);
    });
});

describe("vclockMetaKey", () => {
    it("normalizes the path portion of the key", () => {
        expect(vclockMetaKey("README.md")).toBe(
            VCLOCK_KEY_PREFIX + "readme.md",
        );
    });

    it("produces the same key for case-only differences", () => {
        expect(vclockMetaKey("Notes/TODO.md")).toBe(
            vclockMetaKey("notes/todo.md"),
        );
    });
});
