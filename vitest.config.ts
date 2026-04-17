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
        include: ["tests/**/*.test.ts"],
        testTimeout: 10000,
    },
});
