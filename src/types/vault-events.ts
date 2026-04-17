/**
 * Portable vault-event abstraction.
 *
 * Replaces direct `App.vault.on()` / `App.vault.offref()` calls so
 * ChangeTracker and HistoryCapture can be driven by `FakeVaultEvents`
 * in tests.
 *
 * The callback signatures deliberately use plain `{path, stat}` values
 * instead of Obsidian's `TFile` / `TAbstractFile`. The adapter
 * (`ObsidianVaultEvents`) performs the `isTFile` guard and unpacks the
 * values before dispatching.
 */

import type { FileStat } from "./vault-io.ts";

/** Opaque handle returned by `on()`, passed back to `offref()`. */
export interface VaultEventRef {
    readonly _brand: "VaultEventRef";
}

export interface IVaultEvents {
    on(
        event: "modify",
        cb: (path: string, stat: FileStat) => void,
    ): VaultEventRef;

    on(
        event: "create",
        cb: (path: string, stat: FileStat) => void,
    ): VaultEventRef;

    on(
        event: "delete",
        cb: (path: string) => void,
    ): VaultEventRef;

    on(
        event: "rename",
        cb: (path: string, oldPath: string, stat: FileStat | undefined) => void,
    ): VaultEventRef;

    /** Unsubscribe a previously registered handler. */
    offref(ref: VaultEventRef): void;
}
