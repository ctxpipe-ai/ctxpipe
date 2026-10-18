import { defineConfig } from "vitest/config"

// The upgrade from main needs a checkout of main with its dependencies
// (MAIN_TREE) and its own database server, so these files do not end in
// `.test.ts` and the PR suite does not run them. CI runs them in the
// `upgrade-from-main` job: pnpm --filter @ctxpipe/backend test:upgrade-from-main
export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 600_000,
    hookTimeout: 600_000,
    teardownTimeout: 60_000,
    fileParallelism: false,
    include: ["src/**/*.upgrade.ts"],
    setupFiles: [
      "src/test/setup-evlog.ts",
      "src/test/setup-openworkflow-runs.ts",
    ],
    server: { deps: { inline: ["zod"] } },
  },
})
