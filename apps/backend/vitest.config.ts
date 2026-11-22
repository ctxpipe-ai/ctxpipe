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
    // The msw interceptor parses each request with the Node header limit
    // (16 KiB). A ClickHouse statement of the knowledge store has up to 1000
    // keys in its URL (ClickHouse takes up to 1 MiB), so the tests that write
    // 1000 documents need the limit of ClickHouse.
    execArgv: ["--max-http-header-size=1048576"],
    include: ["src/**/*.test.ts"],
    globalSetup: [
      "src/test/global-setup-containers.ts",
      "src/test/global-setup-converter.ts",
    ],
    setupFiles: [
      "src/test/setup-git.ts",
      "src/test/setup-test-containers.ts",
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
