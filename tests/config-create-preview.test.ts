/**
 * Create confirm dialog text (`describeCreateConfirm`): states what is on
 * the server — or that it could not be read, never a guessed count — the
 * codec Create builds (emphasised when weaker than the current root), and
 * that every other device must Join again.
 */
import { describe, it, expect } from "vitest";
import {
    describeCreateConfirm,
    weakerCodecReason,
    type CreateCodec,
} from "../src/sync/config-create-preview.ts";

const ENC3: CreateCodec = { encryption: true, compression: false, cipherVersion: 3 };
const PLAIN: CreateCodec = { encryption: false, compression: true };
const K = { bindingKey: "http://h|cfg" };

describe("describeCreateConfirm", () => {
    it("names the doc count, the meta and its codec", () => {
        const text = describeCreateConfirm("cfg", {
            kind: "read", docCount: 1234, meta: "present", codec: ENC3, ...K,
        }, ENC3);
        expect(text).toMatch(
            /1,234 document\(s\), config:meta present \(encryption on \(cipherVersion 3\), compression off\)/,
        );
        expect(text).toMatch(/All of them will be deleted/);
        expect(text).toMatch(/cannot be undone/);
    });

    it("names the codec Create builds with", () => {
        expect(describeCreateConfirm("cfg", { kind: "missing", ...K }, ENC3))
            .toMatch(/new root \(config:meta\): encryption on \(cipherVersion 3\), compression off/);
        expect(describeCreateConfirm("cfg", { kind: "missing", ...K }, PLAIN))
            .toMatch(/new root \(config:meta\): encryption off, compression on/);
    });

    it("emphasises a Create that removes encryption, as its first paragraph", () => {
        const text = describeCreateConfirm("cfg", {
            kind: "read", docCount: 5, meta: "present", codec: ENC3, ...K,
        }, PLAIN);
        const first = text.split("\n\n")[0];
        expect(first).toMatch(/^⚠ Weaker than now:/);
        expect(first).toMatch(/UNENCRYPTED/);
    });

    it("no warning when the new root is as strong", () => {
        for (const [cur, next] of [[ENC3, ENC3], [PLAIN, ENC3], [PLAIN, PLAIN]] as const) {
            const text = describeCreateConfirm("cfg", {
                kind: "read", docCount: 1, meta: "present", codec: cur, ...K,
            }, next);
            expect(text).not.toMatch(/⚠/);
        }
    });

    it("a DB without config:meta says so", () => {
        const text = describeCreateConfirm("cfg", { kind: "read", docCount: 3, meta: "absent", ...K }, ENC3);
        expect(text).toMatch(/3 document\(s\), no config:meta/);
    });

    it("an unreadable server is reported, with no count", () => {
        const text = describeCreateConfirm("cfg", { kind: "unreadable", message: "timeout", ...K }, ENC3);
        expect(text).toMatch(/could not be read \(timeout\)/);
        expect(text).not.toMatch(/document\(s\)/);
        expect(text).not.toMatch(/\d+ document/);
    });

    it("always says every other device must Join again, and separates paragraphs", () => {
        for (const p of [
            { kind: "missing", ...K } as const,
            { kind: "read", docCount: 0, meta: "absent", ...K } as const,
            { kind: "unreadable", message: "x", ...K } as const,
        ]) {
            const text = describeCreateConfirm("cfg", p, ENC3);
            expect(text).toMatch(/Every other device that uses "cfg" must Join again/);
            expect(text.split("\n\n")).toHaveLength(4);
        }
    });
});

describe("weakerCodecReason", () => {
    it("encryption removed, or an older cipher, is weaker; compression never counts", () => {
        expect(weakerCodecReason(ENC3, PLAIN)).toMatch(/UNENCRYPTED/);
        expect(weakerCodecReason(ENC3, { ...ENC3, cipherVersion: 2 })).toMatch(/older cipherVersion 2/);
        expect(weakerCodecReason(ENC3, { ...ENC3, compression: true })).toBeNull();
        expect(weakerCodecReason({ ...ENC3, compression: true }, ENC3)).toBeNull();
        expect(weakerCodecReason(PLAIN, ENC3)).toBeNull();
    });
});
