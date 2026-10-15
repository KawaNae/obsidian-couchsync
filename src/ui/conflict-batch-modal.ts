import { App, Modal, Setting } from "obsidian";
import { renderConflictContent } from "./conflict-modal.ts";
import type { ConflictBatchItem, BatchDecision } from "../types/modal-presenter.ts";

/**
 * Batch conflict resolution modal.
 *
 * Shows ALL pending conflicts in a single modal — one list, one set of bulk
 * actions — instead of stacking N separate `ConflictModal`s. Stacking was the
 * cause of the "screen goes black at ~10 conflicts" bug: each Obsidian
 * `Modal.open()` adds a semi-opaque `modal-bg` overlay, and ~10 of them
 * compound to near-opaque. One modal = one overlay.
 *
 * Actions:
 *   - Take all remote (destructive — caller gates it behind a confirm)
 *   - Keep all local
 *   - Decide individually → falls back to per-file modals
 *   - Later (defer all) — and closing the modal (× / Esc) defers too (safe).
 */
export class ConflictBatchModal extends Modal {
    private resolved = false;
    private resolve: (value: BatchDecision) => void = () => {};

    constructor(app: App, private items: ConflictBatchItem[]) {
        super(app);
    }

    onOpen(): void {
        const { contentEl, modalEl } = this;
        modalEl.addClass("cs-conflict-batch-modal");
        contentEl.createEl("h3", {
            text: `${this.items.length} sync conflicts`,
        });
        contentEl.createEl("p", {
            text:
                "These files were edited on two devices independently. Choose a " +
                "bulk action, decide each one individually, or defer them for " +
                "later. Closing this dialog defers everything (nothing is changed).",
            cls: "setting-item-description",
        });

        // Scrollable list of conflicting paths (truncated like the consistency
        // report modal so a huge batch doesn't blow up the DOM).
        const listWrap = contentEl.createDiv({ cls: "cs-conflict-batch-list" });
        const list = listWrap.createEl("ul");
        // Inline preview: clicking a path shows its two versions, as the
        // single conflict modal does (a diff for text, the sizes for binary).
        const preview = contentEl.createDiv({ cls: "cs-conflict-batch-preview" });
        const SHOWN = 100;
        for (const it of this.items.slice(0, SHOWN)) {
            const li = list.createEl("li", { text: it.filePath });
            if (it.content.kind === "binary") {
                li.createSpan({ text: "  (binary)", cls: "setting-item-description" });
            }
            li.style.cursor = "pointer";
            li.addEventListener("click", () => {
                preview.empty();
                renderConflictContent(preview, it.content);
            });
        }
        if (this.items.length > SHOWN) {
            list.createEl("li", { text: `… and ${this.items.length - SHOWN} more` });
        }

        new Setting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText("Keep all local")
                    .setCta()
                    .onClick(() => this.finish({ kind: "all-keep-local" })),
            )
            .addButton((btn) =>
                btn
                    .setButtonText("Take all remote")
                    .setWarning()
                    .onClick(() => this.finish({ kind: "all-take-remote" })),
            )
            .addButton((btn) =>
                btn
                    .setButtonText("Decide individually")
                    .onClick(() => this.finish({ kind: "individual" })),
            )
            .addButton((btn) =>
                btn
                    .setButtonText("Later")
                    .onClick(() => this.finish({ kind: "all-defer" })),
            );
    }

    private finish(decision: BatchDecision): void {
        this.resolved = true;
        this.resolve(decision);
        this.close();
    }

    onClose(): void {
        if (!this.resolved) {
            // Closed without choosing → defer all (safe: changes nothing).
            this.resolve({ kind: "dismissed" });
        }
        this.contentEl.empty();
    }

    waitForResult(): Promise<BatchDecision> {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }
}
