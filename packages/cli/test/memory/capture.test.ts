import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  acknowledgeSurfaced,
  classifyText,
  formatStopHookOutput,
  markDismissed,
  markPromoted,
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

  it(
    "summary lists pending candidates and marks only surfaced ones after ack",
    { timeout: 15_000 },
    () => {
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
    expect(first.candidates[0]?.candidateId).toBeTruthy()
    expect(first.surfacedIds.length).toBe(first.candidates.length)
    expect(first.priority).not.toBe("low")
    // Before ack, candidates remain pending (delivery may have failed).
    expect(summarizeCapture({ cwd }).candidates.length).toBeGreaterThan(0)
    acknowledgeSurfaced(first.surfacedIds, { cwd })
    const second = summarizeCapture({ cwd })
    expect(second.candidates).toEqual([])
    expect(second.priority).toBe("low")
    expect(
      existsSync(join(cwd, ".ai", "memory", "events", "lifecycle.json")),
    ).toBe(true)
  })

  it(
    "second summary still surfaces candidates beyond the first batch of 8",
    { timeout: 15_000 },
    () => {
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
      acknowledgeSurfaced(first.surfacedIds, { cwd })
      const second = summarizeCapture({ cwd })
      expect(second.candidates.length).toBeGreaterThan(0)
      expect(second.candidates.length).toBeLessThanOrEqual(8)
      acknowledgeSurfaced(second.surfacedIds, { cwd })
      const third = summarizeCapture({ cwd })
      expect(third.candidates).toEqual([])
    },
  )

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
    acknowledgeSurfaced(summary.surfacedIds, { cwd })
    expect(existsSync(join(eventsDir, "lifecycle.json"))).toBe(true)
  })

  it("promoted and dismissed candidates leave the pending summary set", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-capture-resolve-"))
    observeCapture({
      host: "cursor",
      eventType: "beforeSubmitPrompt",
      cwd,
      payload: {
        prompt: "We decided that promote and dismiss are terminal lifecycle states",
        sessionId: "resolve-1",
      },
    })
    const summary = summarizeCapture({ cwd })
    const id = summary.surfacedIds[0]!
    acknowledgeSurfaced([id], { cwd })
    markPromoted([id], { cwd })
    expect(summarizeCapture({ cwd }).candidates).toEqual([])

    observeCapture({
      host: "cursor",
      eventType: "beforeSubmitPrompt",
      cwd,
      payload: {
        prompt: "We decided that dismiss uniquely-xyz should drop a candidate",
        sessionId: "resolve-2",
      },
    })
    const again = summarizeCapture({ cwd })
    const dismissId = again.surfacedIds[0]!
    acknowledgeSurfaced([dismissId], { cwd })
    markDismissed([dismissId], { cwd })
    expect(summarizeCapture({ cwd }).candidates).toEqual([])
  })

  it("captures Cursor afterFileEdit payloads with durable facts in edits", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-capture-edit-"))
    const result = observeCapture({
      host: "cursor",
      eventType: "afterFileEdit",
      cwd,
      payload: {
        file_path: `${cwd}/apps/backend/src/server.ts`,
        edits: [
          {
            old_string: "listen(3000)",
            new_string:
              "// billing service runs on port 4000\nlisten(4000)",
          },
        ],
        cwd,
      },
    })
    expect(result.wrote).toBe(true)
    expect(result.candidateCount).toBeGreaterThan(0)
  })

  it("captures Claude Stop with last_assistant_message facts", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-capture-claude-"))
    const result = observeCapture({
      host: "claude",
      eventType: "Stop",
      cwd,
      payload: {
        last_assistant_message:
          "Prefer ADRs in .ai/memory/decisions/ as the canonical source of truth.",
        cwd,
      },
    })
    expect(result.wrote).toBe(true)
    const line = readFileSync(
      join(cwd, ".ai", "memory", "events", "candidates.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")[0]!
    const candidate = JSON.parse(line) as { excerpt: string }
    expect(candidate.excerpt).toContain(".ai/memory/decisions/")
  })

  it("does not capture pure deletion edits as facts", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-capture-del-"))
    const result = observeCapture({
      host: "cursor",
      eventType: "afterFileEdit",
      cwd,
      payload: {
        file_path: `${cwd}/apps/backend/src/server.ts`,
        edits: [
          {
            old_string: "billing service runs on port 4000",
            new_string: "",
          },
        ],
        cwd,
      },
    })
    expect(result.wrote).toBe(false)
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

  it("formats Cursor Stop output with followup_message", () => {
    const out = formatStopHookOutput(
      "cursor",
      {
        priority: "medium",
        message: "Promote candidate abc",
        candidates: [],
        surfacedIds: ["abc"],
        parseErrors: 0,
      },
      {},
    )
    expect(out.followup_message).toContain("Promote candidate abc")
  })

  it("formats Claude Stop output with hookSpecificOutput.additionalContext", () => {
    const out = formatStopHookOutput(
      "claude",
      {
        priority: "medium",
        message: "Promote candidate abc",
        candidates: [],
        surfacedIds: ["abc"],
        parseErrors: 0,
      },
      {},
    )
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: "Promote candidate abc",
      },
    })
  })

  it("suppresses Claude Stop follow-up when stop_hook_active", () => {
    const out = formatStopHookOutput(
      "claude",
      {
        priority: "high",
        message: "Promote candidate abc",
        candidates: [],
        surfacedIds: ["abc"],
        parseErrors: 0,
      },
      { stop_hook_active: true },
    )
    expect(out).toEqual({})
  })

  it("formats Codex Stop output with decision block + reason", () => {
    const out = formatStopHookOutput(
      "codex",
      {
        priority: "medium",
        message: "Promote candidate abc",
        candidates: [],
        surfacedIds: ["abc"],
        parseErrors: 0,
      },
      {},
    )
    expect(out).toEqual({
      decision: "block",
      reason: "Promote candidate abc",
    })
  })
})
