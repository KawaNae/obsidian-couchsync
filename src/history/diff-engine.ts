import DiffMatchPatch from "diff-match-patch";
import { computeHash } from "../db/chunker.ts";

const dmp = new DiffMatchPatch();

interface PatchObj {
    diffs: [number, string][];
    start1: number;
    start2: number;
    length1: number;
    length2: number;
}

export { computeHash };

export class DiffEngine {
    computePatch(oldText: string, newText: string): string {
        const patches = dmp.patch_make(oldText, newText);
        return dmp.patch_toText(patches);
    }

    applyPatch(text: string, patchStr: string): { text: string; ok: boolean } {
        const patches = dmp.patch_fromText(patchStr);
        const [result, applied] = dmp.patch_apply(patches, text);
        return { text: result, ok: applied.every(Boolean) };
    }

    applyPatchReverse(text: string, patchStr: string): { text: string; ok: boolean } {
        const patches = dmp.patch_fromText(patchStr) as unknown as PatchObj[];
        for (const patch of patches) {
            for (const diff of patch.diffs) {
                if (diff[0] === DiffMatchPatch.DIFF_INSERT) {
                    diff[0] = DiffMatchPatch.DIFF_DELETE;
                } else if (diff[0] === DiffMatchPatch.DIFF_DELETE) {
                    diff[0] = DiffMatchPatch.DIFF_INSERT;
                }
            }
            const tmp = patch.length1;
            patch.length1 = patch.length2;
            patch.length2 = tmp;
            const tmpStart = patch.start1;
            patch.start1 = patch.start2;
            patch.start2 = tmpStart;
        }
        const [result, applied] = dmp.patch_apply(patches as any, text);
        return { text: result, ok: applied.every(Boolean) };
    }

    computeLineDiff(oldText: string, newText: string): { added: number; removed: number } {
        const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(oldText, newText);
        const diffs = dmp.diff_main(chars1, chars2, false);
        dmp.diff_charsToLines_(diffs, lineArray);
        dmp.diff_cleanupSemantic(diffs);
        let added = 0;
        let removed = 0;
        for (const [op, text] of diffs) {
            const lines = (text.match(/\n/g) || []).length;
            if (op === DiffMatchPatch.DIFF_INSERT) added += lines;
            else if (op === DiffMatchPatch.DIFF_DELETE) removed += lines;
        }
        return { added, removed };
    }
}
