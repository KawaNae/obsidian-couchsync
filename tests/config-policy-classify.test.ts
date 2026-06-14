import { describe, it, expect } from "vitest";
import {
    classifyConfigPath,
    type ConfigUnit,
} from "../src/sync/config-policy/classify.ts";

describe("classifyConfigPath", () => {
    const cases: Array<[string, ConfigUnit, boolean]> = [
        // [path, unit, isPluginCode]
        // app / appearance / hotkeys are merged into one "app-behavior" unit.
        [".obsidian/app.json", "app-behavior", false],
        [".obsidian/appearance.json", "app-behavior", false],
        [".obsidian/hotkeys.json", "app-behavior", false],
        [".obsidian/graph.json", "core-settings", false],
        [".obsidian/daily-notes.json", "core-settings", false],
        [".obsidian/types.json", "core-settings", false],
        [".obsidian/page-preview.json", "core-settings", false],
        [".obsidian/community-plugins.json", "enabled-list", false],
        [".obsidian/core-plugins.json", "enabled-list", false],
        [".obsidian/core-plugins-migration.json", "enabled-list", false],
        [".obsidian/workspace.json", "layout", false],
        [".obsidian/workspace-mobile.json", "layout", false],
        // plugin: data.json = portable settings; everything else = install-state
        [".obsidian/plugins/dataview/data.json", "community-settings", false],
        [".obsidian/plugins/dataview/main.js", "install-state", true],
        [".obsidian/plugins/dataview/manifest.json", "install-state", false],
        [".obsidian/plugins/dataview/styles.css", "install-state", false],
        [".obsidian/plugins/some-plugin/lib/extra.mjs", "install-state", true],
        // themes / snippets
        [".obsidian/themes/Minimal/theme.css", "theme-css", false],
        [".obsidian/themes/Minimal/manifest.json", "theme-css", false],
        [".obsidian/snippets/custom.css", "snippets", false],
        // unknowns
        [".obsidian/somethingweird", "other", false],
        ["notes/hello.md", "other", false],
    ];

    for (const [path, unit, isPluginCode] of cases) {
        it(`${path} → ${unit}${isPluginCode ? " (code)" : ""}`, () => {
            const c = classifyConfigPath(path);
            expect(c.unit).toBe(unit);
            expect(c.isPluginCode).toBe(isPluginCode);
        });
    }

    it("attaches pluginDir for community-settings and install-state", () => {
        expect(classifyConfigPath(".obsidian/plugins/dataview/data.json").pluginDir)
            .toBe(".obsidian/plugins/dataview");
        expect(classifyConfigPath(".obsidian/plugins/dataview/main.js").pluginDir)
            .toBe(".obsidian/plugins/dataview");
    });

    it("does not attach pluginDir for non-plugin units", () => {
        expect(classifyConfigPath(".obsidian/app.json").pluginDir).toBeUndefined();
        expect(classifyConfigPath(".obsidian/themes/Minimal/theme.css").pluginDir).toBeUndefined();
    });

    it("preserves the original-case path verbatim", () => {
        const p = ".obsidian/plugins/MyPlugin/Data.json"; // not exactly data.json
        const c = classifyConfigPath(p);
        expect(c.path).toBe(p);
        // Data.json (capital D) is not the portable data.json → install-state
        expect(c.unit).toBe("install-state");
    });
});
