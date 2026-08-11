import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const enabled = process.env.CTXPIPE_MEMORY_LIVE_EVAL === "1"
const here = dirname(fileURLToPath(import.meta.url))

describe("memory live evals (Layer B)", () => {
  it("documents opt-in gate and ships a scenario YAML", () => {
    const scenario = readFileSync(
      join(here, "scenarios", "claude-promote-port.yaml"),
      "utf8",
    )
    expect(scenario).toContain("claude-promote-port")
    expect(scenario).toContain("expect:")
  })

  it.skipIf(!enabled)(
    "golden path: sandbox agent produces candidates and durable Markdown",
    async () => {
      // Placeholder for TanStack AI Sandbox + claudeCodeText integration.
      // When wired, this must assert filesystem outcomes from scenarios/*.yaml.
      // Failing closed here prevents claiming live coverage without a green path.
      expect.fail(
        "CTXPIPE_MEMORY_LIVE_EVAL=1 is set but the sandbox runner is not wired yet. Implement TanStack AI Sandbox + claudeCodeText before enabling in nightly.",
      )
    },
  )
})
