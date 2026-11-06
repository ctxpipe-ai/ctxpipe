import { afterEach, describe, expect, test, vi } from "vitest"

import { buildPrompt, review, type Prompt, type StoryInput } from "./index.ts"

const story: StoryInput = {
  storyId: "repository-status--failed",
  scope: "component",
  viewport: { width: 1440, height: 900 },
  regions: [
    {
      box: { x: 0.05, y: 0.1, width: 0.2, height: 0.04 },
      changeType: "deletion",
      position: "top-left",
      confidence: 1,
    },
  ],
  images: [{ role: "regions", path: "regions.png" }],
}

const regression = {
  observations: [
    {
      region: 1,
      before: "A red dot and the word Failed.",
      after: "A red dot with no word.",
    },
  ],
  verdict: "regression",
  severity: "major",
  confidence: 0.85,
  summary: "The status lost its word, so it is color-only.",
  qualities: [{ name: "accessibility", delta: "worse", confidence: 0.8 }],
  findings: [
    {
      kind: "missing-elements",
      region: { x: 0.05, y: 0.1, width: 0.2, height: 0.04 },
      evidence: "The word Failed is gone; only the dot stays.",
      rubricRef: "apps/ui/DESIGN.md › Targets (new or touched UI)",
      explainedByBrief: false,
      suggestion: "Put the status word back next to the dot.",
    },
  ],
}

afterEach(() => {
  vi.useRealTimers()
})

describe("review", () => {
  test("sends the story prompt to the judge and returns its verdict with the judge's run facts", async () => {
    vi.useFakeTimers()
    const prompts: Prompt[] = []

    const verdict = await review(story, async (prompt) => {
      prompts.push(prompt)
      vi.advanceTimersByTime(1250)
      return {
        text: JSON.stringify(regression),
        model: "anthropic/claude-sonnet-5.5",
        costUsd: 0.006,
      }
    })

    expect(prompts).toEqual([buildPrompt(story)])
    expect(verdict).toEqual({
      storyId: "repository-status--failed",
      ...regression,
      model: "anthropic/claude-sonnet-5.5",
      costUsd: 0.006,
      latencyMs: 1250,
    })
  })

  test("a reply that is not JSON gives unsure, and the judge's facts stay", async () => {
    const verdict = await review(story, async () => ({
      text: "I cannot see the images.",
      model: "agent",
      costUsd: null,
    }))

    expect(verdict).toMatchObject({
      verdict: "unsure",
      model: "agent",
      costUsd: null,
    })
    expect(verdict.error).toMatch(/not JSON/)
  })

  test("an error of the judge is not a verdict: it goes to the caller", async () => {
    await expect(
      review(story, async () => {
        throw new Error("401 from the model provider")
      }),
    ).rejects.toThrow("401 from the model provider")
  })
})
