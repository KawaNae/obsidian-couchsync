/**
 * Pure view-model for the Chunk Consistency Modal.
 *
 * The Modal owns DOM wiring, but *what* is shown for each branch of
 * `ChunkConsistencyResult` — the strings, the bullet points, which
 * sections are populated — is decided here. That keeps the formatting
 * rules testable without a DOM and enforces one source of truth: any
 * future analyser state added to the union must also slot into this
 * descriptor.
 */

import type {
    ChunkConsistencyReport,
    ChunkConsistencyResult,
    FileDocDivergence,
    FileDocDivergingPair,
} from "../sync/chunk-consistency.ts";
import {
    planFromReport,
    type ChunkRepairPlan,
} from "../sync/chunk-repair.ts";
import { filePathFromId } from "../types/doc-id.ts";

const ID_TRUNCATE_AT = 50;

export interface ReportSection {
    title: string;
    /** Chunk ids or "id — referenced by path1, path2" lines. */
    lines: string[];
}

export interface ConvergedView {
    state: "converged";
    headline: string;
    snapshotChanged: boolean;
    hasIssues: boolean;
    sections: ReportSection[];
    plan: ChunkRepairPlan;
    planTotal: number;
    planBullets: string[];
}

export interface NeedsConvergenceView {
    state: "needs-convergence";
    headline: string;
    total: number;
    sections: ReportSection[];
}

export type ChunkConsistencyView = ConvergedView | NeedsConvergenceView;

export function describeChunkConsistencyResult(
    result: ChunkConsistencyResult,
): ChunkConsistencyView {
    if (result.state === "needs-convergence") {
        return describeNeedsConvergence(result.divergence);
    }
    return describeConverged(result.report);
}

function describeConverged(report: ChunkConsistencyReport): ConvergedView {
    const headline =
        `${report.counts.localChunks} chunk(s) local · ` +
        `${report.counts.remoteChunks} remote · ` +
        `${report.counts.referencedIds} referenced by FileDocs`;

    const hasIssues =
        report.counts.localOnly > 0 ||
        report.counts.remoteOnly > 0 ||
        report.counts.missingReferenced > 0 ||
        report.counts.orphanLocal > 0 ||
        report.counts.orphanRemote > 0;

    const sections: ReportSection[] = [];
    pushIdSection(sections, "Local only (present locally, absent remotely)", report.localOnly);
    pushIdSection(sections, "Remote only (present remotely, absent locally)", report.remoteOnly);
    if (report.missingReferenced.length > 0) {
        sections.push({
            title: `Missing referenced (broken files) — ${report.missingReferenced.length}`,
            lines: truncate(report.missingReferenced).map((ref) => {
                const paths = ref.referencedBy ?? [];
                return paths.length > 0
                    ? `${ref.id} — referenced by ${paths.join(", ")}`
                    : ref.id;
            }),
        });
        if (report.missingReferenced.length > ID_TRUNCATE_AT) {
            appendMoreMarker(sections[sections.length - 1], report.missingReferenced.length);
        }
    }
    pushIdSection(sections, "Orphan (local)", report.orphanLocal);
    pushIdSection(sections, "Orphan (remote)", report.orphanRemote);

    const plan = planFromReport(report);
    const planBullets: string[] = [];
    if (plan.toPush.length > 0) planBullets.push(`push ${plan.toPush.length} → remote`);
    if (plan.toPull.length > 0) planBullets.push(`pull ${plan.toPull.length} ← remote`);
    if (plan.toDeleteLocal.length > 0)
        planBullets.push(`delete ${plan.toDeleteLocal.length} local (one-sided orphan)`);
    if (plan.toDeleteRemote.length > 0)
        planBullets.push(`delete ${plan.toDeleteRemote.length} remote (one-sided orphan, tombstone)`);
    const planTotal =
        plan.toPush.length +
        plan.toPull.length +
        plan.toDeleteLocal.length +
        plan.toDeleteRemote.length;

    return {
        state: "converged",
        headline,
        snapshotChanged: report.snapshotChanged,
        hasIssues,
        sections,
        plan,
        planTotal,
        planBullets,
    };
}

function describeNeedsConvergence(
    divergence: FileDocDivergence,
): NeedsConvergenceView {
    const total =
        divergence.localOnly.length +
        divergence.remoteOnly.length +
        divergence.differing.length;
    const headline =
        `${divergence.localOnly.length} pending push · ` +
        `${divergence.remoteOnly.length} pending pull · ` +
        `${divergence.differing.length} differing — ` +
        `run sync until caught up, then retry`;

    const sections: ReportSection[] = [];
    pushIdSection(
        sections,
        "Pending push (local has, remote missing)",
        divergence.localOnly.map(fileIdToPath),
    );
    pushIdSection(
        sections,
        "Pending pull (remote has, local missing)",
        divergence.remoteOnly.map(fileIdToPath),
    );
    if (divergence.differing.length > 0) {
        sections.push({
            title: `Differing vclock — ${divergence.differing.length}`,
            lines: truncate(divergence.differing).map(differingLine),
        });
        if (divergence.differing.length > ID_TRUNCATE_AT) {
            appendMoreMarker(sections[sections.length - 1], divergence.differing.length);
        }
    }

    return { state: "needs-convergence", headline, total, sections };
}

function differingLine(pair: FileDocDivergingPair): string {
    const path = fileIdToPath(pair.id);
    return `${path} — ${pair.relation}`;
}

function fileIdToPath(id: string): string {
    try {
        return filePathFromId(id);
    } catch {
        return id;
    }
}

function pushIdSection(
    sections: ReportSection[],
    title: string,
    ids: string[],
): void {
    if (ids.length === 0) return;
    const sec: ReportSection = {
        title: `${title} — ${ids.length}`,
        lines: truncate(ids),
    };
    if (ids.length > ID_TRUNCATE_AT) appendMoreMarker(sec, ids.length);
    sections.push(sec);
}

function truncate<T>(arr: T[]): T[] {
    return arr.slice(0, ID_TRUNCATE_AT);
}

function appendMoreMarker(sec: ReportSection, total: number): void {
    sec.lines.push(`... and ${total - ID_TRUNCATE_AT} more`);
}
