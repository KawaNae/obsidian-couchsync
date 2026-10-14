import { describe, it, expect } from "vitest";
import {
    applyJsonChanges,
    detectJsonFormat,
    diffJson,
    jsonEqual,
    mergeJson,
    orderLike,
    parseJsonBytes,
    serializeJson,
} from "../src/sync/config-merge.ts";

describe("jsonEqual", () => {
    it("ignores object key order, not array order", () => {
        expect(jsonEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
        expect(jsonEqual([1, 2], [2, 1])).toBe(false);
        expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
        expect(jsonEqual(null, {})).toBe(false);
    });
});

describe("mergeJson with a base", () => {
    const base = { tab: 4, theme: "light", editor: { spell: true, font: 14 } };

    it("takes a key only remote changed and keeps a key only local changed", () => {
        const r = mergeJson(base, { ...base, tab: 2 }, { ...base, theme: "dark" });
        expect(r.value).toEqual({ ...base, tab: 2, theme: "dark" });
        expect(r.conflicts).toEqual([]);
    });

    it("agrees when both changed a key to the same value", () => {
        const r = mergeJson(base, { ...base, tab: 2 }, { ...base, tab: 2 });
        expect(r.value).toEqual({ ...base, tab: 2 });
        expect(r.conflicts).toEqual([]);
    });

    it("keeps local and reports the pointer when both changed a key differently", () => {
        const r = mergeJson(base, { ...base, tab: 2 }, { ...base, tab: 8 });
        expect(r.value).toEqual({ ...base, tab: 2 });
        expect(r.conflicts).toEqual(["/tab"]);
    });

    it("walks nested objects key by key", () => {
        const r = mergeJson(
            base,
            { ...base, editor: { spell: false, font: 14 } },
            { ...base, editor: { spell: true, font: 16 } },
        );
        expect(r.value).toEqual({ ...base, editor: { spell: false, font: 16 } });
        expect(r.conflicts).toEqual([]);
    });

    it("applies a removal made on one side only", () => {
        const { theme: _t, ...noTheme } = base;
        void _t;
        expect(mergeJson(base, base, noTheme).value).toEqual(noTheme);
        expect(mergeJson(base, noTheme, base).value).toEqual(noTheme);
    });

    it("treats a removal against a change as a conflict, keeping local", () => {
        const { tab: _t, ...noTab } = base;
        void _t;
        const r = mergeJson(base, noTab, { ...base, tab: 8 });
        expect(r.value).toEqual(noTab);
        expect(r.conflicts).toEqual(["/tab"]);
    });

    it("merges keys both sides added", () => {
        const r = mergeJson({}, { mine: 1, both: { x: 1 } }, { theirs: 1, both: { y: 1 } });
        expect(r.value).toEqual({ mine: 1, both: { x: 1, y: 1 }, theirs: 1 });
        expect(r.conflicts).toEqual([]);
    });

    it("compares a key whose type changed as a value", () => {
        const r = mergeJson({ k: { a: 1 } }, { k: 5 }, { k: { a: 2 } });
        expect(r.value).toEqual({ k: 5 });
        expect(r.conflicts).toEqual(["/k"]);
    });

    it("treats arrays as one value", () => {
        const b = { "editor:save": [{ key: "S" }] };
        const r = mergeJson(b, { "editor:save": [{ key: "A" }] }, { "editor:save": [{ key: "B" }] });
        expect(r.value).toEqual({ "editor:save": [{ key: "A" }] });
        expect(r.conflicts).toEqual(["/editor:save"]);
    });

    it("escapes / and ~ in pointers", () => {
        const r = mergeJson({ "a/b": 0, "c~d": 0 }, { "a/b": 1, "c~d": 1 }, { "a/b": 2, "c~d": 2 });
        expect(r.conflicts).toEqual(["/a~1b", "/c~0d"]);
    });

    it("keeps the local key order and puts keys remote added after", () => {
        const r = mergeJson({ a: 1, b: 1 }, { b: 1, a: 1, l: 1 }, { a: 1, b: 1, r: 1 });
        expect(Object.keys(r.value as object)).toEqual(["b", "a", "l", "r"]);
    });

    it("keeps the local key order also where only remote changed, at every depth", () => {
        const base = { a: 0, n: { x: 0, y: 0 } };
        const local = { n: { y: 0, x: 0 }, a: 0 };
        const remote = { a: 0, n: { x: 1, y: 0, z: 1 } };
        const r = mergeJson(base, local, remote);
        expect(r.value).toEqual({ a: 0, n: { x: 1, y: 0, z: 1 } });
        expect(Object.keys(r.value as object)).toEqual(["n", "a"]);
        expect(Object.keys((r.value as any).n)).toEqual(["y", "x", "z"]);
    });
});

describe("mergeJson without a base", () => {
    it("remote-first: remote wins differing keys, local-only keys stay, no conflict", () => {
        const r = mergeJson(undefined, { a: 0, local: 1, n: { x: 0, l: 1 } }, { a: 1, r: 1, n: { x: 1 } }, {
            noBase: "remote-first",
        });
        expect(r.value).toEqual({ a: 1, local: 1, n: { x: 1, l: 1 }, r: 1 });
        expect(r.conflicts).toEqual([]);
    });

    it("local-first: local wins differing keys and they are reported; one-sided keys stay", () => {
        const r = mergeJson(undefined, { a: 0, local: 1 }, { a: 1, r: 1 }, { noBase: "local-first" });
        expect(r.value).toEqual({ a: 0, local: 1, r: 1 });
        expect(r.conflicts).toEqual(["/a"]);
    });
});

describe("mergeJson as a set", () => {
    it("applies local additions and removals to the remote set", () => {
        const r = mergeJson(["one", "two"], ["two", "mine"], ["one", "two", "three"], { set: true });
        expect(r.value).toEqual(["two", "mine", "three"]);
        expect(r.conflicts).toEqual([]);
    });

    it("without a base, keeps the union", () => {
        const r = mergeJson(undefined, ["a", "b"], ["b", "c"], { set: true });
        expect(r.value).toEqual(["a", "b", "c"]);
    });

    it("falls back to one value when an array is not a set of strings", () => {
        const r = mergeJson(["a"], ["a", "a"], ["b"], { set: true });
        expect(r.value).toEqual(["a", "a"]);
        expect(r.conflicts).toEqual([""]);
    });
});

describe("diffJson and applyJsonChanges", () => {
    it("lists set, remove and added changes by pointer", () => {
        const changes = diffJson({ a: 1, b: { c: 1 }, gone: 1 }, { a: 2, b: { c: 1, d: 2 }, n: 3 });
        expect(changes).toEqual([
            { kind: "set", pointer: "/a", value: 2, added: false },
            { kind: "set", pointer: "/b/d", value: 2, added: true },
            { kind: "set", pointer: "/n", value: 3, added: true },
            { kind: "remove", pointer: "/gone" },
        ]);
    });

    it("applying every change to the base gives the local value", () => {
        const base = { a: 1, b: { c: 1 }, gone: 1, arr: [1] };
        const local = { a: 2, b: { c: 1, d: { e: 1 } }, n: 3, arr: [1, 2] };
        expect(applyJsonChanges(base, diffJson(base, local))).toEqual(local);
    });

    it("applying a subset sends only those keys", () => {
        const base = { a: 1, b: 1 };
        const changes = diffJson(base, { a: 2, b: 2 });
        expect(applyJsonChanges(base, changes.filter((c) => c.kind === "set" && c.pointer === "/a")))
            .toEqual({ a: 2, b: 1 });
    });

    it("diffs and applies a set by element", () => {
        const changes = diffJson(["a", "b"], ["b", "c"], { set: true });
        expect(changes).toEqual([
            { kind: "set-add", element: "c" },
            { kind: "set-remove", element: "a" },
        ]);
        expect(applyJsonChanges(["a", "b"], changes)).toEqual(["b", "c"]);
    });

    it("finds no change when only key order differs", () => {
        expect(diffJson({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([]);
    });
});

describe("orderLike", () => {
    it("orders keys like the reference, extra keys last, recursively", () => {
        const v = orderLike({ a: 1, b: { x: 1, y: 1 }, c: 1 }, { b: { y: 0, x: 0 }, a: 0 });
        expect(JSON.stringify(v)).toBe(`{"b":{"y":1,"x":1},"a":1,"c":1}`);
    });
});

describe("text", () => {
    it("parses UTF-8 JSON and rejects what is not JSON", () => {
        expect(parseJsonBytes(new TextEncoder().encode(`{"a":1}`))!.value).toEqual({ a: 1 });
        expect(parseJsonBytes(new TextEncoder().encode("not json"))).toBeNull();
        expect(parseJsonBytes(new Uint8Array([0xff, 0xfe]))).toBeNull();
    });

    it.each([
        ["two spaces, LF, final newline", `{\n  "a": 1\n}\n`],
        ["tab, no final newline", `{\n\t"a": 1\n}`],
        ["CRLF", `{\r\n    "a": 1\r\n}\r\n`],
        ["one line", `{"a":1}`],
    ])("writes back in the detected format (%s)", (_label, text) => {
        expect(serializeJson({ a: 1 }, detectJsonFormat(text))).toBe(text);
    });
});
