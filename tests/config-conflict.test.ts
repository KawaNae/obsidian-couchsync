/**
 * Tests that ConflictResolver handles ConfigDoc conflicts the same way
 * it handles FileDoc conflicts. Same VC discipline, same callback shape,
 * but the path passed to callbacks is the `.obsidian/...` path extracted
 * from the `config:` prefix.
 *
 * Phase 2: tests use resolveOnPull() instead of PouchDB conflict trees.
 */

import { describe, it, expect, vi } from "vitest";
import { ConflictResolver } from "../src/conflict/conflict-resolver.ts";
import type { ConfigDoc } from "../src/types.ts";
import { makeConfigId } from "../src/types/doc-id.ts";

function makeConfig(
    path: string,
    vclock: Record<string, number>,
    data = "YmFzZQ==",
): ConfigDoc {
    return {
        _id: makeConfigId(path),
        type: "config",
        data,
        mtime: 1000,
        size: 4,
        vclock,
    };
}

describe("ConflictResolver — ConfigDoc support (Phase 2)", () => {
    it("returns take-remote when remote VC dominates local", async () => {
        const resolver = new ConflictResolver();
        const local = makeConfig(".obsidian/appearance.json", { A: 1, B: 1 });
        const remote = makeConfig(".obsidian/appearance.json", { A: 2, B: 1 });

        const verdict = await resolver.resolveOnPull(local, remote);
        expect(verdict).toBe("take-remote");
    });

    it("fires onAutoResolved with .obsidian path for ConfigDoc", async () => {
        const onAuto = vi.fn();
        const resolver = new ConflictResolver(onAuto);
        const local = makeConfig(".obsidian/appearance.json", { A: 1, B: 1 });
        const remote = makeConfig(".obsidian/appearance.json", { A: 2, B: 1 });

        await resolver.resolveOnPull(local, remote);

        expect(onAuto).toHaveBeenCalledTimes(1);
        expect(onAuto.mock.calls[0][0]).toBe(".obsidian/appearance.json");
    });

    it("returns concurrent for ConfigDoc when VCs are incomparable", async () => {
        const onConcurrent = vi.fn();
        const resolver = new ConflictResolver();
        resolver.setOnConcurrent(onConcurrent);

        const local = makeConfig(".obsidian/hotkeys.json", { mobile: 1, desktop: 0 });
        const remote = makeConfig(".obsidian/hotkeys.json", { mobile: 0, desktop: 1 });

        const verdict = await resolver.resolveOnPull(local, remote);
        expect(verdict).toBe("concurrent");

        expect(onConcurrent).toHaveBeenCalledTimes(1);
        expect(onConcurrent.mock.calls[0][0]).toBe(".obsidian/hotkeys.json");
        expect(onConcurrent.mock.calls[0][1].length).toBe(2);
    });

    it("does not consult mtime when VCs decide the winner", async () => {
        const resolver = new ConflictResolver();
        // local has higher VC but older mtime
        const local = makeConfig(
            ".obsidian/community-plugins.json",
            { A: 5 },
            "d2lubmVy", // "winner"
        );
        local.mtime = 1; // old

        const remote = makeConfig(
            ".obsidian/community-plugins.json",
            { A: 3 },
            "bG9zZXI=", // "loser"
        );
        remote.mtime = 999999; // new

        const verdict = await resolver.resolveOnPull(local, remote);
        // Local dominates remote → keep-local
        expect(verdict).toBe("keep-local");
    });

    it("returns take-remote when no local ConfigDoc exists", async () => {
        const resolver = new ConflictResolver();
        const remote = makeConfig(".obsidian/app.json", { A: 1 });

        const verdict = await resolver.resolveOnPull(null, remote);
        expect(verdict).toBe("take-remote");
    });
});
