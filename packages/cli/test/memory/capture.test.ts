import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  classifyText,
  observeCapture,
  redactText,
  summarizeCapture,
} from "../../src/memory/capture.js"

describe("memory/capture", () => {
  it("redacts common secrets", () => {
    const { text, redacted } = redactText(
      'api_key=sk-ant-secret123 and Bearer abc.def.ghi',
    )
    expect(redacted).toBe(true)
    expect(text).not.toContain("sk-ant-secret123")
    expect(text).toContain("[REDACTED_SECRET]")
  })

  it("classifies lesson-shaped prompts", () => {
    const hits = classifyText("From now on always use Zod schemas collocated with routes")
    expect(hits.some((h) => h.kind === "lesson")).toBe(true)
  })

  it("writes candidates for decision-shaped observe events", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-capture-"))
    const result = observeCapture({
      host: "cursor",
      eventType: "beforeSubmitPrompt",
      cwd,
      payload: {
        prompt: "We decided to use Markdown-only memory without a search daemon",
        sessionId: "s1",
      },
    })
    expect(result.wrote).toBe(true)
    expect(result.candidateCount).toBeGreaterThan(0)
    const candidates = join(cwd, ".ai", "memory", "events", "candidates.jsonl")
    expect(existsSync(candidates)).toBe(true)
    const line = readFileSync(candidates, "utf8").trim().split("\n")[0]
    expect(line).toBeTruthy()
    const parsed = JSON.parse(line!) as { kind: string; destination: string }
    expect(parsed.kind).toBe("decision")
    expect(parsed.destination).toContain("decisions")
  })

  it("summary lists pending candidates and marks only surfaced ones", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-capture-sum-"))
    observeCapture({
      host: "claude",
      eventType: "UserPromptSubmit",
      cwd,
      payload: {
        prompt: "Never commit secrets into .ai/memory",
        sessionId: "s2",
      },
    })
    const first = summarizeCapture({ cwd })
    expect(first.candidates.length).toBeGreaterThan(0)
    expect(first.priority).not.toBe("low")
    const second = summarizeCapture({ cwd })
    expect(second.candidates).toEqual([])
    expect(second.priority).toBe("low")
    expect(
      existsSync(join(cwd, ".ai", "memory", "events", "lifecycle.json")),
    ).toBe(true)
  })

  it("second summary still surfaces candidates beyond the first batch of 8", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-capture-batch-"))
    for (let i = 0; i < 10; i++) {
      observeCapture({
        host: "cursor",
        eventType: "beforeSubmitPrompt",
        cwd,
        payload: {
          prompt: `We decided uniquely-${i} that option ${i} is approved for the roadmap`,
          sessionId: `batch-${i}`,
        },
      })
    }
    const first = summarizeCapture({ cwd })
    expect(first.candidates.length).toBe(8)
    expect(first.message).toMatch(/more pending/i)
    const second = summarizeCapture({ cwd })
    expect(second.candidates.length).toBeGreaterThan(0)
    expect(second.candidates.length).toBeLessThanOrEqual(8)
    const third = summarizeCapture({ cwd })
    expect(third.candidates).toEqual([])
  })

  it("ignores legacy summarized.json wipe so unsurfaced candidates remain pending", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-capture-legacy-"))
    observeCapture({
      host: "cursor",
      eventType: "beforeSubmitPrompt",
      cwd,
      payload: {
        prompt: "We decided that legacy wipe must not hide pending candidates",
        sessionId: "legacy-1",
      },
    })
    const candidatesPath = join(cwd, ".ai", "memory", "events", "candidates.jsonl")
    const candidateId = (
      JSON.parse(readFileSync(candidatesPath, "utf8").trim().split("\n")[0]!) as {
        candidateId: string
      }
    ).candidateId
    const eventsDir = join(cwd, ".ai", "memory", "events")
    mkdirSync(eventsDir, { recursive: true })
    writeFileSync(
      join(eventsDir, "summarized.json"),
      JSON.stringify({ ids: [candidateId] }, null, 2),
      "utf8",
    )
    const summary = summarizeCapture({ cwd })
    expect(summary.candidates.length).toBeGreaterThan(0)
    expect(summary.priority).not.toBe("low")
    expect(existsSync(join(eventsDir, "lifecycle.json"))).toBe(true)
  })

  it("skips self-capture loops", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-capture-self-"))
    const result = observeCapture({
      host: "cursor",
      eventType: "postToolUse",
      cwd,
      payload: {
        toolName: "Shell",
        toolInput: "npx ctxpipe memory capture observe --host cursor",
      },
    })
    expect(result.wrote).toBe(false)
  })
})
