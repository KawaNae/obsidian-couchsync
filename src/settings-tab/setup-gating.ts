/**
 * setup-gating — the single source of truth for which Vault Sync controls
 * are enabled in each `ConnectionState`.
 *
 * Extracted from the tab's render() so the state→affordance mapping is a
 * pure, unit-testable function rather than inline ternaries tangled with
 * Obsidian DOM. The load-bearing rule (Invariant C / Bug 1): the Live
 * Sync toggle is enabled ONLY in `setupDone`/`syncing`. A `settingUp`
 * state — a setup that failed or is mid-flight — keeps Init/Clone enabled
 * for retry but MUST keep Live Sync disabled, so the user can never start
 * sync against a half-built local DB.
 */

import type { ConnectionState } from "../settings.ts";

export interface SetupGating {
    /** Whole connection section is locked (live sync running). */
    locked: boolean;
    /** Init button enabled. */
    initEnabled: boolean;
    /** Clone button enabled (tab further restricts based on DB doc_count). */
    cloneEnabled: boolean;
    /** Live Sync toggle enabled. */
    syncToggleEnabled: boolean;
}

export function setupGating(state: ConnectionState, serverTested: boolean): SetupGating {
    const syncing = state === "syncing";
    const canSetup = serverTested
        && (state === "tested" || state === "setupDone" || state === "settingUp");
    return {
        locked: syncing,
        initEnabled: canSetup,
        cloneEnabled: canSetup,
        syncToggleEnabled: state === "setupDone" || state === "syncing",
    };
}
