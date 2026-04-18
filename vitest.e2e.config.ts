import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * E2E config — runs real CouchDB tests (tests/e2e/**). Requires a running
 * CouchDB instance; invoke `scripts/integ-start.sh` first.
 *
 * - Single-threaded because all tests share one CouchDB instance.
 * - 30s timeout because Docker-backed HTTP + catchup loops are slower.
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
        testTimeout: 30000,
        // 1 CouchDB instance shared across tests — avoid parallel clashes.
        pool: "forks",
        poolOptions: {
            forks: { singleFork: true },
        },
    },
});
