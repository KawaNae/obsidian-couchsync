import { App, Modal, Setting } from "obsidian";
import { buildSideBySide } from "./diff-utils.ts";

export type ConflictChoice = "keep-local" | "take-remote";

/**
 * Side-by-side diff modal for concurrent conflict resolution.
 * Shows local vs remote versions and lets the user choose which to keep.
 */
export class ConflictModal extends Modal {
    private resolved = false;
    private resolve: (value: ConflictChoice) => void = () => {};
    /** True if dismiss() was called (auto-resolve from another device). */
    wasDismissed = false;

    constructor(
        app: App,
        private filePath: string,
        private localText: string,
        private remoteText: string,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl, modalEl } = this;
        modalEl.addClass("diff-history-compare-modal");
        contentEl.createEl("h3", {
            text: `Conflict: ${this.filePath}`,
        });
        contentEl.createEl("p", {
            text: "This file was edited on two devices independently. Choose which version to keep.",
            cls: "setting-item-description",
        });

        const container = contentEl.createDiv({ cls: "diff-compare-container" });
        const leftPanel = container.createDiv({ cls: "diff-compare-panel diff-compare-left" });
        leftPanel.createDiv({ cls: "diff-compare-panel-header", text: "Local (this device)" });
        const leftContent = leftPanel.createDiv({ cls: "diff-compare-content" });

        const rightPanel = container.createDiv({ cls: "diff-compare-panel diff-compare-right" });
        rightPanel.createDiv({ cls: "diff-compare-panel-header", text: "Remote (other device)" });
        const rightContent = rightPanel.createDiv({ cls: "diff-compare-content" });

        buildSideBySide(this.localText, this.remoteText, leftContent, rightContent);

        leftContent.addEventListener("scroll", () => { rightContent.scrollTop = leftContent.scrollTop; });
        rightContent.addEventListener("scroll", () => { leftContent.scrollTop = rightContent.scrollTop; });

        // Action buttons
        new Setting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText("Keep Local")
                    .setCta()
                    .onClick(() => {
                        this.resolved = true;
                        this.resolve("keep-local");
                        this.close();
                    }),
            )
            .addButton((btn) =>
                btn
                    .setButtonText("Take Remote")
                    .setWarning()
                    .onClick(() => {
                        this.resolved = true;
                        this.resolve("take-remote");
                        this.close();
                    }),
            );
    }

    onClose(): void {
        if (!this.resolved) {
            // Closed without choosing → default to keep-local (safe)
            this.resolve("keep-local");
        }
        this.contentEl.empty();
    }

    waitForResult(): Promise<ConflictChoice> {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }

    /** Dismiss from outside (e.g. other device resolved the conflict). */
    dismiss(): void {
        this.wasDismissed = true;
        if (!this.resolved) {
            this.resolved = true;
            this.resolve("keep-local"); // value unused — caller checks wasDismissed
        }
        this.close();
    }
}
