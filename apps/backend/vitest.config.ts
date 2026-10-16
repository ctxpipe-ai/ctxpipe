import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // A hang fails within minutes and names the test, not at the job timeout.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
    // Native admission contracts share the production OpenWorkflow namespace.
    // Keep file-owned workers from claiming another fixture's commands.
    fileParallelism: false,
    include: ["src/**/*.test.ts"],
    setupFiles: [
      "src/test/setup-evlog.ts",
      "src/test/setup-openworkflow-runs.ts",
    ],
    server: { deps: { inline: ["zod"] } },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/config/env.ts"],
    },
  },
})
