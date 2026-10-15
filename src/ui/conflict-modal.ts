import { App, Modal, Setting } from "obsidian";
import { buildSideBySide } from "./diff-utils.ts";
import { formatBytes } from "../settings-tab/couch-fetch.ts";
import type { ConflictChoice, ConflictContent } from "../types/modal-presenter.ts";

// Re-export so existing importers of `ConflictChoice` from this module keep
// working; the canonical definition lives in types/modal-presenter.ts.
export type { ConflictChoice };

/**
 * Render the two versions of a conflicting file side by side: a line diff
 * for text, and for binary a note that the versions cannot be compared
 * with each side's size. Shared by the single and the batch conflict modal.
 */
export function renderConflictContent(el: HTMLElement, content: ConflictContent): void {
    if (content.kind === "binary") {
        el.createEl("p", {
            text: "This is a binary file, so the two versions cannot be compared here. " +
                "Their sizes are shown below.",
            cls: "setting-item-description",
        });
    }
    const container = el.createDiv({ cls: "diff-compare-container" });
    const leftPanel = container.createDiv({ cls: "diff-compare-panel diff-compare-left" });
    leftPanel.createDiv({ cls: "diff-compare-panel-header", text: "Local (this device)" });
    const leftContent = leftPanel.createDiv({ cls: "diff-compare-content" });

    const rightPanel = container.createDiv({ cls: "diff-compare-panel diff-compare-right" });
    rightPanel.createDiv({ cls: "diff-compare-panel-header", text: "Remote (other device)" });
    const rightContent = rightPanel.createDiv({ cls: "diff-compare-content" });

    if (content.kind === "binary") {
        leftContent.createDiv({ cls: "cs-conflict-binary-size", text: describeSize(content.localSize) });
        rightContent.createDiv({ cls: "cs-conflict-binary-size", text: describeSize(content.remoteSize) });
        return;
    }

    buildSideBySide(content.localText, content.remoteText, leftContent, rightContent);
    leftContent.addEventListener("scroll", () => { rightContent.scrollTop = leftContent.scrollTop; });
    rightContent.addEventListener("scroll", () => { leftContent.scrollTop = rightContent.scrollTop; });
}

/** The exact byte count tells apart two versions of the same rounded size. */
function describeSize(bytes: number): string {
    if (bytes < 1024) return `Size: ${bytes} bytes`;
    return `Size: ${formatBytes(bytes)} (${bytes.toLocaleString()} bytes)`;
}

/**
 * Conflict resolution modal for one file: shows the local and the remote
 * version and lets the user choose which to keep.
 */
export class ConflictModal extends Modal {
    private resolved = false;
    private resolve: (value: ConflictChoice) => void = () => {};
    /** True if dismiss() was called (auto-resolve from another device). */
    wasDismissed = false;

    constructor(
        app: App,
        private filePath: string,
        private content: ConflictContent,
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

        renderConflictContent(contentEl, this.content);

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
            )
            .addButton((btn) =>
                btn
                    .setButtonText("Later")
                    .onClick(() => {
                        // Explicit defer: same as closing without choosing.
                        this.resolved = true;
                        this.resolve("defer");
                        this.close();
                    }),
            );
    }

    onClose(): void {
        if (!this.resolved) {
            // Closed without choosing (× / Esc / click-outside) → DEFER, not
            // keep-local. Deferring applies nothing and keeps the conflict for
            // next session. Defaulting to keep-local here let closing a stale
            // device's conflict overwrite newer remote content (data loss).
            this.resolve("defer");
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
            this.resolve("defer"); // value unused — caller checks wasDismissed
        }
        this.close();
    }
}
