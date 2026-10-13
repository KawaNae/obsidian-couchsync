import { describe, it, expect } from "vitest";
import {
    decidePull,
    diffForPush,
    isKeyedJsonPath,
    pushContent,
} from "../src/sync/config-reconcile.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);
const APP = ".obsidian/app.json";
const CSS = ".obsidian/snippets/a.css";

describe("isKeyedJsonPath", () => {
    it("merges settings JSON key by key; plugin code, manifests and themes as files", () => {
        expect(isKeyedJsonPath(APP)).toBe(true);
        expect(isKeyedJsonPath(".obsidian/graph.json")).toBe(true);
        expect(isKeyedJsonPath(".obsidian/community-plugins.json")).toBe(true);
        expect(isKeyedJsonPath(".obsidian/plugins/foo/data.json")).toBe(true);
        expect(isKeyedJsonPath(".obsidian/plugins/foo/manifest.json")).toBe(false);
        expect(isKeyedJsonPath(".obsidian/themes/t/manifest.json")).toBe(false);
        expect(isKeyedJsonPath(CSS)).toBe(false);
    });
});

describe("decidePull", () => {
    it("writes the shared content when the file is missing on disk", () => {
        const d = decidePull(APP, enc("{}"), null, enc(`{"a":1}`), "remote-first");
        expect(dec(d.write)).toBe(`{"a":1}`);
    });

    it("leaves a disk that already equals the shared content", () => {
        expect(decidePull(APP, null, enc("x"), enc("x"), "remote-first")).toEqual({ write: null, conflicts: [] });
    });

    it("leaves the disk when the merge equals it (only local changed)", () => {
        const d = decidePull(APP, enc(`{"a":1}`), enc(`{"a":2}`), enc(`{"a":1}`), "remote-first");
        expect(d).toEqual({ write: null, conflicts: [] });
    });

    it("reports a conflict without writing when only the conflicting key differs", () => {
        const d = decidePull(APP, enc(`{"a":1}`), enc(`{"a":2}`), enc(`{"a":3}`), "remote-first");
        expect(d).toEqual({ write: null, conflicts: ["/a"] });
    });

    it("falls back to a whole-file comparison when a version is not JSON", () => {
        expect(dec(decidePull(APP, enc("x"), enc("x"), enc(`{"a":1}`), "remote-first").write)).toBe(`{"a":1}`);
        expect(decidePull(APP, enc("x"), enc("y"), enc(`{"a":1}`), "remote-first").conflicts).toEqual([""]);
    });

    it("compares non-JSON files as whole files against the base", () => {
        expect(dec(decidePull(CSS, enc("b"), enc("b"), enc("r"), "remote-first").write)).toBe("r");
        expect(decidePull(CSS, enc("b"), enc("l"), enc("b"), "remote-first")).toEqual({ write: null, conflicts: [] });
        expect(decidePull(CSS, enc("b"), enc("l"), enc("r"), "remote-first")).toEqual({ write: null, conflicts: [""] });
    });

    it("without a base: remote-first takes the shared file, local-first keeps the disk", () => {
        expect(dec(decidePull(CSS, null, enc("l"), enc("r"), "remote-first").write)).toBe("r");
        expect(decidePull(CSS, null, enc("l"), enc("r"), "local-first")).toEqual({ write: null, conflicts: [""] });
    });
});

describe("diffForPush and pushContent", () => {
    it("no change when the disk equals the base, or differs only in formatting", () => {
        expect(diffForPush(APP, enc(`{"a":1}`), enc(`{"a":1}`))).toBeNull();
        expect(diffForPush(APP, enc(`{"a":1,"b":2}`), enc(`{\n  "b": 2,\n  "a": 1\n}\n`))).toBeNull();
    });

    it("a missing base makes the whole file new", () => {
        expect(diffForPush(APP, null, enc("{}"))).toEqual({ kind: "new" });
    });

    it("a JSON change is listed key by key; a file change as a whole", () => {
        const d = diffForPush(APP, enc(`{"a":1}`), enc(`{"a":2}`))!;
        expect(d.kind).toBe("json");
        expect(d.kind === "json" && d.changes).toEqual([{ kind: "set", pointer: "/a", value: 2, added: false }]);
        expect(diffForPush(CSS, enc("a"), enc("b"))).toEqual({ kind: "file" });
    });

    it("sends the disk byte for byte when every change is selected", () => {
        const local = enc(`{\n\t"a": 2\n}`);
        const d = diffForPush(APP, enc(`{"a":1}`), local)!;
        expect(pushContent(d, local)).toBe(local);
    });

    it("sends the base plus the selected changes, in the disk's format", () => {
        const local = enc(`{\n  "b": 2,\n  "a": 2\n}\n`);
        const d = diffForPush(APP, enc(`{"a":1,"b":1}`), local)!;
        if (d.kind !== "json") throw new Error("expected a JSON diff");
        const onlyA = d.changes.filter((c) => c.kind === "set" && c.pointer === "/a");
        expect(dec(pushContent(d, local, onlyA))).toBe(`{\n  "b": 1,\n  "a": 2\n}\n`);
    });
});
