/**
 * Single source of truth for sync-state classification.
 *
 * **Do not duplicate this logic at call sites.** Every classification
 * decision in the codebase — `compareFileToDoc`, the `fileToDb` divergent
 * guard, the reconciler's Case A/B dispatch, and `pull-writer.classify`
 * — should route through `classifySyncRelation`. Past bugs (rev 197
 * phantom-write, audit-2026-05-08 false-positive concurrent on initial
 * sync, 2026-05-10 Home.md silent loss) all stem from a vclock-only
 * classifier missing chunks-level signals; consolidating prevents the
 * pattern from recurring.
 *
 * The classifier compares two `(chunks, vclock)` pairs and an optional
 * integration baseline (`lastSynced`). It returns one of:
 *
 * - `identical`         — chunks equal and vclock equal
 * - `vclock-only-drift` — chunks equal but vclock not equal. Caller MUST
 *                         silent-merge via `mergeVC` and MUST NOT push or
 *                         emit `concurrent`. Closes the audit-2026-05-08
 *                         false-positive concurrent class.
 * - `remote-edit`       — chunks differ + right side dominates. Pure pull
 *                         case (left content matches the integration
 *                         baseline; safe to overwrite).
 * - `local-edit`        — chunks differ + left side is at least as
 *                         causally current. Push case.
 * - `true-divergent`    — chunks differ + (vclock concurrent OR right
 *                         dominates AND left has diverged from baseline).
 *                         Genuine conflict requiring user resolution.
 * - `legacy-skip`       — `lastSynced.chunks` is undefined (pre-extension
 *                         meta entry); caller falls back to vclock-only
 *                         logic. PR5 startup sweep will upgrade these.
 *
 * Mapping at call sites:
 *   - vault-scan (compareFileToDoc / reconciler): left = vault disk +
 *     `lastSynced.vclock` as the disk's attributed vclock; right = FileDoc.
 *   - fileToDb push guard: left = freshly-read disk content + previous
 *     `lastSynced.vclock`; right = existing FileDoc.
 *   - pull-writer.classify: left = local DB doc; right = incoming remote
 *     doc; `lastSynced` may be omitted (replication is independent of
 *     vault state).
 *
 * ─────────────────────────────────────────────────────────────────────
 * Sync-state invariants this codebase upholds (cumulative across the
 * `feature/sync-classifier` and `feature/sync-classifier-followup` plans;
 * each failure mode below previously caused a real production silent-loss
 * or vclock-pollution bug):
 *
 * **Invariant 1 — disk-write truth.**
 *   `lastSynced.chunks/size === disk chunks/size` (always). Enforced by
 *   `EditorAwareVaultWriter.applyRemoteContent` writing disk before
 *   reporting `applied: true`. Without this, a stale CM-only path lets
 *   the classifier read a lying baseline.
 *
 * **Invariant 2 — single classifier.**
 *   This file is the only place the chunks×vclock matrix is interpreted.
 *   Call sites consume the discriminated union; they do not branch on
 *   `compareVC` directly.
 *
 * **Invariant 3 — vclock-only drift = silent merge.**
 *   `vclock-only-drift` callers must `mergeVC` and accept; pushing or
 *   emitting `concurrent` on this state is the false-positive concurrent
 *   bug shape (audit-2026-05-08).
 *
 * **Invariant 4 — pending-edit oracle.**
 *   "Has the vault been edited but not yet pushed?" is answered by
 *   `VaultSync.hasUnpushedChanges` via `IPendingProbe.hasPending(path)`
 *   plus a chunks-vs-`lastSynced` comparison. Vclock-only checks are
 *   forbidden here — they are kept in lockstep by `fileToDb`/`dbToFile`
 *   and so always say "no" (= the silent-loss-during-debounce shape).
 *
 * **Invariant 5 — PullVerdict exhaustive.**
 *   Every consumer of `PullVerdict` (vault `PullWriter`, `ConfigPullWriter`,
 *   future pullers) handles all 4 verdicts explicitly with a trailing
 *   `_exhaustive: never`. Fall-through on `silent-merge` was the
 *   audit-2026-05-08 MEDIUM bug shape on the ConfigSync side.
 *
 * **Invariant 6 — vclock derivation provenance.**
 *   A doc whose `vclock` is a placeholder (notably the fake tombstone
 *   built by `pull-writer.handlePulledDeletion`, which is empty because
 *   `_changes` doesn't carry deleted-doc bodies) MUST NOT be used as an
 *   `incrementVC` seed. `ConflictOrchestrator.applyConflictChoice`
 *   derives deletion-conflict vclocks from `localDoc.vclock` instead.
 */

import { compareVC, type VectorClock } from "./vector-clock.ts";
import { chunkListsEqual } from "./chunk-equality.ts";
import type { LastSynced } from "./last-synced.ts";

export type SyncRelation =
    | "identical"
    | "vclock-only-drift"
    | "remote-edit"
    | "local-edit"
    | "true-divergent"
    | "legacy-skip";

export interface ClassifyInput {
    /** The "left" side: the side asking the question.
     *  - vault-scan: vault disk content with `lastSynced.vclock` as its
     *    attributed vclock
     *  - fileToDb: freshly-read disk content
     *  - pull-writer: local DB doc */
    leftVC: VectorClock;
    leftChunks: readonly string[];
    leftSize: number;
    /** The "right" side: the comparing side.
     *  - vault-scan: FileDoc
     *  - fileToDb: existing FileDoc
     *  - pull-writer: incoming remote doc */
    rightVC: VectorClock;
    rightChunks: readonly string[];
    rightSize: number;
    /** Integration baseline. When provided, lets the classifier distinguish
     *  "pure stale, safe to apply remote" from "user edited stale state,
     *  conflict needed". When the baseline lacks chunks/size (legacy entry
     *  pre-extension), the function returns `legacy-skip` for any case
     *  that would have used baseline content; vclock-only outcomes are
     *  unaffected. Pull-writer call sites that don't track integration
     *  state should omit this. */
    lastSynced?: LastSynced;
}

export function classifySyncRelation(input: ClassifyInput): SyncRelation {
    const { leftVC, leftChunks, leftSize, rightVC, rightChunks, rightSize } = input;
    const sizesEqual = leftSize === rightSize;
    const chunksEqual = sizesEqual && chunkListsEqual(leftChunks, rightChunks);
    const vcRel = compareVC(leftVC, rightVC);

    // 1. Trivially identical — both axes aligned.
    if (chunksEqual && vcRel === "equal") return "identical";

    // 2. Same content, different causality. Silent merge via mergeVC.
    if (chunksEqual) return "vclock-only-drift";

    // From here, chunks differ.

    // 3. Genuine conflict — both axes diverged.
    if (vcRel === "concurrent") return "true-divergent";

    // 4. Right is causally newer (left dominated). Default is remote-edit
    //    (pure pull); refine to true-divergent when the local side has
    //    drifted from the integration baseline (= user edited stale).
    if (vcRel === "dominated") {
        return refineRemoteEdit(input);
    }

    // 5. vcRel is "equal" or "dominates" — left side is at least as causally
    //    current as right. The only way to land here with chunks differing
    //    is a local edit that hasn't been pushed yet (or, in the rare PR1
    //    invariant-violation case, stale-bookkeeping that looks identical).
    return "local-edit";
}

/**
 * Refine a "right dominates" case: pure remote-edit when the left side
 * still matches the integration baseline; otherwise the local side has
 * drifted (conflict needed).
 */
function refineRemoteEdit(input: ClassifyInput): SyncRelation {
    const { leftChunks, leftSize, lastSynced } = input;
    if (!lastSynced) return "remote-edit";
    if (lastSynced.chunks === undefined || lastSynced.size === undefined) {
        return "legacy-skip";
    }
    const leftMatchesBaseline =
        leftSize === lastSynced.size && chunkListsEqual(leftChunks, lastSynced.chunks);
    return leftMatchesBaseline ? "remote-edit" : "true-divergent";
}
