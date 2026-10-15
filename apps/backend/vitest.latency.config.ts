import { defineConfig } from "vitest/config"

// Wall-clock bounds are flaky on shared runners, so these files do not end in
// `.test.ts` and the PR suite never runs them. Run: pnpm --filter @ctxpipe/backend test:latency
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.latency.ts"],
    setupFiles: ["src/test/setup-evlog.ts"],
    server: { deps: { inline: ["zod"] } },
  },
})
