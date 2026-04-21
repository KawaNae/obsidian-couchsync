import { App, Modal, Notice, Setting } from "obsidian";
import type { ChunkConsistencyResult } from "../sync/chunk-consistency.ts";
import type { ChunkConsistencyReport } from "../sync/chunk-consistency.ts";
import {
    describeChunkConsistencyResult,
    type ChunkConsistencyView,
    type ReportSection,
} from "./chunk-consistency-view.ts";

/**
 * Invoked by the repair button. Receives the currently displayed
 * report (so the caller derives the plan from fresh state), performs
 * the repair, and returns a freshly-generated post-repair result; the
 * Modal swaps its display in place so the user sees immediate
 * confirmation. The post-repair result may itself be either a new
 * converged report or a needs-convergence state, so the return type
 * is the full union.
 */
export type ChunkRepairInvoker = (
    current: ChunkConsistencyReport,
) => Promise<ChunkConsistencyResult>;

/**
 * Invoked by the "Wait for sync & retry" button in needs-convergence
 * state. Expected to run a one-shot pull + re-analyse. Returning a
 * fresh `ChunkConsistencyResult` lets the Modal re-render without
 * needing to know how the retry was performed.
 */
export type ChunkRetryInvoker = () => Promise<ChunkConsistencyResult>;

export class ChunkConsistencyReportModal extends Modal {
    constructor(
        app: App,
        private result: ChunkConsistencyResult,
        private onRepair?: ChunkRepairInvoker,
        private onRetry?: ChunkRetryInvoker,
    ) {
        super(app);
    }

    onOpen(): void {
        this.render();
    }

    private render(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h3", { text: "Chunk consistency" });

        const view = describeChunkConsistencyResult(this.result);
        contentEl.createEl("p", { text: view.headline });

        if (view.state === "converged") {
            this.renderConverged(contentEl, view);
        } else {
            this.renderNeedsConvergence(contentEl, view);
        }

        this.renderCommonActions(contentEl);
    }

    private renderConverged(
        contentEl: HTMLElement,
        view: Extract<ChunkConsistencyView, { state: "converged" }>,
    ): void {
        if (view.snapshotChanged) {
            const banner = contentEl.createDiv({
                cls: "cs-chunk-consistency__banner",
            });
            banner.createEl("strong", {
                text: "Sync activity detected during scan. ",
            });
            banner.createSpan({
                text: "Re-run to confirm persistent discrepancies.",
            });
        }

        if (!view.hasIssues) {
            contentEl.createEl("p", { text: "No discrepancies found." });
        } else {
            for (const sec of view.sections) this.renderSection(contentEl, sec);
        }

        if (this.onRepair && view.planTotal > 0) {
            const breakdown = contentEl.createDiv({
                cls: "cs-chunk-consistency__plan",
            });
            breakdown.createEl("h4", { text: "Repair plan" });
            const ul = breakdown.createEl("ul");
            for (const b of view.planBullets) ul.createEl("li", { text: b });

            const actions = new Setting(contentEl);
            const label = `Repair ${view.planTotal} chunk(s)`;
            actions.addButton((btn) =>
                btn
                    .setButtonText(label)
                    .setCta()
                    .onClick(async () => {
                        if (this.result.state !== "converged") return;
                        btn.setDisabled(true);
                        btn.setButtonText("Repairing...");
                        try {
                            const next = await this.onRepair!(this.result.report);
                            this.result = next;
                            this.render();
                        } catch (e: any) {
                            new Notice(`Repair failed: ${e?.message ?? e}`, 6000);
                            btn.setDisabled(false);
                            btn.setButtonText(label);
                        }
                    }),
            );
        }
    }

    private renderNeedsConvergence(
        contentEl: HTMLElement,
        view: Extract<ChunkConsistencyView, { state: "needs-convergence" }>,
    ): void {
        const banner = contentEl.createDiv({
            cls: "cs-chunk-consistency__banner",
        });
        banner.createEl("strong", { text: "FileDocs not yet converged. " });
        banner.createSpan({
            text:
                "Repair is unavailable until local and remote agree on every " +
                "FileDoc — running it now can trigger ping-pong with another " +
                "device. Let sync finish, or press the button below to pull " +
                "the latest and retry.",
        });

        for (const sec of view.sections) this.renderSection(contentEl, sec);

        if (this.onRetry) {
            const actions = new Setting(contentEl);
            actions.addButton((btn) =>
                btn
                    .setButtonText("Wait for sync & retry")
                    .setCta()
                    .onClick(async () => {
                        btn.setDisabled(true);
                        btn.setButtonText("Pulling & re-analysing...");
                        try {
                            const next = await this.onRetry!();
                            this.result = next;
                            this.render();
                        } catch (e: any) {
                            new Notice(`Retry failed: ${e?.message ?? e}`, 6000);
                            btn.setDisabled(false);
                            btn.setButtonText("Wait for sync & retry");
                        }
                    }),
            );
        }
    }

    private renderCommonActions(contentEl: HTMLElement): void {
        const actions = new Setting(contentEl);
        actions
            .addButton((btn) =>
                btn
                    .setButtonText("Copy full result as JSON")
                    .onClick(async () => {
                        try {
                            await navigator.clipboard.writeText(
                                JSON.stringify(this.result, null, 2),
                            );
                            new Notice("Result copied to clipboard.");
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

    private renderSection(parent: HTMLElement, section: ReportSection): void {
        const wrap = parent.createDiv({ cls: "cs-chunk-consistency__section" });
        wrap.createEl("h4", { text: section.title });
        const list = wrap.createEl("ul");
        for (const line of section.lines) list.createEl("li", { text: line });
    }
}
