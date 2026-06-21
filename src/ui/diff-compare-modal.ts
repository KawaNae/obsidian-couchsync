import { App, Modal } from "obsidian";
import { buildSideBySide } from "./diff-utils.ts";

export class DiffCompareModal extends Modal {
    constructor(
        app: App,
        private oldText: string,
        private newText: string,
        private title: string,
        private leftLabel = "Before",
        private rightLabel = "After"
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl, modalEl } = this;
        modalEl.addClass("diff-history-compare-modal");
        contentEl.createEl("h3", { text: this.title });

        const container = contentEl.createDiv({ cls: "diff-compare-container" });
        const leftPanel = container.createDiv({ cls: "diff-compare-panel diff-compare-left" });
        leftPanel.createDiv({ cls: "diff-compare-panel-header", text: this.leftLabel });
        const leftContent = leftPanel.createDiv({ cls: "diff-compare-content" });

        const rightPanel = container.createDiv({ cls: "diff-compare-panel diff-compare-right" });
        rightPanel.createDiv({ cls: "diff-compare-panel-header", text: this.rightLabel });
        const rightContent = rightPanel.createDiv({ cls: "diff-compare-content" });

        buildSideBySide(this.oldText, this.newText, leftContent, rightContent);

        let syncing = false;
        leftContent.addEventListener("scroll", () => {
            if (syncing) return;
            syncing = true;
            requestAnimationFrame(() => { rightContent.scrollTop = leftContent.scrollTop; syncing = false; });
        });
        rightContent.addEventListener("scroll", () => {
            if (syncing) return;
            syncing = true;
            requestAnimationFrame(() => { leftContent.scrollTop = rightContent.scrollTop; syncing = false; });
        });
    }

    onClose(): void { this.contentEl.empty(); }
}
