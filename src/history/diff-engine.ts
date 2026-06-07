import DiffMatchPatch from "diff-match-patch";
import { computeHash } from "../db/chunker.ts";
import { logWarn } from "../ui/log.ts";

const dmp = new DiffMatchPatch();

interface PatchObj {
    diffs: [number, string][];
    start1: number;
    start2: number;
    length1: number;
    length2: number;
}

type Diff = [number, string];

const DIFF_DELETE = DiffMatchPatch.DIFF_DELETE;
const DIFF_INSERT = DiffMatchPatch.DIFF_INSERT;
const DIFF_EQUAL = DiffMatchPatch.DIFF_EQUAL;

function isHighSurrogate(code: number): boolean {
    return code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code: number): boolean {
    return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Snap diff segment boundaries to code point boundaries.
 *
 * diff-match-patch operates on UTF-16 code units, so a diff boundary can
 * split a surrogate pair even when both input texts are well-formed (e.g.
 * 🍅 U+1F345 = D83C+DF45 → 🍆 U+1F346 = D83C+DF46 shares the high
 * surrogate, producing EQUAL …D83C | DELETE DF45 | INSERT DF46). The lone
 * surrogates then blow up `patch_toText`, whose serializer calls
 * `encodeURI` (URIError "URI malformed" on V8, "String contained an
 * illegal UTF-16 sequence." on JSC) — the 2026-06-04 history-loss
 * incident (upstream: google/diff-match-patch#69).
 *
 * Every split happens at an EQUAL↔non-EQUAL boundary (consecutive same-op
 * segments don't exist in dmp's canonical form, and DELETE|INSERT is not a
 * text boundary — they belong to different texts). So it suffices to fix
 * EQUAL edges:
 *
 *  - EQUAL ending in a high surrogate H: remove H from the EQUAL and
 *    prepend it to BOTH the following DELETE and INSERT (creating the
 *    missing op if absent). text1 = …EQUAL+DELETE… and
 *    text2 = …EQUAL+INSERT… each keep their concatenation unchanged.
 *  - EQUAL starting with a low surrogate L: symmetric — append L to both
 *    the preceding DELETE and INSERT.
 *
 * The transformation is equivalence-preserving (both reconstructed texts
 * are byte-identical), so patch coordinates derived from diff lengths stay
 * consistent and applyPatch / applyPatchReverse need no changes.
 */
export function normalizeSurrogateBoundaries(input: Diff[]): Diff[] {
    const out: Diff[] = input.map((d) => [d[0], d[1]]);

    // Pass 1 — EQUAL ending in a high surrogate.
    for (let i = 0; i < out.length; i++) {
        if (out[i][0] !== DIFF_EQUAL) continue;
        const text = out[i][1];
        if (text.length === 0 || !isHighSurrogate(text.charCodeAt(text.length - 1))) continue;
        const h = text[text.length - 1];
        out[i][1] = text.slice(0, -1);
        let j = i + 1;
        let sawDel = false;
        let sawIns = false;
        while (j < out.length && out[j][0] !== DIFF_EQUAL) {
            if (out[j][0] === DIFF_DELETE && !sawDel) {
                out[j][1] = h + out[j][1];
                sawDel = true;
            } else if (out[j][0] === DIFF_INSERT && !sawIns) {
                out[j][1] = h + out[j][1];
                sawIns = true;
            }
            j++;
        }
        // dmp canonical order within a group is DELETE before INSERT.
        if (!sawIns) out.splice(j, 0, [DIFF_INSERT, h]);
        if (!sawDel) out.splice(i + 1, 0, [DIFF_DELETE, h]);
    }

    // Pass 2 — EQUAL starting with a low surrogate.
    for (let i = 0; i < out.length; i++) {
        if (out[i][0] !== DIFF_EQUAL) continue;
        const text = out[i][1];
        if (text.length === 0 || !isLowSurrogate(text.charCodeAt(0))) continue;
        const l = text[0];
        out[i][1] = text.slice(1);
        let j = i - 1;
        let sawDel = false;
        let sawIns = false;
        while (j >= 0 && out[j][0] !== DIFF_EQUAL) {
            if (out[j][0] === DIFF_DELETE && !sawDel) {
                out[j][1] = out[j][1] + l;
                sawDel = true;
            } else if (out[j][0] === DIFF_INSERT && !sawIns) {
                out[j][1] = out[j][1] + l;
                sawIns = true;
            }
            j--;
        }
        // Insert missing ops right before this EQUAL, DELETE before INSERT.
        if (!sawDel) {
            out.splice(i, 0, [DIFF_DELETE, l]);
            i++; // keep i pointing at the EQUAL
        }
        if (!sawIns) {
            out.splice(i, 0, [DIFF_INSERT, l]);
            i++;
        }
    }

    // Hygiene: drop emptied EQUALs and merge adjacent same-op segments
    // (dmp canonical form).
    const merged: Diff[] = [];
    for (const d of out) {
        if (d[1].length === 0) continue;
        const prev = merged[merged.length - 1];
        if (prev && prev[0] === d[0]) prev[1] += d[1];
        else merged.push(d);
    }
    return merged;
}

export { computeHash };

export class DiffEngine {
    /**
     * Total function: always returns a serializable patch. The surrogate
     * normalization makes the encodeURI throw unreachable in theory; the
     * full-replacement fallback keeps the history chain alive even if a
     * future dmp edge case slips through (a coarse diff beats a lost one).
     */
    computePatch(oldText: string, newText: string): string {
        try {
            // Reproduce patch_make(text1, text2)'s internal pipeline
            // (diff_main + cleanups), but normalize surrogate boundaries
            // BEFORE serialization. Cleanups move boundaries, so they must
            // run first. patch_make(text1, diffs) does not re-run cleanups.
            const diffs = dmp.diff_main(oldText, newText, true) as Diff[];
            if (diffs.length > 2) {
                dmp.diff_cleanupSemantic(diffs);
                dmp.diff_cleanupEfficiency(diffs);
            }
            const normalized = normalizeSurrogateBoundaries(diffs);
            const patches = dmp.patch_make(oldText, normalized as any);
            return dmp.patch_toText(patches);
        } catch (e: any) {
            // Last-resort fallback: a full-replacement patch. Whole texts
            // are well-formed, so this cannot re-throw on surrogates.
            logWarn(
                `DiffEngine.computePatch: diff serialization failed (${e?.message ?? e}) — ` +
                `falling back to full-replacement patch`,
            );
            const fallback: Diff[] = [];
            if (oldText.length > 0) fallback.push([DIFF_DELETE, oldText]);
            if (newText.length > 0) fallback.push([DIFF_INSERT, newText]);
            if (fallback.length === 0) return "";
            const patches = dmp.patch_make(oldText, fallback as any);
            return dmp.patch_toText(patches);
        }
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
        // Count lines in the char-encoded representation (each char = 1 line).
        // This is exact regardless of trailing-newline presence, unlike counting
        // "\n" occurrences in the restored text which under-counts edits to
        // a file's last line when it has no trailing newline.
        const { chars1, chars2 } = dmp.diff_linesToChars_(oldText, newText);
        const diffs = dmp.diff_main(chars1, chars2, false);
        let added = 0;
        let removed = 0;
        for (const [op, text] of diffs) {
            if (op === DiffMatchPatch.DIFF_INSERT) added += text.length;
            else if (op === DiffMatchPatch.DIFF_DELETE) removed += text.length;
        }
        return { added, removed };
    }
}
