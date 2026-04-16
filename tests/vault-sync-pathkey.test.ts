import { describe, it, expect, beforeEach } from "vitest";
import type { VectorClock } from "../src/sync/vector-clock.ts";
import type { PathKey } from "../src/utils/path.ts";
import { toPathKey } from "../src/utils/path.ts";

/**
 * VaultSync の lastSyncedVclock は private なので、同じ PathKey
 * ロジックを Map<PathKey, VectorClock> で再現して動作を検証する。
 * VaultSync 本体のメソッドを直接テストすると Obsidian App の
 * モック量が膨大になるため、PathKey キーイングの正しさに
 * フォーカスした軽量テスト。
 */
describe("PathKey-keyed Map (lastSyncedVclock pattern)", () => {
    let map: Map<PathKey, VectorClock>;

    beforeEach(() => {
        map = new Map();
    });

    it("case-insensitive set/get — vault case で書き込み、DB case で取得", () => {
        const vc: VectorClock = { "device-a": 3 };
        map.set(toPathKey("README.md"), vc);
        expect(map.get(toPathKey("readme.md"))).toBe(vc);
    });

    it("case-insensitive delete — vault case で書き込み、DB case で削除", () => {
        map.set(toPathKey("Notes/TODO.md"), { "device-a": 1 });
        map.delete(toPathKey("notes/todo.md"));
        expect(map.size).toBe(0);
    });

    it("Unicode NFC normalization — precomposed と decomposed が同一キー", () => {
        const vc: VectorClock = { "device-a": 1 };
        map.set(toPathKey("caf\u00e9.md"), vc);
        expect(map.get(toPathKey("cafe\u0301.md"))).toBe(vc);
    });

    it("同一 PathKey への上書き — 後勝ち", () => {
        map.set(toPathKey("File.md"), { "device-a": 1 });
        map.set(toPathKey("file.md"), { "device-a": 2 });
        expect(map.size).toBe(1);
        expect(map.get(toPathKey("FILE.md"))?.["device-a"]).toBe(2);
    });
});

describe("PathKey-keyed Set (skippedPaths pattern)", () => {
    it("case-insensitive has", () => {
        const set = new Set<PathKey>();
        set.add(toPathKey("BigFile.zip"));
        expect(set.has(toPathKey("bigfile.zip"))).toBe(true);
        expect(set.has(toPathKey("BIGFILE.ZIP"))).toBe(true);
    });

    it("case-insensitive delete", () => {
        const set = new Set<PathKey>();
        set.add(toPathKey("Archive/Large.tar"));
        set.delete(toPathKey("archive/large.tar"));
        expect(set.size).toBe(0);
    });
});
