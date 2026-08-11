import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { classifyText } from "../../../src/memory/capture.js"

const enabled = process.env.CTXPIPE_MEMORY_LIVE_EVAL === "1"
const here = dirname(fileURLToPath(import.meta.url))

describe("memory live evals (Layer B)", () => {
  it("ships a Claude-grounded scenario that cannot self-satisfy from the prompt", () => {
    const scenario = readFileSync(
      join(here, "scenarios", "claude-promote-port.yaml"),
      "utf8",
    )
    expect(scenario).toContain("claude-promote-port")
    expect(scenario).toContain("expect:")
    expect(scenario).toMatch(/^\s*seed:/m)
    expect(scenario).toContain("candidatesFromAgentActivity: true")
    expect(scenario).toContain("apps/billing/README.md")

    const promptMatch = scenario.match(/^prompt:\s*\|\s*\n([\s\S]*?)^expect:/m)
    expect(promptMatch?.[1]).toBeTruthy()
    const prompt = promptMatch![1]!
      .split("\n")
      .map((line) => line.replace(/^ {2}/, ""))
      .join("\n")
      .trim()
    // Real classifier must not create candidates from the user prompt alone.
    expect(classifyText(prompt)).toEqual([])
    // Seed (not prompt) must ground the port fact.
    expect(scenario).toMatch(/listens on port 4000/)
  })

  it.skipIf(!enabled)(
    "golden path: sandbox agent produces candidates and durable Markdown",
    async () => {
      // Placeholder for TanStack AI Sandbox + claudeCodeText integration.
      // When wired: materialize scenario.seed, run agent with scenario.prompt,
      // assert expect.* against the sandbox filesystem (candidates from agent
      // activity, lessonsContains, noAdrAutoWrite).
      // Failing closed here prevents claiming live coverage without a green path.
      expect.fail(
        "CTXPIPE_MEMORY_LIVE_EVAL=1 is set but the sandbox runner is not wired yet. Implement TanStack AI Sandbox + claudeCodeText before enabling in nightly.",
      )
    },
  )
})
