/**
 * Portable modal abstraction.
 *
 * Replaces direct `ConflictModal` / `ConfirmModal` construction in
 * ConflictOrchestrator and ConfigSync so tests can control the user's
 * choice programmatically via `FakeModalPresenter`.
 */

/**
 * A conflict resolution choice.
 *
 * - `keep-local` / `take-remote`: the user explicitly picked a winner.
 * - `defer`: the user closed the modal WITHOUT choosing (× / Esc / click-out,
 *   or an explicit "Later" action). Defer applies NOTHING — no push, no
 *   LocalDB write, no vault write — and the conflict is kept durably so it is
 *   re-presented next session. This is the safe default: closing a conflict
 *   must never overwrite remote with a possibly-stale local copy (the
 *   2026-06-02 data-loss incident, where × defaulted to keep-local → push).
 */
export type ConflictChoice = "keep-local" | "take-remote" | "defer";

export interface ConflictModalResult {
    /** The user's choice (ignored when `dismissed` is true). */
    choice: ConflictChoice;
    /** True when `dismiss()` was called externally (auto-resolve). */
    dismissed: boolean;
}

/** One conflicting file presented in the batch modal. */
export interface ConflictBatchItem {
    filePath: string;
    /** UTF-8 decoded local content, or "" when binary (not diffable). */
    localText: string;
    /** UTF-8 decoded remote content, or "" when binary. */
    remoteText: string;
    /** True when either side is not diffable text (no inline preview). */
    binary: boolean;
}

/**
 * The user's decision for a whole batch of conflicts.
 * - `all-take-remote` / `all-keep-local`: apply one winner to every item.
 * - `individual`: fall back to resolving each conflict one modal at a time.
 * - `all-defer`: explicitly keep all for later (× / Esc / "Later").
 * - `dismissed`: closed without choosing → treated as `all-defer` (safe).
 */
export type BatchDecision =
    | { kind: "all-take-remote" }
    | { kind: "all-keep-local" }
    | { kind: "individual" }
    | { kind: "all-defer" }
    | { kind: "dismissed" };

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
     * Show ONE modal listing many conflicts at once and let the user pick a
     * bulk action (or fall back to individual resolution). Used when a batch
     * of conflicts would otherwise stack N separate modals — the stacked
     * `modal-bg` overlays turned the screen black at ~10+ (2026-06-02). The
     * caller decides the threshold; this method just renders whatever it's
     * given.
     */
    showConflictBatchModal(items: ConflictBatchItem[]): Promise<BatchDecision>;

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
