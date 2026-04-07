import { App, Modal, Setting } from "obsidian";
import type { ReconcileReport } from "../sync/reconciler.ts";
import { totalDiscrepancies } from "../sync/reconciler.ts";

export class ConsistencyReportModal extends Modal {
    constructor(
        app: App,
        private report: ReconcileReport,
        private onRepair: () => Promise<void>,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl, report } = this;
        contentEl.createEl("h3", { text: "Consistency report" });

        const total = totalDiscrepancies(report);
        if (total === 0) {
            contentEl.createEl("p", {
                text: `No discrepancies found. ${report.inSync} file(s) verified in sync.`,
            });
            new Setting(contentEl).addButton((btn) =>
                btn.setButtonText("Close").setCta().onClick(() => this.close()),
            );
            return;
        }

        contentEl.createEl("p", {
            text: `${total} discrepancy(ies) detected. Review each section before repair.`,
        });

        this.renderSection(contentEl, "Pushed (vault → DB, new files)", report.pushed);
        this.renderSection(contentEl, "Local wins (vault edits to push)", report.localWins);
        this.renderSection(contentEl, "Remote wins (remote edits to pull)", report.remoteWins);
        this.renderSection(contentEl, "Restored (newly pulled from another device)", report.restored);
        this.renderSection(contentEl, "Deleted (this device removed them)", report.deleted);

        new Setting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText("Repair (apply all)")
                    .setCta()
                    .onClick(async () => {
                        btn.setDisabled(true);
                        btn.setButtonText("Repairing...");
                        try {
                            await this.onRepair();
                        } finally {
                            this.close();
                        }
                    }),
            )
            .addButton((btn) => btn.setButtonText("Close").onClick(() => this.close()));
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private renderSection(parent: HTMLElement, title: string, items: string[]): void {
        if (items.length === 0) return;
        const wrap = parent.createDiv({ cls: "cs-consistency-section" });
        wrap.createEl("h4", { text: `${title} — ${items.length}` });
        const list = wrap.createEl("ul");
        for (const item of items.slice(0, 50)) {
            list.createEl("li", { text: item });
        }
        if (items.length > 50) {
            list.createEl("li", { text: `... and ${items.length - 50} more` });
        }
    }
}
