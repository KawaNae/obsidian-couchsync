/**
 * Config sync policy — ONE user-facing selection, enforced at TWO points.
 *
 * First principles (see plan / [[feedback_threat_model_triage]]):
 *
 *   - The policy is a single function `unit → bool` over meaning units,
 *     plus per-path overrides and the JS safety interlock. It is the same
 *     truth applied to both directions.
 *   - **Send projection** = policy alone. Exposure / bandwidth / not
 *     leaking code is decidable by the sending device with no knowledge of
 *     any receiver.
 *   - **Receive projection** = policy AND receiver-only gates (this
 *     device's platform; whether the plugin is installed here). These
 *     depend on information the sender cannot have, so the asymmetry is a
 *     structural necessity of *where the information lives*, not an
 *     implementation accident.
 *
 * This is expressed in code by `receiveDecision` calling `sendDecision`
 * first and only ever narrowing it (receive ⊆ send). That invariant is the
 * regression guard for the whole design.
 */

import type { ClassifiedPath, ConfigUnit } from "./classify.ts";
import { CONFIG_UNITS } from "./classify.ts";

/** Persisted, serialisable policy. Lives in settings (device-local — a
 *  device controls its own exposure/acceptance and does NOT sync this). */
export interface ConfigSyncPolicy {
    schemaVersion: 1;
    /** Per-unit default decision. The mechanism by which *future* files
     *  (a newly installed plugin, a new theme) inherit a decision without
     *  any path enumeration. */
    unitDefaults: Record<ConfigUnit, boolean>;
    /** Per-path exceptions to the unit default. Only paths that differ from
     *  their unit default are stored (the UI prunes matching keys). */
    overrides: Record<string, boolean>;
    /** JS safety interlock (default true): hard-locks the entire
     *  `install-state` unit OFF in both directions, overriding everything
     *  else, and auto-covers future plugins. Blocks the malicious-server
     *  RCE channel and the manifest-`main`-repoint bypass (manifest is part
     *  of install-state, so it is never synced while this is on). */
    blockPluginCode: boolean;
}

/** Receiver-only context for the receive projection. Built once per write
 *  (not per doc) by the host — see `ConfigSync.buildReceiveContext`. */
export interface ReceiveContext {
    isMobile: boolean;
    /** Is the plugin folder present on THIS device's filesystem? */
    pluginPresent: (pluginDir: string) => boolean;
    /** This device's local manifest `isDesktopOnly` for the plugin, or
     *  undefined when unknown (no local manifest). */
    isDesktopOnly: (pluginDir: string) => boolean | undefined;
}

/**
 * SEND projection: should this device upload `c` to the config server?
 * Depends only on the policy — no receiver state.
 */
export function sendDecision(p: ConfigSyncPolicy, c: ClassifiedPath): boolean {
    // JS safety interlock wins over everything (incl. overrides).
    if (p.blockPluginCode && c.unit === "install-state") return false;
    // Workspace layout is device-local; never synced regardless of policy.
    if (c.unit === "layout") return false;
    const override = p.overrides[c.path];
    if (override !== undefined) return override;
    return p.unitDefaults[c.unit] ?? false;
}

/**
 * RECEIVE projection: should this device materialise `c` to the filesystem?
 * = send projection, narrowed by receiver-only gates. receive ⊆ send.
 */
export function receiveDecision(
    p: ConfigSyncPolicy,
    c: ClassifiedPath,
    ctx: ReceiveContext,
): boolean {
    if (!sendDecision(p, c)) return false;

    // Gate ①presence: a plugin's data.json only makes sense where the
    // plugin is installed. Writing it into a non-existent plugin folder
    // creates a ghost plugin entry.
    if (c.unit === "community-settings" && c.pluginDir) {
        if (!ctx.pluginPresent(c.pluginDir)) return false;
    }

    // Gate ②platform: never materialise a desktop-only plugin's files on a
    // mobile device. Judged from the LOCAL manifest (the plugin is present
    // per gate ①), so no remote manifest is needed — no circular dependency.
    if (ctx.isMobile && c.pluginDir) {
        if (ctx.isDesktopOnly(c.pluginDir) === true) return false;
    }

    return true;
}

/** Default per-unit decisions: portable settings ON, installation state +
 *  layout + unknown OFF. Encodes the "portable settings vs installation
 *  state" seam directly. */
export function defaultUnitDefaults(): Record<ConfigUnit, boolean> {
    return {
        "app-behavior": true,
        "core-settings": true,
        "community-settings": true,
        "theme-css": true,
        snippets: true,
        "enabled-list": false,
        "install-state": false,
        layout: false,
        other: false,
    };
}

/** Fresh default policy: safe side — plugin code is not synced. */
export function defaultConfigSyncPolicy(): ConfigSyncPolicy {
    return {
        schemaVersion: 1,
        unitDefaults: defaultUnitDefaults(),
        overrides: {},
        blockPluginCode: true,
    };
}

/** Fill any unit missing from a (possibly older/partial) persisted policy
 *  with the current default, so a forward-added unit gets a sane decision
 *  without a schema bump. */
export function normalizeUnitDefaults(
    partial: Partial<Record<ConfigUnit, boolean>> | undefined,
): Record<ConfigUnit, boolean> {
    const base = defaultUnitDefaults();
    if (!partial) return base;
    for (const u of CONFIG_UNITS) {
        if (typeof partial[u] === "boolean") base[u] = partial[u] as boolean;
    }
    return base;
}
