import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Benchmark config — measurement runs, NOT pass/fail regression. Lives apart
 * from `vitest.config.ts` (unit) and `vitest.e2e.config.ts` (e2e) so a slow
 * benchmark never bloats CI. Requires a running CouchDB (see docker-compose /
 * `npm run integ:start`).
 *
 * Files: `tests/e2e/**​/*.bench.ts` — the `.bench.ts` suffix keeps them out of
 * both the unit suite (`tests/**​/*.test.ts`, tests/e2e excluded) and the e2e
 * suite (`tests/e2e/**​/*.test.ts`). Run with `npm run bench`.
 */
export default defineConfig({
    resolve: {
        alias: {
            obsidian: fileURLToPath(new URL("./tests/helpers/obsidian-stub.ts", import.meta.url)),
        },
    },
    test: {
        include: ["tests/e2e/**/*.bench.ts"],
        // Benchmarks push/pull multi-MiB payloads through real CouchDB.
        testTimeout: 180_000,
        hookTimeout: 30_000,
        // One shared CouchDB instance — serialise like the e2e suite.
        pool: "forks",
        fileParallelism: false,
        minWorkers: 1,
        maxWorkers: 1,
    },
});
