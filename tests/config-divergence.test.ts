import { describe, it, expect } from "vitest";
import {
    detectDivergence,
    dangerousForPush,
    dangerousForPull,
} from "../src/sync/config-divergence.ts";
import type { ConfigDoc } from "../src/types.ts";
import { makeConfigId } from "../src/types/doc-id.ts";

const A = "device-a";
const B = "device-b";

function doc(path: string, vclock: Record<string, number>): ConfigDoc {
    return {
        _id: makeConfigId(path),
        type: "config",
        data: "",
        mtime: 0,
        size: 0,
        vclock,
    };
}

describe("detectDivergence", () => {
    it("returns nothing when both sides are vclock-equal", () => {
        const local = [doc(".obsidian/app.json", { [A]: 1 })];
        const remote = [doc(".obsidian/app.json", { [A]: 1 })];
        expect(detectDivergence(local, remote)).toEqual([]);
    });

    it("flags 'concurrent' when each side advanced its own counter", () => {
        const local = [doc(".obsidian/app.json", { [A]: 2, [B]: 1 })];
        const remote = [doc(".obsidian/app.json", { [A]: 1, [B]: 2 })];
        const result = detectDivergence(local, remote);
        expect(result).toHaveLength(1);
        expect(result[0].relation).toBe("concurrent");
        expect(result[0].path).toBe(".obsidian/app.json");
    });

    it("flags 'dominates' when local extends remote", () => {
        const local = [doc(".obsidian/app.json", { [A]: 3 })];
        const remote = [doc(".obsidian/app.json", { [A]: 1 })];
        expect(detectDivergence(local, remote)[0].relation).toBe("dominates");
    });

    it("flags 'dominated' when remote extends local", () => {
        const local = [doc(".obsidian/app.json", { [A]: 1 })];
        const remote = [doc(".obsidian/app.json", { [A]: 3 })];
        expect(detectDivergence(local, remote)[0].relation).toBe("dominated");
    });

    it("ignores docs that exist only on one side (clean adds/deletes)", () => {
        const local = [doc(".obsidian/app.json", { [A]: 1 })];
        const remote: ConfigDoc[] = [];
        expect(detectDivergence(local, remote)).toEqual([]);
    });
});

describe("dangerousForPush", () => {
    it("flags 'concurrent' and 'dominated' (not 'dominates')", () => {
        const divs = [
            { id: "x", path: "x", relation: "concurrent" as const },
            { id: "y", path: "y", relation: "dominated" as const },
            { id: "z", path: "z", relation: "dominates" as const },
        ];
        expect(dangerousForPush(divs).map((d) => d.path)).toEqual(["x", "y"]);
    });
});

describe("dangerousForPull", () => {
    it("flags 'concurrent' and 'dominates' (not 'dominated')", () => {
        const divs = [
            { id: "x", path: "x", relation: "concurrent" as const },
            { id: "y", path: "y", relation: "dominated" as const },
            { id: "z", path: "z", relation: "dominates" as const },
        ];
        expect(dangerousForPull(divs).map((d) => d.path)).toEqual(["x", "z"]);
    });
});
