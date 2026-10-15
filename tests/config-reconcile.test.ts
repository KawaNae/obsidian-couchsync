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
        expect(decidePull(APP, null, enc("x"), enc("x"), "remote-first")).toEqual({ write: null, conflicts: [], deviceOnlyKept: 0 });
    });

    it("leaves the disk when the merge equals it (only local changed)", () => {
        const d = decidePull(APP, enc(`{"a":1}`), enc(`{"a":2}`), enc(`{"a":1}`), "remote-first");
        expect(d).toEqual({ write: null, conflicts: [], deviceOnlyKept: 0 });
    });

    it("reports a conflict without writing when only the conflicting key differs", () => {
        const d = decidePull(APP, enc(`{"a":1}`), enc(`{"a":2}`), enc(`{"a":3}`), "remote-first");
        expect(d).toEqual({ write: null, conflicts: ["/a"], deviceOnlyKept: 0 });
    });

    it("falls back to a whole-file comparison when a version is not JSON", () => {
        expect(dec(decidePull(APP, enc("x"), enc("x"), enc(`{"a":1}`), "remote-first").write)).toBe(`{"a":1}`);
        expect(decidePull(APP, enc("x"), enc("y"), enc(`{"a":1}`), "remote-first").conflicts).toEqual([""]);
    });

    it("compares non-JSON files as whole files against the base", () => {
        expect(dec(decidePull(CSS, enc("b"), enc("b"), enc("r"), "remote-first").write)).toBe("r");
        expect(decidePull(CSS, enc("b"), enc("l"), enc("b"), "remote-first")).toEqual({ write: null, conflicts: [], deviceOnlyKept: 0 });
        expect(decidePull(CSS, enc("b"), enc("l"), enc("r"), "remote-first")).toEqual({ write: null, conflicts: [""], deviceOnlyKept: 0 });
    });

    it("without a base: remote-first takes the shared file, local-first keeps the disk", () => {
        expect(dec(decidePull(CSS, null, enc("l"), enc("r"), "remote-first").write)).toBe("r");
        expect(decidePull(CSS, null, enc("l"), enc("r"), "local-first")).toEqual({ write: null, conflicts: [""], deviceOnlyKept: 0 });
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
        expect(pushContent(APP, d, local)).toBe(local);
    });

    it("sends the base plus the selected changes, in the disk's format", () => {
        const local = enc(`{\n  "b": 2,\n  "a": 2\n}\n`);
        const d = diffForPush(APP, enc(`{"a":1,"b":1}`), local)!;
        if (d.kind !== "json") throw new Error("expected a JSON diff");
        const onlyA = d.changes.filter((c) => c.kind === "set" && c.pointer === "/a");
        expect(dec(pushContent(APP, d, local, onlyA))).toBe(`{\n  "b": 1,\n  "a": 2\n}\n`);
    });
});

describe("this device's own keys", () => {
    const PLUGINS = ".obsidian/community-plugins.json";

    it("Pull keeps the disk's value of a declared key and does not report it", () => {
        const d = decidePull(
            APP, enc(`{"a":0,"b":0}`), enc(`{"a":1,"b":0}`), enc(`{"a":2,"b":2}`), "remote-first", { deviceOnly: ["/a"] },
        );
        expect(JSON.parse(dec(d.write)!)).toEqual({ a: 1, b: 2 });
        expect(d.conflicts).toEqual([]);
        expect(d.deviceOnlyKept).toBe(1);
    });

    it("Pull leaves a declared key absent when the disk has none", () => {
        const d = decidePull(APP, null, enc(`{"b":0}`), enc(`{"a":2,"b":0}`), "remote-first", { deviceOnly: ["/a"] });
        expect(d.write).toBeNull();
        expect(d.deviceOnlyKept).toBe(1);
    });

    it("Pull keeps a declared plugin's membership in community-plugins.json", () => {
        const d = decidePull(
            PLUGINS, enc(`["x","y"]`), enc(`["y"]`), enc(`["x","y","z"]`), "remote-first", { deviceOnly: ["/y"] },
        );
        // x: removed here (a local change, kept); z: added remotely (taken);
        // y: declared, stays as on disk.
        expect(JSON.parse(dec(d.write)!)).toEqual(["y", "z"]);
        const d2 = decidePull(PLUGINS, enc(`["y"]`), enc(`["y"]`), enc(`[]`), "remote-first", { deviceOnly: ["/y"] });
        expect(d2.write).toBeNull();
        expect(d2.deviceOnlyKept).toBe(1);
    });

    it("Pull writes the shared value of a key it takes, and keeps the disk's other changes", () => {
        const base = enc(`{"a":0,"b":0}`);
        const d = decidePull(APP, base, enc(`{"a":1,"b":1}`), base, "remote-first", { takeShared: ["/a"] });
        expect(JSON.parse(dec(d.write)!)).toEqual({ a: 0, b: 1 });
        expect(d.conflicts).toEqual([]);
    });

    it("a key taken from the shared version wins over its declaration and is not reported", () => {
        const d = decidePull(
            APP, enc(`{"a":0}`), enc(`{"a":1}`), enc(`{"a":2}`), "remote-first",
            { deviceOnly: ["/a"], takeShared: ["/a"] },
        );
        expect(JSON.parse(dec(d.write)!)).toEqual({ a: 2 });
        expect(d.conflicts).toEqual([]);
        expect(d.deviceOnlyKept).toBe(0);
    });

    it("a key taken that the shared version does not have is removed", () => {
        const d = decidePull(APP, enc(`{}`), enc(`{"a":1}`), enc(`{}`), "remote-first", { takeShared: ["/a"] });
        expect(JSON.parse(dec(d.write)!)).toEqual({});
    });

    it("a plugin taken follows the shared membership in community-plugins.json", () => {
        const on = decidePull(PLUGINS, enc(`["y"]`), enc(`[]`), enc(`["y"]`), "remote-first", { takeShared: ["/y"] });
        expect(JSON.parse(dec(on.write)!)).toEqual(["y"]);
        const off = decidePull(PLUGINS, enc(`[]`), enc(`["y"]`), enc(`[]`), "remote-first", { takeShared: ["/y"] });
        expect(JSON.parse(dec(off.write)!)).toEqual([]);
    });

    it("Push leaves a declared key at the base's value, even under a selected change", () => {
        const local = enc(`{"a":1,"n":{"x":1,"mine":1}}`);
        const d = diffForPush(APP, enc(`{"a":0}`), local)!;
        expect(JSON.parse(dec(pushContent(APP, d, local, "all", ["/n/mine"]))!))
            .toEqual({ a: 1, n: { x: 1 } });
    });

    it("Push sends a set without the declared member's change", () => {
        const local = enc(`["a","b"]`);
        const d = diffForPush(PLUGINS, enc(`["a","c"]`), local)!;
        expect(JSON.parse(dec(pushContent(PLUGINS, d, local, "all", ["/b"]))!)).toEqual(["a"]);
    });
});
