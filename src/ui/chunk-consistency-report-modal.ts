import { App, Modal, Notice, Setting } from "obsidian";
import type { ChunkConsistencyReport } from "../sync/chunk-consistency.ts";
import { planFromReport } from "../sync/chunk-repair.ts";

const TRUNCATE_AT = 50;

/**
 * Invoked by the repair button. Receives the currently displayed
 * report (so the caller derives the plan from fresh state), performs
 * the repair, and returns a freshly-generated post-repair report; the
 * Modal swaps its display in place so the user sees immediate
 * confirmation.
 */
export type ChunkRepairInvoker = (
    current: ChunkConsistencyReport,
) => Promise<ChunkConsistencyReport>;

export class ChunkConsistencyReportModal extends Modal {
    constructor(
        app: App,
        private report: ChunkConsistencyReport,
        private onRepair?: ChunkRepairInvoker,
    ) {
        super(app);
    }

    onOpen(): void {
        this.render();
    }

    private render(): void {
        const { contentEl, report } = this;
        contentEl.empty();
        contentEl.createEl("h3", { text: "Chunk consistency" });

        contentEl.createEl("p", {
            text:
                `${report.counts.localChunks} chunk(s) local · ` +
                `${report.counts.remoteChunks} remote · ` +
                `${report.counts.referencedIds} referenced by FileDocs`,
        });

        if (report.snapshotChanged) {
            const banner = contentEl.createDiv({ cls: "cs-consistency-section" });
            banner.style.background = "#fff3cd";
            banner.style.border = "1px solid #ffeeba";
            banner.style.padding = "8px";
            banner.style.marginBottom = "8px";
            banner.createEl("strong", { text: "Sync activity detected during scan. " });
            banner.createSpan({
                text: "Re-run to confirm persistent discrepancies.",
            });
        }

        const totalIssues =
            report.counts.localOnly +
            report.counts.remoteOnly +
            report.counts.missingReferenced +
            report.counts.orphanLocal +
            report.counts.orphanRemote;

        if (totalIssues === 0) {
            contentEl.createEl("p", { text: "No discrepancies found." });
        } else {
            this.renderIds(contentEl, "Local only (present locally, absent remotely)", report.localOnly);
            this.renderIds(contentEl, "Remote only (present remotely, absent locally)", report.remoteOnly);
            this.renderRefs(
                contentEl,
                "Missing referenced (broken files)",
                report.missingReferenced,
            );
            this.renderIds(contentEl, "Orphan (local)", report.orphanLocal);
            this.renderIds(contentEl, "Orphan (remote)", report.orphanRemote);
        }

        const plan = planFromReport(report);
        const planTotal =
            plan.toPush.length +
            plan.toPull.length +
            plan.toDeleteLocal.length +
            plan.toDeleteRemote.length;

        if (this.onRepair && planTotal > 0) {
            const breakdown = contentEl.createDiv({ cls: "cs-consistency-section" });
            breakdown.createEl("h4", { text: "Repair plan" });
            const ul = breakdown.createEl("ul");
            if (plan.toPush.length > 0)
                ul.createEl("li", { text: `push ${plan.toPush.length} → remote` });
            if (plan.toPull.length > 0)
                ul.createEl("li", { text: `pull ${plan.toPull.length} ← remote` });
            if (plan.toDeleteLocal.length > 0)
                ul.createEl("li", {
                    text: `delete ${plan.toDeleteLocal.length} local (one-sided orphan)`,
                });
            if (plan.toDeleteRemote.length > 0)
                ul.createEl("li", {
                    text: `delete ${plan.toDeleteRemote.length} remote (one-sided orphan, tombstone)`,
                });
        }

        const actions = new Setting(contentEl);

        if (this.onRepair && planTotal > 0) {
            const label = `Repair ${planTotal} chunk(s)`;
            actions.addButton((btn) =>
                btn
                    .setButtonText(label)
                    .setCta()
                    .onClick(async () => {
                        btn.setDisabled(true);
                        btn.setButtonText("Repairing...");
                        try {
                            const next = await this.onRepair!(this.report);
                            this.report = next;
                            this.render();
                        } catch (e: any) {
                            new Notice(`Repair failed: ${e?.message ?? e}`, 6000);
                            btn.setDisabled(false);
                            btn.setButtonText(label);
                        }
                    }),
            );
        }

        actions
            .addButton((btn) =>
                btn
                    .setButtonText("Copy full report as JSON")
                    .onClick(async () => {
                        try {
                            await navigator.clipboard.writeText(
                                JSON.stringify(this.report, null, 2),
                            );
                            new Notice("Report copied to clipboard.");
                        } catch (e: any) {
                            new Notice(`Copy failed: ${e?.message ?? e}`, 6000);
                        }
                    }),
            )
            .addButton((btn) =>
                btn
                    .setButtonText("Close")
                    .onClick(() => this.close()),
            );
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private renderIds(parent: HTMLElement, title: string, ids: string[]): void {
        if (ids.length === 0) return;
        const wrap = parent.createDiv({ cls: "cs-consistency-section" });
        wrap.createEl("h4", { text: `${title} — ${ids.length}` });
        const list = wrap.createEl("ul");
        for (const id of ids.slice(0, TRUNCATE_AT)) {
            list.createEl("li", { text: id });
        }
        if (ids.length > TRUNCATE_AT) {
            list.createEl("li", { text: `... and ${ids.length - TRUNCATE_AT} more` });
        }
    }

    private renderRefs(
        parent: HTMLElement,
        title: string,
        refs: Array<{ id: string; referencedBy?: string[] }>,
    ): void {
        if (refs.length === 0) return;
        const wrap = parent.createDiv({ cls: "cs-consistency-section" });
        wrap.createEl("h4", { text: `${title} — ${refs.length}` });
        const list = wrap.createEl("ul");
        for (const ref of refs.slice(0, TRUNCATE_AT)) {
            const paths = ref.referencedBy ?? [];
            const text = paths.length > 0
                ? `${ref.id} — referenced by ${paths.join(", ")}`
                : ref.id;
            list.createEl("li", { text });
        }
        if (refs.length > TRUNCATE_AT) {
            list.createEl("li", { text: `... and ${refs.length - TRUNCATE_AT} more` });
        }
    }
}
