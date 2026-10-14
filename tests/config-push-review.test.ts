import { describe, it, expect } from "vitest";
import {
    applyPushSelection,
    buildPushReview,
    defaultSelection,
    hasUndeclaredChange,
} from "../src/sync/config-push-review.ts";
import { diffForPush, type PushPlanEntry } from "../src/sync/config-reconcile.ts";
import { defaultConfigSyncPolicy, type ConfigSyncPolicy } from "../src/sync/config-policy/policy.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const APP = ".obsidian/app.json";
const PLUGINS = ".obsidian/community-plugins.json";
const DATA = ".obsidian/plugins/p/data.json";
const CSS = ".obsidian/snippets/a.css";

function entry(path: string, base: string | null, local: string): PushPlanEntry {
    const l = enc(local);
    return {
        path,
        diff: diffForPush(path, base === null ? null : enc(base), l)!,
        local: l,
        chunks: [],
        size: l.byteLength,
        mtime: 0,
        base: base === null ? null : { vclock: { d: 1 }, size: base.length, chunks: [] },
    };
}

function policy(deviceOnlyKeys: Record<string, string[]> = {}): ConfigSyncPolicy {
    return { ...defaultConfigSyncPolicy(), deviceOnlyKeys };
}

describe("buildPushReview", () => {
    it("lists each key with the shared value and this device's value", () => {
        const r = buildPushReview([entry(APP, `{"a":1,"gone":1}`, `{"a":2,"b":true}`)], policy(), 0);
        expect(r.items.map((i) => [i.pointer, i.change, i.sharedText, i.localText])).toEqual([
            ["/a", "changed", "1", "2"],
            ["/b", "added", undefined, "true"],
            ["/gone", "removed", "1", undefined],
        ]);
        expect(r.items.every((i) => !i.deviceOnly && !i.hideValues)).toBe(true);
    });

    it("lists plugins enabled and disabled in community-plugins.json without values", () => {
        const r = buildPushReview([entry(PLUGINS, `["a","b"]`, `["b","c"]`)], policy(), 0);
        expect(r.items.map((i) => [i.pointer, i.change, i.localText])).toEqual([
            ["/c", "enabled", undefined],
            ["/a", "disabled", undefined],
        ]);
    });

    it("lists a whole file once, and hides the values of a plugin's data.json", () => {
        const r = buildPushReview([
            entry(CSS, "a", "b"),
            entry(DATA, `{"token":"t0"}`, `{"token":"t1"}`),
        ], policy(), 2);
        expect(r.items.map((i) => [i.path, i.pointer, i.change, i.hideValues])).toEqual([
            [DATA, "/token", "changed", true],
            [CSS, null, "file", false],
        ]);
        expect(r.held).toBe(2);
    });

    it("declared keys start left out", () => {
        const r = buildPushReview([entry(APP, `{"a":1,"b":1}`, `{"a":2,"b":2}`)], policy({ [APP]: ["/b"] }), 0);
        expect(r.items.map((i) => [i.pointer, i.deviceOnly])).toEqual([["/a", false], ["/b", true]]);
        expect(defaultSelection(r)).toEqual([`${APP}#/a`]);
    });
});

describe("hasUndeclaredChange", () => {
    it("is false only for a JSON file whose every change is declared", () => {
        const e = entry(APP, `{"a":1}`, `{"a":2}`);
        expect(hasUndeclaredChange(e, policy())).toBe(true);
        expect(hasUndeclaredChange(e, policy({ [APP]: ["/a"] }))).toBe(false);
        expect(hasUndeclaredChange(entry(CSS, "a", "b"), policy({ [CSS]: [""] }))).toBe(true);
    });
});

describe("applyPushSelection", () => {
    it("sends the selected keys and declares the others", () => {
        const e = entry(APP, `{"a":1,"b":1}`, `{"a":2,"b":2}`);
        const out = applyPushSelection([e], policy(), new Set([`${APP}#/a`]));
        expect(out.sends).toHaveLength(1);
        expect(out.sends[0].selected).toEqual([{ kind: "set", pointer: "/a", value: 2, added: false }]);
        expect(out.sends[0].deviceOnly).toEqual(["/b"]);
        expect(out.policy.deviceOnlyKeys).toEqual({ [APP]: ["/b"] });
        expect(out.declared).toEqual([{ path: APP, pointer: "/b" }]);
    });

    it("selecting a declared key releases its declaration", () => {
        const e = entry(APP, `{"a":1}`, `{"a":2}`);
        const out = applyPushSelection([e], policy({ [APP]: ["/a"], other: ["/x"] }), new Set([`${APP}#/a`]));
        expect(out.policy.deviceOnlyKeys).toEqual({ other: ["/x"] });
        expect(out.released).toEqual([{ path: APP, pointer: "/a" }]);
    });

    it("a file with nothing selected is not sent", () => {
        const e = entry(APP, `{"a":1}`, `{"a":2}`);
        const out = applyPushSelection([e], policy(), new Set());
        expect(out.sends).toEqual([]);
        expect(out.policy.deviceOnlyKeys).toEqual({ [APP]: ["/a"] });
    });

    it("a whole file left out stops taking part through overrides", () => {
        const out = applyPushSelection([entry(CSS, "a", "b")], policy(), new Set());
        expect(out.sends).toEqual([]);
        expect(out.policy.overrides).toEqual({ [CSS]: false });
        expect(out.filesLeftOut).toEqual([CSS]);
    });

    it("a plugin left out of community-plugins.json is declared by its id", () => {
        const e = entry(PLUGINS, `["a"]`, `["a","b","c"]`);
        const out = applyPushSelection([e], policy(), new Set([`${PLUGINS}#/c`]));
        expect(out.policy.deviceOnlyKeys).toEqual({ [PLUGINS]: ["/b"] });
        expect(out.sends[0].selected).toEqual([{ kind: "set-add", element: "c" }]);
    });

    it("changes nothing in the policy when everything is selected", () => {
        const p = policy();
        const e = entry(APP, `{"a":1}`, `{"a":2}`);
        const out = applyPushSelection([e], p, new Set([`${APP}#/a`]));
        expect(out.policy.deviceOnlyKeys).toEqual({});
        expect(out.declared.length + out.released.length + out.filesLeftOut.length).toBe(0);
    });
});
