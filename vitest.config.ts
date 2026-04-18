import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
    resolve: {
        alias: {
            // The real `obsidian` npm package ships only .d.ts files. Tests
            // that transitively import UI code (Notice, etc.) get a minimal
            // runtime stub instead.
            obsidian: fileURLToPath(new URL("./tests/helpers/obsidian-stub.ts", import.meta.url)),
        },
    },
    test: {
        // E2E tests (real CouchDB) live under tests/e2e and require the
        // docker-compose stack — run them via `vitest.e2e.config.ts`.
        include: ["tests/**/*.test.ts"],
        exclude: ["tests/e2e/**", "node_modules/**"],
        testTimeout: 10000,
    },
});
