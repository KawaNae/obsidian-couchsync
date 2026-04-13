/**
 * Shared line-level diff utilities for side-by-side diff panels.
 *
 * Used by DiffCompareModal (history comparison) and ConflictModal
 * (concurrent conflict resolution).
 */

import DiffMatchPatch from "diff-match-patch";

const dmp = new DiffMatchPatch();

export type LineDiffType = "equal" | "insert" | "delete";

export interface LineDiffChunk {
    type: LineDiffType;
    lines: string[];
}

/** Compute line-level diffs between two texts. */
export function computeLineDiffs(oldLines: string[], newLines: string[]): LineDiffChunk[] {
    const { chars1, chars2, lineArray } = linesToChars(oldLines, newLines);
    const charDiffs = dmp.diff_main(chars1, chars2, false);
    dmp.diff_cleanupSemantic(charDiffs);

    const result: LineDiffChunk[] = [];
    for (const [op, chars] of charDiffs) {
        const lines: string[] = [];
        for (let i = 0; i < chars.length; i++) {
            const idx = chars.charCodeAt(i);
            if (idx < lineArray.length) lines.push(lineArray[idx]);
        }
        let type: LineDiffType;
        if (op === DiffMatchPatch.DIFF_EQUAL) type = "equal";
        else if (op === DiffMatchPatch.DIFF_INSERT) type = "insert";
        else type = "delete";
        result.push({ type, lines });
    }
    return result;
}

/** Encode lines as single characters for efficient diff_main comparison. */
function linesToChars(
    oldLines: string[],
    newLines: string[],
): { chars1: string; chars2: string; lineArray: string[] } {
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

/** Append a numbered diff line to a container element. */
export function addDiffLine(
    container: HTMLElement,
    lineNum: number | null,
    text: string,
    cls: string,
): void {
    const row = container.createDiv({ cls: `diff-line ${cls}` });
    row.createSpan({ cls: "diff-line-num", text: lineNum != null ? String(lineNum) : "" });
    row.createSpan({ cls: "diff-line-text", text: text || "\u00A0" });
}

/** Render a side-by-side diff into left/right panel elements. */
export function buildSideBySide(
    oldText: string,
    newText: string,
    leftEl: HTMLElement,
    rightEl: HTMLElement,
): void {
    const oldLines = oldText.split("\n");
    const newLines = newText.split("\n");
    const lineDiffs = computeLineDiffs(oldLines, newLines);

    let leftLineNum = 1;
    let rightLineNum = 1;

    for (const chunk of lineDiffs) {
        if (chunk.type === "equal") {
            for (const line of chunk.lines) {
                addDiffLine(leftEl, leftLineNum++, line, "");
                addDiffLine(rightEl, rightLineNum++, line, "");
            }
        } else if (chunk.type === "delete") {
            for (const line of chunk.lines) {
                addDiffLine(leftEl, leftLineNum++, line, "diff-line-removed");
                addDiffLine(rightEl, null, "", "diff-line-placeholder");
            }
        } else if (chunk.type === "insert") {
            for (const line of chunk.lines) {
                addDiffLine(leftEl, null, "", "diff-line-placeholder");
                addDiffLine(rightEl, rightLineNum++, line, "diff-line-added");
            }
        }
    }
}
