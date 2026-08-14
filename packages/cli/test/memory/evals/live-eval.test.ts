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

  // Runner not wired yet — always skip. Do not fail when CTXPIPE_MEMORY_LIVE_EVAL=1;
  // that would imply a live path exists. See README.md.
  it.skipIf(true || !enabled)(
    "golden path: sandbox agent produces candidates and durable Markdown (pending TanStack runner)",
    async () => {
      // When wired: materialize scenario.seed, run TanStack AI Sandbox + claudeCodeText,
      // assert expect.* against the sandbox filesystem.
    },
  )
})
