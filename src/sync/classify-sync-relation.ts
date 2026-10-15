/**
 * Single source of truth for sync-state classification.
 *
 * **Do not duplicate this logic at call sites.** Every classification
 * decision in the codebase — `compareFileToDoc`, the `fileToDb` divergent
 * guard, the reconciler's Case A/B dispatch, and `pull-writer.classify`
 * — should route through `classifySyncRelation`. Past bugs (a phantom
 * write, false-positive concurrent conflicts on initial sync, a silent
 * loss of a note's content) all stem from a vclock-only classifier missing
 * chunks-level signals; consolidating prevents the pattern from recurring.
 *
 * The classifier compares two `(chunks, vclock)` pairs and an optional
 * integration baseline (`lastSynced`). It returns one of:
 *
 * - `identical`         — chunks equal and vclock equal
 * - `vclock-only-drift` — chunks equal but vclock not equal. Caller MUST
 *                         adopt the FileDoc's vclock as the integration
 *                         baseline (`lastSynced.vclock = fileDoc.vclock`)
 *                         and MUST NOT push or emit `concurrent`. Pushing
 *                         would raise false-positive concurrent conflicts,
 *                         and merging clocks into the baseline loops on
 *                         phantom stamps.
 * - `remote-edit`       — chunks differ + right side dominates. Pure pull
 *                         case: at a vault call site, the left content
 *                         still matches an alive integration baseline, so
 *                         it is safe to overwrite.
 * - `local-edit`        — chunks differ + left side is at least as
 *                         causally current. Push case.
 * - `true-divergent`    — chunks differ + (vclock concurrent OR right
 *                         dominates at a vault call site while no alive
 *                         baseline explains the left content OR a
 *                         pull-site vclock TIE — equal clocks with differing
 *                         content, the config-Create stale-collision shape, only
 *                         when `leftVCAttributed` is falsy). Genuine conflict
 *                         requiring user resolution.
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
 * Sync-state invariants this codebase upholds (each failure mode below
 * previously caused a real production silent-loss or vclock-pollution bug):
 *
 * **Disk-write truth.**
 *   `lastSynced.chunks/size === disk chunks/size` (always). Enforced by
 *   `EditorAwareVaultWriter.applyRemoteContent` writing disk before
 *   reporting `applied: true`. Without this, a stale CM-only path lets
 *   the classifier read a lying baseline.
 *
 * **Single classifier.**
 *   This file is the only place the chunks×vclock matrix is interpreted.
 *   Call sites consume the discriminated union; they do not branch on
 *   `compareVC` directly.
 *
 * **Chunks-equal vclock authority.**
 *   `vclock-only-drift` callers MUST adopt `fileDoc.vclock` as the new
 *   `lastSynced.vclock` (no `mergeVC`). Chunks-equal means the FileDoc is
 *   the canonical authority for this path's vclock identity; any extra
 *   stamps on the prior `lastSynced.vclock` are either phantom orphans
 *   or echoes of rev-tree conflict branches, neither of which need to
 *   live in the local integration baseline. Pushing or emitting
 *   `concurrent` here is the false-positive concurrent bug shape; a
 *   `mergeVC`-based resolver here is the phantom-loop bug shape
 *   because lastSynced ends up dominating fileDoc and the next reconcile
 *   re-triggers vclock-only-drift forever. Note the asymmetry with
 *   `pull-writer` / `config-pull-writer`, which DO write the merged
 *   clock back to doc.vclock (replicated to remote, so identity follows).
 *   Reconciler vault-scan keeps the FileDoc untouched to avoid
 *   rev-tree inflation across the hundreds of paths a steady vault
 *   holds, so adopting fileDoc.vclock on the lastSynced side is the
 *   only convergence path.
 *
 * **Pending-edit oracle.**
 *   "Has the vault been edited but not yet pushed?" is answered by
 *   `VaultSync.hasUnpushedChanges` via `IPendingProbe.hasPending(path)`
 *   plus a chunks-vs-`lastSynced` comparison. Vclock-only checks are
 *   forbidden here — they are kept in lockstep by `fileToDb`/`dbToFile`
 *   and so always say "no" (= the silent-loss-during-debounce shape).
 *
 * **PullVerdict exhaustive.**
 *   Every consumer of `PullVerdict` (vault `PullWriter`, `ConfigPullWriter`,
 *   future pullers) handles all 4 verdicts explicitly with a trailing
 *   `_exhaustive: never`. On the ConfigSync side, `silent-merge` once fell
 *   through into the accepted (apply) branch.
 *
 * **Vclock derivation provenance.**
 *   A doc whose `vclock` is a placeholder (notably the fake tombstone
 *   built by `pull-writer.handlePulledDeletion`, which is empty because
 *   `_changes` doesn't carry deleted-doc bodies) MUST NOT be used as an
 *   `incrementVC` seed. `ConflictOrchestrator.applyConflictChoice`
 *   derives deletion-conflict vclocks from `localDoc.vclock` instead.
 *
 * **Deletion is an integration event.**
 *   A tombstone (`deleted: true`) is a doc state like any other: applying
 *   one establishes a *deleted baseline* (`lastSynced.deleted`), it does
 *   NOT erase the baseline. Erasing it left a note recreated after its
 *   deletion stuck: the recreate-after-delete path lost its causal anchor, the guard classified
 *   the tombstone as `remote-edit`, and the path was stuck unpushable
 *   forever (pull was already converged; reconcile re-entered the same
 *   guard). Two corollaries:
 *   - The deleted flag — not the chunk fingerprint — is the truth of the
 *     deleted state. Tombstone fingerprints are NOT normalized
 *     (`markDeleted` spreads the prior doc and keeps its chunks/size;
 *     `buildAcceptedTombstone` writes `chunks: [], size: 0`), so
 *     `contentEqual` treats deleted×deleted as equal and deleted×alive as
 *     unequal regardless of chunks. Callers pass `leftDeleted`/
 *     `rightDeleted`; omitting them (pull-writer's content-only call site
 *     shape) preserves the legacy chunks-only semantics.
 *   - `remote-edit` against a tombstone means "deletion pending disk
 *     apply" — it is only safe when the left content still matches an
 *     alive baseline. With no baseline (or a deleted one, or one without a
 *     fingerprint) the safe verdict is `true-divergent`: silent-skip
 *     wedges the path unpushable and silent-restore resurrects a user
 *     deletion, so the conflict orchestrator must arbitrate.
 *
 * **The disk is replaced only when the baseline explains it.**
 *   At a vault call site the disk has no clock of its own; "right
 *   dominates" only says the doc moved past what this device integrated.
 *   It says nothing about the disk content, so `remote-edit` (overwrite or
 *   delete the disk) needs an alive baseline with a fingerprint that the
 *   disk still matches. Without one, differing content is content this
 *   device never synced — a file made here before its first push, or one
 *   that came into the filters — and the user chooses (`true-divergent`).
 *   Equal content never reaches this question: it is `identical` or
 *   `vclock-only-drift`, and the caller only aligns the baseline.
 */

import { compareVC, type VectorClock } from "./vector-clock.ts";
import { chunkListsEqual } from "./chunk-equality.ts";
import type { LastSynced } from "./last-synced.ts";

export type SyncRelation =
    | "identical"
    | "vclock-only-drift"
    | "remote-edit"
    | "local-edit"
    | "true-divergent";

export interface ClassifyInput {
    /** The "left" side: the side asking the question.
     *  - vault-scan: vault disk content with `lastSynced.vclock` as its
     *    attributed vclock
     *  - fileToDb: freshly-read disk content
     *  - pull-writer: local DB doc */
    leftVC: VectorClock;
    leftChunks: readonly string[];
    leftSize: number;
    /** Whether the left side is a deletion tombstone (deletion is an integration event).
     *  Defaults to false — a disk file is always alive; pull-writer call
     *  sites pass `localDoc.deleted`. */
    leftDeleted?: boolean;
    /** True when `leftVC` is NOT the left side's own causality but the
     *  integration baseline's (vault call sites: a disk file has no vclock,
     *  so `lastSynced.vclock` is attributed to it). With an attributed
     *  vclock, "right dominates" is only trustworthy when an alive baseline
     *  explains the left content — without one the verdict falls to
     *  `true-divergent`. Pull call sites compare two docs with real vclocks
     *  and omit this: there "right dominates" is genuine causality, and the
     *  right side (a newer edit or a dominating tombstone) is taken. */
    leftVCAttributed?: boolean;
    /** The "right" side: the comparing side.
     *  - vault-scan: FileDoc
     *  - fileToDb: existing FileDoc
     *  - pull-writer: incoming remote doc */
    rightVC: VectorClock;
    rightChunks: readonly string[];
    rightSize: number;
    /** Whether the right side is a deletion tombstone. */
    rightDeleted?: boolean;
    /** Integration baseline of the path, read only at vault call sites
     *  (`leftVCAttributed`). Undefined when this device has none: it
     *  distinguishes "disk still holds what was synced, safe to apply
     *  remote" from "the disk holds content not synced, conflict needed".
     *  An entry without chunks/size (written before baselines carried a
     *  fingerprint) cannot explain the disk, so it counts as none for
     *  that question; vclock-only outcomes are unaffected. Pull call
     *  sites do not track integration state and omit this. */
    lastSynced?: LastSynced;
    /** True only during a CONFIG pull's seq-regression re-pull (the remote
     *  config DB was destroyed + recreated by a Create elsewhere — see
     *  `config-pull-writer` self-heal). In that window the remote is a fresh
     *  authority and chunk ids are NOT a reliable content fingerprint: an
     *  encrypted Create rotates the salt → HMAC key, so identical content gets
     *  different chunk ids while the vclock resets to a colliding `{device:1}`.
     *  A pull-site vclock tie under recreate is therefore adopted from remote
     *  (take-remote) rather than surfaced as a conflict — both the
     *  non-propagation bug and the false-positive concurrent flood resolve.
     *  Pull call sites that are NOT a recreate re-pull, and all vault/disk
     *  call sites, omit this (falsy). */
    recreateAuthority?: boolean;
}

export function classifySyncRelation(input: ClassifyInput): SyncRelation {
    const { leftVC, leftChunks, leftSize, rightVC, rightChunks, rightSize } = input;
    const leftDeleted = input.leftDeleted === true;
    const rightDeleted = input.rightDeleted === true;
    // Deletion is an integration event: the deleted flag outranks the fingerprint. Tombstone
    // fingerprints are not normalized, so deleted×deleted is content-equal
    // (two deletions of the same path are the same state) and deleted×alive
    // is never content-equal (even when the tombstone retained the chunks
    // of the content it deleted).
    const sizesEqual = leftSize === rightSize;
    const chunksEqual = leftDeleted === rightDeleted && (
        leftDeleted || (sizesEqual && chunkListsEqual(leftChunks, rightChunks))
    );
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
    //    current as right, chunks differ.
    //
    //    - "dominates" (ANY caller): the left side genuinely advanced its
    //      clock above right with new content = a local edit not yet pushed.
    //      → local-edit.
    //    - "equal" at a VAULT-DISK call site (leftVCAttributed === true): leftVC
    //      is the attributed `lastSynced.vclock`, NOT the disk content's own
    //      clock, so an equal clock does NOT imply equal content — this is the
    //      steady-state "disk edited, vclock not yet bumped" local edit.
    //      → local-edit.
    //    - "equal" at a PULL call site (two REAL doc vclocks, leftVCAttributed
    //      falsy): a vclock TIE with differing content is impossible for a
    //      legit local edit (it would have bumped the clock above remote). It
    //      is the config-Create stale-collision anomaly — a zombie doc left at
    //      `{device:1}` colliding with a freshly-reset doc at `{device:1}`
    //      (confirmed on a device: the first push at vclock {1} did not
    //      propagate). The vclocks cannot order them, so silently keeping
    //      either side is the silent-loss / non-propagation bug. Surface it.
    //      → true-divergent — UNLESS this is a recreate re-pull (see below).
    if (vcRel === "equal" && input.leftVCAttributed !== true) {
        // Config seq-regression re-pull: the remote was recreated by a Create
        // elsewhere. Chunk ids are unreliable across the Create's key rotation
        // (encrypted: new salt → new HMAC ids for identical content), and the
        // recreated remote is the authoritative fresh slate, so adopt it
        // rather than surface every key-rotated doc as a conflict. Only the
        // exact vclock tie is affected; a genuine peer edit is `dominates`
        // (kept) or a foreign-device `concurrent` (surfaced), never a tie.
        if (input.recreateAuthority === true) return "remote-edit";
        return "true-divergent";
    }
    return "local-edit";
}

/**
 * Refine a "right dominates" case (chunks differ).
 *
 * Pull call sites compare two docs with real clocks: the right side is
 * causally newer, so take it (`remote-edit`).
 *
 * Vault call sites (attributed leftVC): the domination is over the
 * baseline's clock, not over the disk content. Overwriting or deleting the
 * disk is safe only when an alive baseline with a fingerprint still matches
 * the disk. Otherwise the disk holds content this device never synced: the
 * user edited or deleted the synced version (alive baseline that no longer
 * matches), recreated the path after a synced deletion (deleted baseline),
 * or made or gained the file without ever syncing it (no baseline, or one
 * without a fingerprint). Silent overwrite loses it, silent skip wedges the
 * path, so the conflict orchestrator lets the user choose.
 */
function refineRemoteEdit(input: ClassifyInput): SyncRelation {
    if (input.leftVCAttributed !== true) return "remote-edit";
    const { leftChunks, leftSize, lastSynced } = input;
    const leftMatchesBaseline =
        lastSynced !== undefined
        && lastSynced.deleted !== true
        && lastSynced.chunks !== undefined
        && lastSynced.size !== undefined
        && input.leftDeleted !== true
        && leftSize === lastSynced.size
        && chunkListsEqual(leftChunks, lastSynced.chunks);
    return leftMatchesBaseline ? "remote-edit" : "true-divergent";
}
