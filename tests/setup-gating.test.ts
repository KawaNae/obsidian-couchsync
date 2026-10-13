import { describe, it, expect } from "vitest";
import { setupGating } from "../src/settings-tab/setup-gating.ts";
import type { ConnectionState } from "../src/settings.ts";

describe("setupGating (setup atomicity)", () => {
    const cases: Array<[ConnectionState, boolean, { locked: boolean; init: boolean; clone: boolean; sync: boolean }]> = [
        ["editing",   true,  { locked: false, init: false, clone: false, sync: false }],
        ["tested",    true,  { locked: false, init: true,  clone: true,  sync: false }],
        ["settingUp", true,  { locked: false, init: true,  clone: true,  sync: false }],
        ["setupDone", true,  { locked: false, init: true,  clone: true,  sync: true }],
        ["syncing",   true,  { locked: true,  init: false, clone: false, sync: true }],
    ];

    for (const [state, serverTested, want] of cases) {
        it(`${state} (server=${serverTested}): init=${want.init} sync=${want.sync} locked=${want.locked}`, () => {
            const g = setupGating(state, serverTested);
            expect(g.locked).toBe(want.locked);
            expect(g.initEnabled).toBe(want.init);
            expect(g.cloneEnabled).toBe(want.clone);
            expect(g.syncToggleEnabled).toBe(want.sync);
        });
    }

    it("settingUp NEVER enables Live Sync (no live sync over a half-built DB)", () => {
        expect(setupGating("settingUp", true).syncToggleEnabled).toBe(false);
        expect(setupGating("settingUp", true).initEnabled).toBe(true);
    });

    it("serverTested=false blocks Init/Clone even in tested state", () => {
        const g = setupGating("tested", false);
        expect(g.initEnabled).toBe(false);
        expect(g.cloneEnabled).toBe(false);
        expect(g.syncToggleEnabled).toBe(false);
    });

    it("serverTested=false blocks Init/Clone in setupDone state", () => {
        const g = setupGating("setupDone", false);
        expect(g.initEnabled).toBe(false);
        expect(g.cloneEnabled).toBe(false);
        expect(g.syncToggleEnabled).toBe(true);
    });
});
