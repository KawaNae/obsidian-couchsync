/**
 * Read a plugin's LOCAL manifest to answer the receive-side desktop-only
 * gate. Deliberately reads the on-disk manifest (not a synced one): the
 * gate only matters when the plugin is already present on this device, and
 * reading local-only keeps the gate free of any "sync the manifest to judge
 * the manifest" circular dependency.
 */

import type { IVaultIO } from "../../types/vault-io.ts";

/**
 * Returns:
 *   - `true`  — local manifest exists and `isDesktopOnly === true`
 *   - `false` — local manifest exists and is not desktop-only
 *   - `undefined` — no readable/parseable local manifest (unknown)
 *
 * `undefined` is treated as "not desktop-only" by the gate (fail-open on a
 * present plugin), matching Obsidian's own default when the field is absent.
 */
export async function readLocalIsDesktopOnly(
    vault: IVaultIO,
    pluginDir: string,
): Promise<boolean | undefined> {
    const manifestPath = `${pluginDir}/manifest.json`;
    try {
        if (!(await vault.exists(manifestPath))) return undefined;
        const buf = await vault.readBinary(manifestPath);
        const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf)));
        return json?.isDesktopOnly === true;
    } catch {
        return undefined;
    }
}
