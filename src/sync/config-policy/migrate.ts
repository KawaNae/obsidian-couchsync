/**
 * One-time migration from the legacy `configSyncPaths: string[]` (a
 * receive-only path/prefix allowlist) to the meaning-unit `ConfigSyncPolicy`.
 *
 * Safe-side by construction: `blockPluginCode` is forced true so plugin
 * executable code stops syncing regardless of what the legacy list allowed
 * (closes the RCE channel on upgrade). The host surfaces a one-time notice
 * after migration so the change is visible.
 */

import { classifyConfigPath, type ConfigUnit, CONFIG_UNITS } from "./classify.ts";
import { defaultConfigSyncPolicy, type ConfigSyncPolicy } from "./policy.ts";

/** Map a single legacy entry (exact file or `folder/` prefix) to the
 *  meaning unit(s) it covered. */
function unitsForLegacyEntry(raw: string): ConfigUnit[] {
    const trimmed = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    if (!trimmed.startsWith(".obsidian")) return ["other"];
    const rest = trimmed === ".obsidian" ? "" : trimmed.slice(".obsidian/".length);
    if (rest === "") return [...CONFIG_UNITS]; // ".obsidian/" = everything
    const segs = rest.split("/");
    if (raw.endsWith("/")) {
        // Folder prefix — enumerate the units that can live under it.
        if (segs[0] === "plugins") return ["community-settings", "install-state"];
        if (segs[0] === "themes") return ["theme-css"];
        if (segs[0] === "snippets") return ["snippets"];
        return ["other"];
    }
    return [classifyConfigPath(trimmed).unit];
}

/**
 * Build a policy from the legacy allowlist.
 *
 *   - empty list or an `.obsidian/`-everything entry → the safe DEFAULT
 *     (portable settings ON, install-state OFF).
 *   - a selective list → honour it: all units OFF except the portable ones
 *     the legacy entries implied. install-state/layout are never enabled
 *     (safe side); `blockPluginCode` stays true.
 */
export function buildPolicyFromLegacyPaths(legacy: string[]): ConfigSyncPolicy {
    const base = defaultConfigSyncPolicy(); // blockPluginCode: true
    const everything =
        legacy.length === 0 ||
        legacy.some((p) => p === ".obsidian/" || p === ".obsidian");
    if (everything) return base;

    const unitDefaults = { ...base.unitDefaults };
    for (const u of CONFIG_UNITS) unitDefaults[u] = false;
    for (const raw of legacy) {
        for (const u of unitsForLegacyEntry(raw)) {
            if (u === "install-state" || u === "layout" || u === "other") continue;
            unitDefaults[u] = true;
        }
    }
    return { ...base, unitDefaults };
}
