import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * E2E config — runs real CouchDB tests (tests/e2e/**). Requires a running
 * CouchDB instance; invoke `scripts/integ-start.sh` first.
 *
 * - Single-threaded because all tests share one CouchDB instance.
 * - 10 s testTimeout: real measurements are sub-second, so 10 s is already
 *   ~30× the observed worst case. A larger wall (the old 30 s) was hiding
 *   flakiness — pull retry loops that would eventually time out looked
 *   like "passing slow tests". Fail fast instead.
 * - Same `obsidian` alias as the unit config so imported code stays identical.
 */
export default defineConfig({
    resolve: {
        alias: {
            obsidian: fileURLToPath(new URL("./tests/helpers/obsidian-stub.ts", import.meta.url)),
        },
    },
    test: {
        include: ["tests/e2e/**/*.test.ts"],
        testTimeout: 10_000,
        // beforeEach may DELETE+PUT the shared CouchDB instance; keep the
        // hook window larger than the test window so infra setup still fits.
        hookTimeout: 15_000,
        // 1 CouchDB instance shared across tests — avoid parallel clashes.
        // vitest 4 removed `poolOptions`; serialise via fileParallelism +
        // a single worker so shared CouchDB DB names don't race.
        pool: "forks",
        fileParallelism: false,
        minWorkers: 1,
        maxWorkers: 1,
    },
});
