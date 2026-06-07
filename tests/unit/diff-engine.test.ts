/**
 * DiffEngine — surrogate-boundary normalization (incident 2026-06-04).
 *
 * diff-match-patch slices diffs at UTF-16 code unit boundaries, so editing
 * near an emoji can produce lone-surrogate segments from perfectly
 * well-formed inputs. `patch_toText` serializes segments with `encodeURI`,
 * which throws URIError on lone surrogates ("URI malformed" on V8 /
 * "String contained an illegal UTF-16 sequence." on JSC). The classic
 * trigger: two emoji sharing a high surrogate (🍅 D83C+DF45 → 🍆
 * D83C+DF46) — the shared D83C lands in an EQUAL, leaving DELETE "DF45" /
 * INSERT "DF46".
 *
 * computePatch must be a total function whose output round-trips through
 * applyPatch / applyPatchReverse.
 */
import { describe, it, expect } from "vitest";
import DiffMatchPatch from "diff-match-patch";
import { DiffEngine, normalizeSurrogateBoundaries } from "../../src/history/diff-engine.ts";

const engine = new DiffEngine();
const dmp = new DiffMatchPatch();

/** Assert computePatch(old,new) does not throw and round-trips both ways. */
function roundTrip(oldText: string, newText: string): string {
    const patch = engine.computePatch(oldText, newText);
    const fwd = engine.applyPatch(oldText, patch);
    expect(fwd.ok).toBe(true);
    expect(fwd.text).toBe(newText);
    const rev = engine.applyPatchReverse(newText, patch);
    expect(rev.ok).toBe(true);
    expect(rev.text).toBe(oldText);
    return patch;
}

describe("DiffEngine surrogate safety", () => {
    it("shared-high-surrogate emoji swap (🍅→🍆) does not throw and round-trips", () => {
        roundTrip("tomato 🍅 soup", "tomato 🍆 soup");
    });

    it("the same edit threw with the OLD pipeline (regression witness)", () => {
        // Documents that the raw dmp pipeline really produces the failure
        // this engine guards against — if dmp ever fixes it upstream, this
        // witness flags the normalization as potentially removable.
        const patches = dmp.patch_make("tomato 🍅 soup", "tomato 🍆 soup");
        expect(() => dmp.patch_toText(patches)).toThrow();
    });

    it("low-surrogate boundary (emoji prefix edit) round-trips", () => {
        // Editing text *before* emoji that share the low-surrogate side.
        roundTrip("a 😀 b", "a 😁 b"); // D83D DE00 → D83D DE01: shared high
        roundTrip("x😀", "y😀");
        roundTrip("😀x", "😀y");
    });

    it("emoji insertion/removal at text edges round-trips", () => {
        roundTrip("hello", "hello 🍅");
        roundTrip("🍅 hello", "hello");
        roundTrip("", "🍅");
        roundTrip("🍅", "");
    });

    it("property: random emoji-dense edits never throw and always round-trip", () => {
        const EMOJI = ["🍅", "🍆", "😀", "😁", "🙂", "🙃", "👍", "👎", "🇯🇵", "👨‍👩‍👧"];
        // Deterministic pseudo-random (no Math.random — reproducible).
        let seed = 0x2f6e2b1;
        const rnd = (n: number) => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed % n;
        };
        const randText = (len: number) => {
            let s = "";
            for (let i = 0; i < len; i++) {
                s += rnd(3) === 0 ? EMOJI[rnd(EMOJI.length)] : String.fromCharCode(97 + rnd(26));
            }
            return s;
        };
        for (let i = 0; i < 50; i++) {
            roundTrip(randText(5 + rnd(30)), randText(5 + rnd(30)));
        }
    });

    it("plain ASCII patches keep the legacy wire format (backward compat)", () => {
        // The normalized pipeline must produce byte-identical patch text for
        // diffs that never touch surrogates — existing stored patches and
        // new ones stay interchangeable.
        const oldText = "line one\nline two\nline three\n";
        const newText = "line one\nline 2\nline three\nline four\n";
        const legacy = dmp.patch_toText(dmp.patch_make(oldText, newText));
        expect(engine.computePatch(oldText, newText)).toBe(legacy);
    });

    it("reads legacy-format patch text produced by the old pipeline", () => {
        const oldText = "alpha beta gamma";
        const newText = "alpha BETA gamma";
        const legacy = dmp.patch_toText(dmp.patch_make(oldText, newText));
        const applied = engine.applyPatch(oldText, legacy);
        expect(applied.ok).toBe(true);
        expect(applied.text).toBe(newText);
    });
});

describe("normalizeSurrogateBoundaries", () => {
    const EQ = 0, DEL = -1, INS = 1;

    function text1(diffs: [number, string][]): string {
        return diffs.filter(d => d[0] !== INS).map(d => d[1]).join("");
    }
    function text2(diffs: [number, string][]): string {
        return diffs.filter(d => d[0] !== DEL).map(d => d[1]).join("");
    }
    function wellFormedSegments(diffs: [number, string][]): boolean {
        // Every segment must be a well-formed UTF-16 string on its own.
        return diffs.every(d => {
            for (let i = 0; i < d[1].length; i++) {
                const c = d[1].charCodeAt(i);
                if (c >= 0xd800 && c <= 0xdbff) {
                    const next = d[1].charCodeAt(i + 1);
                    if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
                    i++;
                } else if (c >= 0xdc00 && c <= 0xdfff) {
                    return false;
                }
            }
            return true;
        });
    }

    it("moves a trailing high surrogate from EQUAL into both DELETE and INSERT", () => {
        // The 🍅→🍆 shape: EQUAL ends with the shared high surrogate.
        const input: [number, string][] = [
            [EQ, "x \ud83c"], [DEL, "\udf45"], [INS, "\udf46"], [EQ, " y"],
        ];
        const out = normalizeSurrogateBoundaries(input);
        expect(text1(out)).toBe(text1(input));
        expect(text2(out)).toBe(text2(input));
        expect(wellFormedSegments(out)).toBe(true);
    });

    it("creates missing ops when only one side follows the EQUAL", () => {
        // "x 🍅 y" → "x 🍆🍅 y": pure insertion split mid-pair on both
        // edges. EQUAL ends with the shared high; only an INSERT follows
        // (no DELETE), so a DELETE "H" must be created for text1 to hold,
        // and the trailing low on the next EQUAL flows back symmetrically.
        const input: [number, string][] = [
            [EQ, "x \ud83c"], [INS, "\udf46\ud83c"], [EQ, "\udf45 y"],
        ];
        expect(text1(input)).toBe("x 🍅 y");   // sanity: both texts well-formed
        expect(text2(input)).toBe("x 🍆🍅 y");
        const out = normalizeSurrogateBoundaries(input);
        expect(text1(out)).toBe(text1(input));
        expect(text2(out)).toBe(text2(input));
        expect(wellFormedSegments(out)).toBe(true);
    });

    it("handles a leading low surrogate on EQUAL symmetrically", () => {
        const input: [number, string][] = [
            [EQ, "a "], [DEL, "😀x\ud83d"], [INS, "😁x\ud83d"], [EQ, "\ude00 b"],
        ];
        const out = normalizeSurrogateBoundaries(input);
        expect(text1(out)).toBe(text1(input));
        expect(text2(out)).toBe(text2(input));
        expect(wellFormedSegments(out)).toBe(true);
    });

    it("is a no-op for surrogate-free diffs", () => {
        const input: [number, string][] = [[EQ, "abc"], [DEL, "d"], [INS, "e"], [EQ, "f"]];
        expect(normalizeSurrogateBoundaries(input)).toEqual(input);
    });
});
