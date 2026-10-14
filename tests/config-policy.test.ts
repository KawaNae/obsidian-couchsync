import { describe, it, expect } from "vitest";
import { classifyConfigPath } from "../src/sync/config-policy/classify.ts";
import {
    policySelects,
    participates,
    defaultConfigSyncPolicy,
    type ConfigSyncPolicy,
    type DeviceContext,
} from "../src/sync/config-policy/policy.ts";

const c = classifyConfigPath;

function policy(over: Partial<ConfigSyncPolicy> = {}): ConfigSyncPolicy {
    return { ...defaultConfigSyncPolicy(), ...over };
}

const desktopCtx: DeviceContext = {
    isMobile: false,
    pluginPresent: () => true,
    isDesktopOnly: () => false,
};

describe("policySelects", () => {
    it("default policy: portable settings ON, install-state/layout OFF", () => {
        const p = policy();
        expect(policySelects(p, c(".obsidian/app.json"))).toBe(true);
        expect(policySelects(p, c(".obsidian/plugins/x/data.json"))).toBe(true);
        expect(policySelects(p, c(".obsidian/themes/M/theme.css"))).toBe(true);
        expect(policySelects(p, c(".obsidian/snippets/a.css"))).toBe(true);
        expect(policySelects(p, c(".obsidian/plugins/x/main.js"))).toBe(false);
        expect(policySelects(p, c(".obsidian/community-plugins.json"))).toBe(false);
        expect(policySelects(p, c(".obsidian/workspace.json"))).toBe(false);
    });

    it("JS safety interlock hard-locks install-state even against an override", () => {
        const p = policy({
            blockPluginCode: true,
            overrides: { ".obsidian/plugins/x/main.js": true },
        });
        expect(policySelects(p, c(".obsidian/plugins/x/main.js"))).toBe(false);
    });

    it("with safety OFF, an explicit override can enable a single main.js", () => {
        const p = policy({
            blockPluginCode: false,
            overrides: { ".obsidian/plugins/x/main.js": true },
        });
        expect(policySelects(p, c(".obsidian/plugins/x/main.js"))).toBe(true);
        // other install-state still follows its unit default (off)
        expect(policySelects(p, c(".obsidian/plugins/y/main.js"))).toBe(false);
    });

    it("layout is never sent regardless of override", () => {
        const p = policy({ overrides: { ".obsidian/workspace.json": true } });
        expect(policySelects(p, c(".obsidian/workspace.json"))).toBe(false);
    });

    it("per-path override flips a unit default", () => {
        const p = policy({ overrides: { ".obsidian/app.json": false } });
        expect(policySelects(p, c(".obsidian/app.json"))).toBe(false);
    });
});

describe("participates (narrows the selection)", () => {
    it("anything the selection leaves out does not participate", () => {
        const p = policy();
        for (const path of [
            ".obsidian/plugins/x/main.js",
            ".obsidian/workspace.json",
            ".obsidian/community-plugins.json",
        ]) {
            expect(participates(p, c(path), desktopCtx)).toBe(false);
        }
    });

    it("presence gate: community-settings rejected when plugin absent locally", () => {
        const p = policy();
        const path = ".obsidian/plugins/x/data.json";
        const present: DeviceContext = { ...desktopCtx, pluginPresent: () => true };
        const absent: DeviceContext = { ...desktopCtx, pluginPresent: () => false };
        expect(policySelects(p, c(path))).toBe(true);
        expect(participates(p, c(path), present)).toBe(true);
        expect(participates(p, c(path), absent)).toBe(false);
    });

    it("platform gate: desktop-only plugin data not materialised on mobile", () => {
        const p = policy();
        const path = ".obsidian/plugins/x/data.json";
        const mobileDesktopOnly: DeviceContext = {
            isMobile: true,
            pluginPresent: () => true,
            isDesktopOnly: () => true,
        };
        const mobileNormal: DeviceContext = {
            isMobile: true,
            pluginPresent: () => true,
            isDesktopOnly: () => false,
        };
        expect(participates(p, c(path), mobileDesktopOnly)).toBe(false);
        expect(participates(p, c(path), mobileNormal)).toBe(true);
        // on desktop, desktop-only is irrelevant
        expect(participates(p, c(path), { ...mobileDesktopOnly, isMobile: false })).toBe(true);
    });

    it("property: participation never grants what the selection denies", () => {
        const p = policy({ blockPluginCode: false });
        const paths = [
            ".obsidian/app.json",
            ".obsidian/plugins/x/data.json",
            ".obsidian/plugins/x/main.js",
            ".obsidian/themes/M/theme.css",
            ".obsidian/workspace.json",
            ".obsidian/community-plugins.json",
        ];
        const ctxs: DeviceContext[] = [
            desktopCtx,
            { isMobile: true, pluginPresent: () => false, isDesktopOnly: () => undefined },
            { isMobile: true, pluginPresent: () => true, isDesktopOnly: () => true },
        ];
        for (const path of paths) {
            for (const ctx of ctxs) {
                if (participates(p, c(path), ctx)) {
                    expect(policySelects(p, c(path))).toBe(true);
                }
            }
        }
    });
});
