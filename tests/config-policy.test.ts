import { describe, it, expect } from "vitest";
import { classifyConfigPath } from "../src/sync/config-policy/classify.ts";
import {
    sendDecision,
    receiveDecision,
    defaultConfigSyncPolicy,
    type ConfigSyncPolicy,
    type ReceiveContext,
} from "../src/sync/config-policy/policy.ts";

const c = classifyConfigPath;

function policy(over: Partial<ConfigSyncPolicy> = {}): ConfigSyncPolicy {
    return { ...defaultConfigSyncPolicy(), ...over };
}

const desktopCtx: ReceiveContext = {
    isMobile: false,
    pluginPresent: () => true,
    isDesktopOnly: () => false,
};

describe("sendDecision", () => {
    it("default policy: portable settings ON, install-state/layout OFF", () => {
        const p = policy();
        expect(sendDecision(p, c(".obsidian/app.json"))).toBe(true);
        expect(sendDecision(p, c(".obsidian/plugins/x/data.json"))).toBe(true);
        expect(sendDecision(p, c(".obsidian/themes/M/theme.css"))).toBe(true);
        expect(sendDecision(p, c(".obsidian/snippets/a.css"))).toBe(true);
        expect(sendDecision(p, c(".obsidian/plugins/x/main.js"))).toBe(false);
        expect(sendDecision(p, c(".obsidian/community-plugins.json"))).toBe(false);
        expect(sendDecision(p, c(".obsidian/workspace.json"))).toBe(false);
    });

    it("JS safety interlock hard-locks install-state even against an override", () => {
        const p = policy({
            blockPluginCode: true,
            overrides: { ".obsidian/plugins/x/main.js": true },
        });
        expect(sendDecision(p, c(".obsidian/plugins/x/main.js"))).toBe(false);
    });

    it("with safety OFF, an explicit override can enable a single main.js", () => {
        const p = policy({
            blockPluginCode: false,
            overrides: { ".obsidian/plugins/x/main.js": true },
        });
        expect(sendDecision(p, c(".obsidian/plugins/x/main.js"))).toBe(true);
        // other install-state still follows its unit default (off)
        expect(sendDecision(p, c(".obsidian/plugins/y/main.js"))).toBe(false);
    });

    it("layout is never sent regardless of override", () => {
        const p = policy({ overrides: { ".obsidian/workspace.json": true } });
        expect(sendDecision(p, c(".obsidian/workspace.json"))).toBe(false);
    });

    it("per-path override flips a unit default", () => {
        const p = policy({ overrides: { ".obsidian/app.json": false } });
        expect(sendDecision(p, c(".obsidian/app.json"))).toBe(false);
    });
});

describe("receiveDecision (receive ⊆ send)", () => {
    it("anything send rejects, receive also rejects", () => {
        const p = policy();
        for (const path of [
            ".obsidian/plugins/x/main.js",
            ".obsidian/workspace.json",
            ".obsidian/community-plugins.json",
        ]) {
            expect(receiveDecision(p, c(path), desktopCtx)).toBe(false);
        }
    });

    it("presence gate: community-settings rejected when plugin absent locally", () => {
        const p = policy();
        const path = ".obsidian/plugins/x/data.json";
        const present: ReceiveContext = { ...desktopCtx, pluginPresent: () => true };
        const absent: ReceiveContext = { ...desktopCtx, pluginPresent: () => false };
        expect(sendDecision(p, c(path))).toBe(true);
        expect(receiveDecision(p, c(path), present)).toBe(true);
        expect(receiveDecision(p, c(path), absent)).toBe(false);
    });

    it("platform gate: desktop-only plugin data not materialised on mobile", () => {
        const p = policy();
        const path = ".obsidian/plugins/x/data.json";
        const mobileDesktopOnly: ReceiveContext = {
            isMobile: true,
            pluginPresent: () => true,
            isDesktopOnly: () => true,
        };
        const mobileNormal: ReceiveContext = {
            isMobile: true,
            pluginPresent: () => true,
            isDesktopOnly: () => false,
        };
        expect(receiveDecision(p, c(path), mobileDesktopOnly)).toBe(false);
        expect(receiveDecision(p, c(path), mobileNormal)).toBe(true);
        // on desktop, desktop-only is irrelevant
        expect(receiveDecision(p, c(path), { ...mobileDesktopOnly, isMobile: false })).toBe(true);
    });

    it("property: receive never grants what send denies", () => {
        const p = policy({ blockPluginCode: false });
        const paths = [
            ".obsidian/app.json",
            ".obsidian/plugins/x/data.json",
            ".obsidian/plugins/x/main.js",
            ".obsidian/themes/M/theme.css",
            ".obsidian/workspace.json",
            ".obsidian/community-plugins.json",
        ];
        const ctxs: ReceiveContext[] = [
            desktopCtx,
            { isMobile: true, pluginPresent: () => false, isDesktopOnly: () => undefined },
            { isMobile: true, pluginPresent: () => true, isDesktopOnly: () => true },
        ];
        for (const path of paths) {
            for (const ctx of ctxs) {
                if (receiveDecision(p, c(path), ctx)) {
                    expect(sendDecision(p, c(path))).toBe(true);
                }
            }
        }
    });
});
