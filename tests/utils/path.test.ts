import { describe, it, expect } from "vitest";
import { toPathKey } from "../../src/utils/path.ts";
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
