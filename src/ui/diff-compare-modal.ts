import { App, Modal } from "obsidian";
import DiffMatchPatch from "diff-match-patch";

const dmp = new DiffMatchPatch();

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

        const diffs = dmp.diff_main(this.oldText, this.newText);
        dmp.diff_cleanupSemantic(diffs);

        const container = contentEl.createDiv({ cls: "diff-compare-container" });
        const leftPanel = container.createDiv({ cls: "diff-compare-panel diff-compare-left" });
        leftPanel.createDiv({ cls: "diff-compare-panel-header", text: this.leftLabel });
        const leftContent = leftPanel.createDiv({ cls: "diff-compare-content" });

        const rightPanel = container.createDiv({ cls: "diff-compare-panel diff-compare-right" });
        rightPanel.createDiv({ cls: "diff-compare-panel-header", text: this.rightLabel });
        const rightContent = rightPanel.createDiv({ cls: "diff-compare-content" });

        this.buildSideBySide(diffs, leftContent, rightContent);

        leftContent.addEventListener("scroll", () => { rightContent.scrollTop = leftContent.scrollTop; });
        rightContent.addEventListener("scroll", () => { leftContent.scrollTop = rightContent.scrollTop; });
    }

    onClose(): void { this.contentEl.empty(); }

    private buildSideBySide(diffs: DiffMatchPatch.Diff[], leftEl: HTMLElement, rightEl: HTMLElement): void {
        const oldLines = this.oldText.split("\n");
        const newLines = this.newText.split("\n");
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
