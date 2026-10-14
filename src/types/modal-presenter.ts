/**
 * Portable modal abstraction.
 *
 * Replaces direct `ConflictModal` / `ConfirmModal` construction in
 * ConflictOrchestrator and ConfigSync so tests can control the user's
 * choice programmatically via `FakeModalPresenter`.
 */

import type { PushReview } from "../sync/config-push-review.ts";
import type { SharedAtPointer } from "../sync/config-reconcile.ts";
import type { ConfigCreateConfirm } from "../sync/config-create-preview.ts";

/**
 * A conflict resolution choice.
 *
 * - `keep-local` / `take-remote`: the user explicitly picked a winner.
 * - `defer`: the user closed the modal WITHOUT choosing (× / Esc / click-out,
 *   or an explicit "Later" action). Defer applies NOTHING — no push, no
 *   LocalDB write, no vault write — and the conflict is kept durably so it is
 *   re-presented next session. This is the safe default: closing a conflict
 *   must never overwrite remote with a possibly-stale local copy (when ×
 *   defaulted to keep-local → push, that lost newer remote content).
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

/** What an overwriting config Pull is about to do, for its confirmation. */
export interface ConfigOverwritePreview {
    /** Files written with the shared content; `created` when the file is
     *  not on disk yet. */
    writes: Array<{ path: string; created: boolean }>;
    /** Files deleted: on disk, taking part in sharing, not shared. */
    deletes: string[];
    /** Keys kept on this device (`deviceOnlyKeys`) that stop being kept. */
    keptKeys: number;
    /** Paths left alone because their content is not available. */
    skipped: string[];
}

/** A key kept on this device that is about to take the shared value. */
export interface ConfigShareAgainPreview {
    path: string;
    /** JSON Pointer of the key (`/<plugin id>` in community-plugins.json). */
    pointer: string;
    /** The shared value the Pull writes (read after its copy). */
    shared: SharedAtPointer;
    /** The value comes from a plugin's data.json: shown only on request. */
    hideValue: boolean;
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
     * Show ONE modal listing many conflicts at once and let the user pick a
     * bulk action (or fall back to individual resolution). Used when a batch
     * of conflicts would otherwise stack N separate modals — the stacked
     * `modal-bg` overlays turned the screen black at ~10+. The
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

    /**
     * Show the config Push list and wait for the user. Resolves the ids of
     * the items to send, or null when the user cancelled (nothing is sent).
     */
    showConfigPushModal(review: PushReview): Promise<string[] | null>;

    /**
     * Show what an overwriting config Pull will write and delete, and wait
     * for the user. Resolves true to go ahead, false on cancel or close
     * (nothing is changed).
     */
    showConfigOverwriteModal(preview: ConfigOverwritePreview): Promise<boolean>;

    /**
     * Show the key that Share again makes take the shared value, and wait
     * for the user. Resolves true to go ahead, false on cancel or close
     * (nothing is changed; the key stays kept on this device).
     */
    showConfigShareAgainModal(preview: ConfigShareAgainPreview): Promise<boolean>;

    /**
     * Show what config Create would delete and the root it builds, and wait
     * for the user. Resolves true to go ahead, false on cancel or close
     * (nothing is changed).
     */
    showConfigCreateModal(confirm: ConfigCreateConfirm): Promise<boolean>;
}
