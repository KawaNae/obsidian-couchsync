/**
 * Editor-session-aware write strategy layer.
 *
 * Sits between `VaultSync` (decides *what* to write) and `IVaultIO`
 * (raw bytes). Owns the policy "how to apply remote content while
 * preserving open-editor session state (IME composition, cursor)".
 *
 * Two implementations:
 *   - `FilesystemVaultWriter`: delegates straight to IVaultIO. Used in
 *     tests and any code path that doesn't need editor awareness.
 *   - `EditorAwareVaultWriter` (in adapters/): inspects the active
 *     editors for the path, dispatches CodeMirror transactions instead
 *     of triggering Obsidian's external-edit reload, and defers writes
 *     while the path is in IME composition.
 */

import type { IVaultIO } from "../types/vault-io.ts";

/**
 * Outcome of a write attempt.
 *
 * `applied` — content was committed (to editor and/or disk). Caller
 * proceeds to update lastSyncedVclock and history.
 *
 * `skipped` — write was abandoned (e.g., the local doc diverged during
 * composition). Caller leaves bookkeeping untouched so Reconciler
 * picks up the divergence on its next pass.
 */
export type WriteResult =
    | { applied: true }
    | { applied: false; reason: string };

export interface VaultWriter {
    /**
     * Apply remote content to an existing path. Returns `applied: true`
     * when the new content is committed to vault state (or to the
     * editor, with disk to follow shortly via Obsidian's autosave).
     */
    applyRemoteContent(path: string, content: ArrayBuffer): Promise<WriteResult>;

    /**
     * Apply a remote-driven deletion. Detaches any open leaves first
     * so the editor doesn't outlive its file.
     */
    applyRemoteDeletion(path: string): Promise<void>;

    /**
     * Create a new file. No editor session can exist for a path that
     * doesn't yet exist, so this always goes straight to disk.
     */
    createFile(path: string, content: ArrayBuffer): Promise<void>;

    /** Drop any pending deferred ops without running them. Called on plugin unload. */
    flushAll(): void;
}

/**
 * Headless implementation. Used by tests and harness code that has no
 * Obsidian App instance. All ops go straight through IVaultIO.
 *
 * Production code uses `EditorAwareVaultWriter` from `src/adapters/`.
 */
export class FilesystemVaultWriter implements VaultWriter {
    constructor(private io: IVaultIO) {}

    async applyRemoteContent(path: string, content: ArrayBuffer): Promise<WriteResult> {
        await this.io.writeBinary(path, content);
        return { applied: true };
    }

    async applyRemoteDeletion(path: string): Promise<void> {
        if (await this.io.exists(path)) {
            await this.io.delete(path);
        }
    }

    async createFile(path: string, content: ArrayBuffer): Promise<void> {
        await this.io.createBinary(path, content);
    }

    flushAll(): void {
        // No deferred state.
    }
}
