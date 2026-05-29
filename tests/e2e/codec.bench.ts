/**
 * Codec benchmark — measures the real cost of each codec combination
 * (raw / gzip / encrypted / gzip+encrypted) against real CouchDB, for
 * compressible (text) and incompressible (random) payloads.
 *
 * NOT a pass/fail regression: it prints a table (and writes it to
 * `tests/e2e/codec-bench.result.txt`). The lone assertion just keeps vitest
 * happy. Excluded from the unit + e2e suites by its `.bench.ts` suffix.
 *
 * Run (CouchDB must be up — `npm run integ:start` or docker compose up):
 *   npm run bench
 *
 * Metrics per run (median of RUNS):
 *   - push ms  : SetupService.init (scan + push all chunks as attachments)
 *   - pull ms  : SetupService.clone (pull all + reassemble into the vault)
 *   - at-rest  : sum of chunk attachment bytes physically stored on the server
 *   - ratio    : at-rest / original (compression effectiveness; ~1.0 = none)
 *
 * Caveats: local CouchDB, per-3MiB file (~40 × 75KB chunks). Typical notes are
 * a single chunk, so per-file codec overhead is far smaller in practice.
 * PBKDF2 key derivation is a one-time unlock cost, not per-op (not measured).
 */
import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createE2EHarness } from "./couch-harness.ts";
import type { FileDoc } from "../../src/types.ts";

type Combo = { name: string; encryption: boolean; compression: boolean };
const COMBOS: Combo[] = [
    { name: "raw            ", encryption: false, compression: false },
    { name: "gzip           ", encryption: false, compression: true },
    { name: "encrypted      ", encryption: true, compression: false },
    { name: "gzip+encrypted ", encryption: true, compression: true },
];

const PASS = "bench-passphrase";
const SIZE = Number(process.env.BENCH_SIZE_MIB ?? 3) * 1024 * 1024;
const RUNS = Number(process.env.BENCH_RUNS ?? 2);

// Compressible but NON-repeating: each line carries an incrementing counter so
// no two 75KB chunks dedupe, yet the text stays highly gzip-compressible —
// isolates compression from content-addressed dedup.
function compressiblePayload(): ArrayBuffer {
    let s = "";
    let n = 0;
    while (s.length < SIZE) {
        s += `Line ${n}: the quick brown fox jumps over the lazy dog near the riverbank at dawn.\n`;
        n++;
    }
    return new TextEncoder().encode(s.slice(0, SIZE)).buffer;
}

// Incompressible: cryptographic random bytes (gzip can only add overhead).
function randomPayload(): ArrayBuffer {
    const buf = new Uint8Array(SIZE);
    for (let off = 0; off < SIZE; off += 65536) {
        crypto.getRandomValues(buf.subarray(off, Math.min(off + 65536, SIZE)));
    }
    return buf.buffer;
}

const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function atRestBytes(
    h: Awaited<ReturnType<typeof createE2EHarness>>,
    dev: { db: { allFileDocs(): Promise<FileDoc[]> } },
): Promise<number> {
    const files = await dev.db.allFileDocs();
    const chunkIds = [...new Set(files.flatMap((f) => f.chunks))];
    let total = 0;
    for (const id of chunkIds) {
        const blob = await h.adminClient.getAttachment(id, "c");
        if (blob) total += blob.byteLength;
    }
    return total;
}

describe("BENCH: codec cost (real CouchDB)", () => {
    it("push/pull time + at-rest size across codec combos", async () => {
        const payloads: Array<{ kind: string; make: () => ArrayBuffer }> = [
            { kind: "compressible", make: compressiblePayload },
            { kind: "random      ", make: randomPayload },
        ];

        const mib = (SIZE / 1024 / 1024).toFixed(0);
        const rows: string[] = [];
        rows.push(`payload(${mib}MiB, median of ${RUNS}) | codec           | push ms | pull ms | at-rest MiB | ratio`);
        rows.push(`-------------|-----------------|---------|---------|-------------|------`);

        for (const p of payloads) {
            const buf = p.make();
            for (const combo of COMBOS) {
                const pushes: number[] = [];
                const pulls: number[] = [];
                let rest = 0;
                for (let r = 0; r < RUNS; r++) {
                    const h = await createE2EHarness({ uniqueDb: true });
                    try {
                        const a = h.addDevice("A");
                        a.vault.addBinaryFile("payload.bin", buf.slice(0));

                        const t0 = performance.now();
                        await a.runInit({
                            encryption: combo.encryption,
                            passphrase: combo.encryption ? PASS : undefined,
                            compression: combo.compression,
                        });
                        pushes.push(performance.now() - t0);

                        rest = await atRestBytes(h, a);

                        const b = h.addDevice("B");
                        const t1 = performance.now();
                        await b.runClone(combo.encryption ? { passphrase: PASS } : {});
                        pulls.push(performance.now() - t1);

                        expect(await b.vault.exists("payload.bin")).toBe(true);
                    } finally {
                        await h.destroyAll();
                    }
                }
                rows.push(
                    `${p.kind} | ${combo.name} | ${median(pushes).toFixed(0).padStart(7)} | ` +
                    `${median(pulls).toFixed(0).padStart(7)} | ${(rest / 1024 / 1024).toFixed(2).padStart(11)} | ` +
                    `${(rest / SIZE).toFixed(3)}`,
                );
            }
        }

        const table = "=== CODEC BENCHMARK ===\n" + rows.join("\n") + "\n";
        // eslint-disable-next-line no-console
        console.log("\n" + table);
        try {
            const out = process.env.BENCH_OUT
                ?? fileURLToPath(new URL("./codec-bench.result.txt", import.meta.url));
            writeFileSync(out, table);
        } catch { /* best-effort */ }
        expect(rows.length).toBeGreaterThan(2);
    });
});
