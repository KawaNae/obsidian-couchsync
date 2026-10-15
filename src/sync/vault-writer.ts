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
 *   - `EditorAwareVaultWriter` (in adapters/): inspects the open
 *     editors for the path, declines while one holds input not yet
 *     saved, dispatches CodeMirror transactions instead of triggering
 *     Obsidian's external-edit reload, and defers writes while the path
 *     is in IME composition.
 */

import type { IVaultIO } from "../types/vault-io.ts";

/**
 * Outcome of a write attempt.
 *
 * `applied: true` — the disk now holds the doc's version (content written,
 * or the file removed). Caller proceeds to update lastSynced and history.
 *
 * `applied: false` — the write was declined, and the vault was left as it
 * was. Caller leaves bookkeeping untouched, so the reconcile finds the path
 * again: it writes the doc then, or offers the user's change as a conflict.
 */
export type WriteResult =
    | { applied: true }
    | { applied: false; reason: string };

/** Declined: an open editor holds input not yet saved to disk. The editor
 *  saves it shortly; from then on the vault differs from the last sync, and
 *  the reconcile offers the declined version as a conflict. */
export const UNSAVED_EDITOR_CHANGE = "unsaved-editor-change";

/** Declined: the vault no longer holds what this device last synced for the
 *  path, so the write would replace or remove a change not yet synced. */
export const UNSYNCED_VAULT_CHANGE = "unsynced-vault-change";

export interface VaultWriter {
    /**
     * Apply remote content to an existing path. Returns `applied: true`
     * once the disk holds the new content.
     */
    applyRemoteContent(path: string, content: ArrayBuffer): Promise<WriteResult>;

    /**
     * Apply a remote-driven deletion. Detaches any open leaves first
     * so the editor doesn't outlive its file.
     */
    applyRemoteDeletion(path: string): Promise<WriteResult>;

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

    async applyRemoteDeletion(path: string): Promise<WriteResult> {
        if (await this.io.exists(path)) {
            await this.io.delete(path);
        }
        return { applied: true };
    }

    async createFile(path: string, content: ArrayBuffer): Promise<void> {
        await this.io.createBinary(path, content);
    }

    flushAll(): void {
        // No deferred state.
    }
}
