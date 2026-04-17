/**
 * Portable modal abstraction.
 *
 * Replaces direct `ConflictModal` / `ConfirmModal` construction in
 * ConflictOrchestrator and ConfigSync so tests can control the user's
 * choice programmatically via `FakeModalPresenter`.
 */

export type ConflictChoice = "keep-local" | "take-remote";

export interface ConflictModalResult {
    /** The user's choice (ignored when `dismissed` is true). */
    choice: ConflictChoice;
    /** True when `dismiss()` was called externally (auto-resolve). */
    dismissed: boolean;
}

export interface IModalPresenter {
    /**
     * Show a side-by-side conflict diff and wait for the user to pick a
     * winner. The returned promise resolves when the modal closes.
     *
     * Returns a dismiss handle so callers can auto-dismiss on
     * `onAutoResolve` from another device.
     */
    showConflictModal(
        filePath: string,
        localText: string,
        remoteText: string,
    ): {
        result: Promise<ConflictModalResult>;
        dismiss: () => void;
    };

    /**
     * Show a simple confirm/cancel dialog. Resolves `true` when the
     * user confirms, `false` on cancel or close.
     */
    showConfirmModal(
        title: string,
        message: string,
        confirmLabel: string,
        danger?: boolean,
    ): Promise<boolean>;
}
