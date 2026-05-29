import { describe, it, expect } from "vitest";
import { setupGating } from "../src/settings-tab/setup-gating.ts";
import type { ConnectionState } from "../src/settings.ts";

describe("setupGating (Invariant C / Bug 1)", () => {
    const cases: Array<[ConnectionState, { locked: boolean; init: boolean; sync: boolean }]> = [
        ["editing", { locked: false, init: false, sync: false }],
        ["tested", { locked: false, init: true, sync: false }],
        ["settingUp", { locked: false, init: true, sync: false }],
        ["setupDone", { locked: false, init: true, sync: true }],
        ["syncing", { locked: true, init: false, sync: true }],
    ];

    for (const [state, want] of cases) {
        it(`${state}: init=${want.init} sync=${want.sync} locked=${want.locked}`, () => {
            const g = setupGating(state);
            expect(g.locked).toBe(want.locked);
            expect(g.initCloneEnabled).toBe(want.init);
            expect(g.syncToggleEnabled).toBe(want.sync);
        });
    }

    it("settingUp NEVER enables Live Sync (the Bug 1 invariant)", () => {
        // A failed/mid-flight setup must not let the user sync a half-built
        // DB, but must allow re-running Init/Clone.
        expect(setupGating("settingUp").syncToggleEnabled).toBe(false);
        expect(setupGating("settingUp").initCloneEnabled).toBe(true);
    });
});
