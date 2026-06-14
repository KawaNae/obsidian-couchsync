/**
 * Pure classification of a `.obsidian/` config path into a *meaning unit*.
 *
 * This is the single source of truth that the SEND projection
 * (`sendDecision`), the RECEIVE projection (`receiveDecision`), and the
 * settings-tab tree UI all consult. Because all three derive their
 * behaviour from this one function, they cannot drift apart: what the user
 * sees in the tree is exactly what is sent and received.
 *
 * No I/O, no side effects — just string shape analysis. Keep it that way.
 *
 * ## Meaning units
 *
 * The `.obsidian/` directory mixes two fundamentally different kinds of
 * file, and conflating them is what produced the historical bugs:
 *
 *   - **Portable settings** — device-independent, want them identical
 *     everywhere: app settings (app.json + appearance.json + hotkeys.json),
 *     core-plugin settings, a plugin's `data.json`, theme/snippet CSS.
 *   - **Installation state** — device / version / platform bound, differ
 *     legitimately per device: plugin `main.js` + `manifest.json` +
 *     `styles.css`, and the enabled-plugin lists. Syncing these across
 *     heterogeneous devices causes ghost plugins, version mismatch, and
 *     is the RCE surface (a malicious server distributing `main.js`).
 *
 * `layout` (workspace*) is device-local and never synced.
 */

export type ConfigUnit =
    // The three top-level user-preference files move together (all portable,
    // all default-on, all device-agnostic), so they are ONE unit. A device
    // that genuinely wants e.g. a per-device theme can still exclude
    // appearance.json alone via a per-path override.
    | "app-behavior" //        .obsidian/{app,appearance,hotkeys}.json
    | "core-settings" //       .obsidian/<other>.json (graph, daily-notes, types…)
    | "enabled-list" //        community-plugins.json, core-plugins(-migration).json
    | "community-settings" //  plugins/<id>/data.json
    | "install-state" //       plugins/<id>/{main.js,manifest.json,styles.css,…}
    | "theme-css" //           themes/<name>/{theme.css,manifest.json}
    | "snippets" //            snippets/*.css
    | "layout" //              workspace*.json (always excluded)
    | "other"; //              anything else (conservative: default skip)

/** Stable ordering used by defaults and the UI tree: portable settings first
 *  (app → themes → snippets → core → community), then installation state
 *  (plugin code → enabled lists), then the always-excluded layout / other. */
export const CONFIG_UNITS: readonly ConfigUnit[] = [
    "app-behavior",
    "theme-css",
    "snippets",
    "core-settings",
    "community-settings",
    "install-state",
    "enabled-list",
    "layout",
    "other",
] as const;

export interface ClassifiedPath {
    /** The original vault-relative path, verbatim (FS-safe, not folded). */
    path: string;
    unit: ConfigUnit;
    /** Executable JavaScript inside `install-state` — flagged so the UI can
     *  mark it ⚠️. The JS safety interlock hard-locks the whole
     *  `install-state` unit, so this is for display, not the lock itself. */
    isPluginCode: boolean;
    /** `.obsidian/plugins/<id>` for `community-settings` / `install-state`.
     *  Keys the receive-side presence + desktop-only gates. */
    pluginDir?: string;
}

const ROOT = ".obsidian/";

const ENABLED_LIST_FILES = new Set([
    "community-plugins.json",
    "core-plugins.json",
    "core-plugins-migration.json",
]);

const LAYOUT_FILES = new Set(["workspace.json", "workspace-mobile.json"]);

const CODE_EXT = /\.(js|mjs|cjs)$/i;

/** Classify a vault-relative `.obsidian/` path into its meaning unit. */
export function classifyConfigPath(path: string): ClassifiedPath {
    if (!path.startsWith(ROOT)) {
        return { path, unit: "other", isPluginCode: false };
    }
    const rest = path.slice(ROOT.length);
    const segs = rest.split("/");

    // ── plugins/<id>/… ──────────────────────────────────
    if (segs[0] === "plugins" && segs.length >= 3) {
        const pluginDir = `${ROOT}plugins/${segs[1]}`;
        // A plugin's data.json (exactly plugins/<id>/data.json) is its
        // portable settings; everything else under the plugin folder is
        // installation state (code/metadata/assets).
        if (segs.length === 3 && segs[2] === "data.json") {
            return { path, unit: "community-settings", isPluginCode: false, pluginDir };
        }
        return {
            path,
            unit: "install-state",
            isPluginCode: CODE_EXT.test(rest),
            pluginDir,
        };
    }

    // ── themes/<name>/… ─────────────────────────────────
    if (segs[0] === "themes" && segs.length >= 3) {
        return { path, unit: "theme-css", isPluginCode: false };
    }

    // ── snippets/*.css ──────────────────────────────────
    if (segs[0] === "snippets" && segs.length >= 2) {
        return { path, unit: "snippets", isPluginCode: false };
    }

    // ── direct children of .obsidian/ ───────────────────
    if (segs.length === 1) {
        const name = segs[0];
        if (LAYOUT_FILES.has(name)) return mk(path, "layout");
        // app.json / appearance.json / hotkeys.json — one "app settings" unit.
        if (name === "app.json" || name === "appearance.json" || name === "hotkeys.json") {
            return mk(path, "app-behavior");
        }
        if (ENABLED_LIST_FILES.has(name)) return mk(path, "enabled-list");
        if (name.endsWith(".json")) return mk(path, "core-settings");
        return mk(path, "other");
    }

    return mk(path, "other");
}

function mk(path: string, unit: ConfigUnit): ClassifiedPath {
    return { path, unit, isPluginCode: false };
}
