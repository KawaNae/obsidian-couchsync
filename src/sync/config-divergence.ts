import type { ConfigDoc } from "../types.ts";
import { configPathFromId } from "../types/doc-id.ts";
import { compareVC, type VCRelation } from "./vector-clock.ts";

/**
 * Per-doc divergence between a local ConfigDoc and its remote counterpart.
 * Only docs that exist on BOTH sides AND are not vclock-equal appear here.
 *
 * `relation` is `compareVC(local.vclock, remote.vclock)`:
 *   - "dominates"  → local is newer; safe to push, dangerous to pull
 *   - "dominated"  → local is older; dangerous to push, safe to pull
 *   - "concurrent" → true conflict; either direction is dangerous
 *
 * Callers filter to the dangerous-for-their-direction subset and surface
 * to the user. New docs (one-sided) are intentionally not divergences —
 * they push or pull cleanly without conflict.
 */
export interface Divergence {
    id: string;
    path: string;
    relation: Exclude<VCRelation, "equal">;
}

export function detectDivergence(
    localDocs: ConfigDoc[],
    remoteDocs: ConfigDoc[],
): Divergence[] {
    const remoteById = new Map(remoteDocs.map((d) => [d._id, d]));
    const out: Divergence[] = [];
    for (const local of localDocs) {
        const remote = remoteById.get(local._id);
        if (!remote) continue;
        const rel = compareVC(local.vclock ?? {}, remote.vclock ?? {});
        if (rel === "equal") continue;
        out.push({
            id: local._id,
            path: configPathFromId(local._id),
            relation: rel,
        });
    }
    return out;
}

/** Push-direction filter: divergences that would clobber newer-remote data. */
export function dangerousForPush(divs: Divergence[]): Divergence[] {
    return divs.filter((d) => d.relation === "concurrent" || d.relation === "dominated");
}

/** Pull-direction filter: divergences that would clobber newer-local data. */
export function dangerousForPull(divs: Divergence[]): Divergence[] {
    return divs.filter((d) => d.relation === "concurrent" || d.relation === "dominates");
}
