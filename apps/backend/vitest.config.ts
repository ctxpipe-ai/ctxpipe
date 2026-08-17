import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: [
      "src/**/*.integration.test.ts",
      "src/routes/mcp.conformance.test.ts",
    ],
    setupFiles: ["src/test/setup-evlog.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/config/env.ts"],
    },
  },
})
