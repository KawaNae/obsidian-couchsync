import { App, Modal, Setting } from "obsidian";
import DiffMatchPatch from "diff-match-patch";

const dmp = new DiffMatchPatch();

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

        const diffs = dmp.diff_main(this.localText, this.remoteText);
        dmp.diff_cleanupSemantic(diffs);

        const container = contentEl.createDiv({ cls: "diff-compare-container" });
        const leftPanel = container.createDiv({ cls: "diff-compare-panel diff-compare-left" });
        leftPanel.createDiv({ cls: "diff-compare-panel-header", text: "Local (this device)" });
        const leftContent = leftPanel.createDiv({ cls: "diff-compare-content" });

        const rightPanel = container.createDiv({ cls: "diff-compare-panel diff-compare-right" });
        rightPanel.createDiv({ cls: "diff-compare-panel-header", text: "Remote (other device)" });
        const rightContent = rightPanel.createDiv({ cls: "diff-compare-content" });

        this.buildSideBySide(leftContent, rightContent);

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

    private buildSideBySide(leftEl: HTMLElement, rightEl: HTMLElement): void {
        const oldLines = this.localText.split("\n");
        const newLines = this.remoteText.split("\n");
        const lineDiffs = this.computeLineDiffs(oldLines, newLines);

        let leftLineNum = 1;
        let rightLineNum = 1;

        for (const chunk of lineDiffs) {
            if (chunk.type === "equal") {
                for (const line of chunk.lines) {
                    this.addLine(leftEl, leftLineNum++, line, "");
                    this.addLine(rightEl, rightLineNum++, line, "");
                }
            } else if (chunk.type === "delete") {
                for (const line of chunk.lines) {
                    this.addLine(leftEl, leftLineNum++, line, "diff-line-removed");
                    this.addLine(rightEl, null, "", "diff-line-placeholder");
                }
            } else if (chunk.type === "insert") {
                for (const line of chunk.lines) {
                    this.addLine(leftEl, null, "", "diff-line-placeholder");
                    this.addLine(rightEl, rightLineNum++, line, "diff-line-added");
                }
            }
        }
    }

    private addLine(container: HTMLElement, lineNum: number | null, text: string, cls: string): void {
        const row = container.createDiv({ cls: `diff-line ${cls}` });
        row.createSpan({ cls: "diff-line-num", text: lineNum != null ? String(lineNum) : "" });
        row.createSpan({ cls: "diff-line-text", text: text || "\u00A0" });
    }

    private computeLineDiffs(oldLines: string[], newLines: string[]): Array<{ type: "equal" | "insert" | "delete"; lines: string[] }> {
        const { chars1, chars2, lineArray } = this.linesToChars(oldLines, newLines);
        const charDiffs = dmp.diff_main(chars1, chars2, false);
        dmp.diff_cleanupSemantic(charDiffs);

        const result: Array<{ type: "equal" | "insert" | "delete"; lines: string[] }> = [];
        for (const [op, chars] of charDiffs) {
            const lines: string[] = [];
            for (let i = 0; i < chars.length; i++) {
                const idx = chars.charCodeAt(i);
                if (idx < lineArray.length) lines.push(lineArray[idx]);
            }
            let type: "equal" | "insert" | "delete";
            if (op === DiffMatchPatch.DIFF_EQUAL) type = "equal";
            else if (op === DiffMatchPatch.DIFF_INSERT) type = "insert";
            else type = "delete";
            result.push({ type, lines });
        }
        return result;
    }

    private linesToChars(oldLines: string[], newLines: string[]): { chars1: string; chars2: string; lineArray: string[] } {
        const lineArray: string[] = [""];
        const lineHash = new Map<string, number>();
        const encode = (lines: string[]): string => {
            let chars = "";
            for (const line of lines) {
                let idx = lineHash.get(line);
                if (idx === undefined) {
                    idx = lineArray.length;
                    lineHash.set(line, idx);
                    lineArray.push(line);
                }
                chars += String.fromCharCode(idx);
            }
            return chars;
        };
        return { chars1: encode(oldLines), chars2: encode(newLines), lineArray };
    }
}
