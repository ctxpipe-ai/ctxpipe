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

  it("redacts connection strings", () => {
    const { text, redacted } = redactText(
      "DATABASE_URL=postgres://user:hunter2@db.example:5432/app",
    )
    expect(redacted).toBe(true)
    expect(text).not.toContain("hunter2")
    expect(text).toContain("[REDACTED_CONNECTION_STRING]")
  })

  it("does not capture edit text from denied secret paths", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-capture-env-"))
    const result = observeCapture({
      host: "cursor",
      eventType: "afterFileEdit",
      cwd,
      payload: {
        file_path: "apps/billing/.env",
        edits: [
          {
            old_string: "",
            new_string:
              "We decided DATABASE_URL=postgres://user:hunter2@localhost/db",
          },
        ],
      },
    })
    expect(result.wrote).toBe(false)
    expect(
      existsSync(join(cwd, ".ai", "memory", "events", "candidates.jsonl")),
    ).toBe(false)
  })

  it("does not capture tool_input contents for denied secret paths", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-capture-tool-env-"))
    const result = observeCapture({
      host: "claude",
      eventType: "PostToolUse",
      cwd,
      payload: {
        tool_name: "Edit",
        tool_input: {
          file_path: "apps/billing/.env",
          new_string:
            "We decided DATABASE_URL=postgres://user:hunter2@localhost/db",
        },
      },
    })
    expect(result.wrote).toBe(false)
    expect(
      existsSync(join(cwd, ".ai", "memory", "events", "candidates.jsonl")),
    ).toBe(false)
  })

  it("does not capture long serialized tool_input mentioning .env paths", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-capture-long-env-"))
    const padding = "x".repeat(600)
    const result = observeCapture({
      host: "claude",
      eventType: "PostToolUse",
      cwd,
      payload: {
        tool_name: "Edit",
        tool_input: `${padding} path=apps/billing/.env We decided secret=opaquevalue`,
      },
    })
    expect(result.wrote).toBe(false)
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
      const first = summarizeCapture({ cwd, host: "claude" })
      expect(first.candidates.length).toBeGreaterThan(0)
      expect(first.candidates[0]?.candidateId).toBeTruthy()
      expect(first.surfacedIds.length).toBe(first.candidates.length)
      expect(first.priority).not.toBe("low")
      // Before ack, candidates remain pending (delivery may have failed).
      expect(
        summarizeCapture({ cwd, host: "claude" }).candidates.length,
      ).toBeGreaterThan(0)
      acknowledgeSurfaced(first.surfacedIds, { cwd })
      // Claude: surfaced-but-unresolved stay visible until promote/dismiss.
      const second = summarizeCapture({ cwd, host: "claude" })
      expect(second.candidates.length).toBeGreaterThan(0)
      expect(second.candidates[0]?.candidateId).toBe(
        first.candidates[0]?.candidateId,
      )
      expect(
        existsSync(join(cwd, ".ai", "memory", "events", "lifecycle.json")),
      ).toBe(true)
    },
  )

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
      const firstIds = new Set(first.surfacedIds)
      acknowledgeSurfaced(first.surfacedIds, { cwd })
      const second = summarizeCapture({ cwd })
      // Prefer the two never-shown ids before re-listing the first batch.
      expect(second.candidates.length).toBeGreaterThan(0)
      expect(second.candidates.length).toBeLessThanOrEqual(8)
      expect(
        second.candidates.some((c) => !firstIds.has(c.candidateId)),
      ).toBe(true)
      acknowledgeSurfaced(second.surfacedIds, { cwd })
      // Cursor: do not recycle follow-ups after every never-shown id was shown.
      const third = summarizeCapture({ cwd, host: "cursor" })
      expect(third.candidates).toEqual([])
      expect(third.priority).toBe("low")
      // Claude may re-show unresolved surfaced ids.
      const claudeAgain = summarizeCapture({ cwd, host: "claude" })
      expect(claudeAgain.candidates.length).toBeGreaterThan(0)
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

  it("does not mint candidates from afterFileEdit bodies", () => {
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
    expect(result.wrote).toBe(false)
    expect(result.candidateCount).toBe(0)
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

  it("formats Claude Stop output with decision block + reason", () => {
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
      decision: "block",
      reason: "Promote candidate abc",
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

  it("suppresses Cursor Stop follow-up on aborted status", () => {
    const out = formatStopHookOutput(
      "cursor",
      {
        priority: "medium",
        message: "Promote candidate abc",
        candidates: [],
        surfacedIds: ["abc"],
        parseErrors: 0,
      },
      { status: "aborted" },
    )
    expect(out).toEqual({})
  })

  it("suppresses Cursor Stop follow-up when loop_count is already 1", () => {
    const out = formatStopHookOutput(
      "cursor",
      {
        priority: "high",
        message:
          "Memory candidates (2 pending). Promote via skills/rules — do not auto-write ADRs from hooks.",
        candidates: [],
        surfacedIds: ["abc"],
        parseErrors: 0,
      },
      { status: "completed", loop_count: 1 },
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

  it("does not classify docs, compiler dumps, Stop follow-ups, or grep payloads", () => {
    expect(
      classifyText(
        "Use React Aria Tabs when composing a keyboard-accessible tab strip.",
      ),
    ).toEqual([])
    expect(
      classifyText(
        "src/foo.ts(12,5): error TS2307: Cannot find module 'react-aria-components'",
      ),
    ).toEqual([])
    expect(
      classifyText(
        "Memory candidates (2 pending). Promote via skills/rules — do not auto-write ADRs from hooks.\nThen mark ids promoted/dismissed.",
      ),
    ).toEqual([])
    expect(
      classifyText(
        JSON.stringify({
          pattern: "lessons-learned|ADR-024",
          path: ".ai/memory/lessons-learned.md",
        }),
      ),
    ).toEqual([])
  })

  it("still classifies user-preference lessons", () => {
    const hits = classifyText(
      "From now on always colocate Zod with routes",
    )
    expect(hits.some((h) => h.kind === "lesson")).toBe(true)
  })

  it("does not observe Stop follow-up prompts, memory-file edits, or tsc dumps", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-capture-noise-"))
    expect(
      observeCapture({
        host: "cursor",
        eventType: "beforeSubmitPrompt",
        cwd,
        payload: {
          prompt:
            "Memory candidates (2 pending). Promote via skills/rules — do not auto-write ADRs from hooks.",
        },
      }).wrote,
    ).toBe(false)

    expect(
      observeCapture({
        host: "cursor",
        eventType: "afterFileEdit",
        cwd,
        payload: {
          file_path: join(cwd, ".ai", "memory", "lessons-learned.md"),
          edits: [
            {
              old_string: "",
              new_string:
                "### Example\n- **Rule:** From now on always use Zod schemas collocated with routes\n",
            },
          ],
        },
      }).wrote,
    ).toBe(false)

    expect(
      observeCapture({
        host: "cursor",
        eventType: "postToolUse",
        cwd,
        payload: {
          toolName: "Shell",
          toolOutput:
            "src/foo.ts(12,5): error TS2307: Cannot find module 'react-aria-components'",
        },
      }).wrote,
    ).toBe(false)
  })

  it("writes a lesson candidate for a user-preference prompt and dedups the same excerpt", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-capture-user-lesson-"))
    const payload = {
      prompt: "From now on always colocate Zod with routes",
      sessionId: "user-lesson",
    }
    const first = observeCapture({
      host: "cursor",
      eventType: "beforeSubmitPrompt",
      cwd,
      payload,
    })
    expect(first.wrote).toBe(true)
    expect(first.candidateCount).toBeGreaterThan(0)
    const second = observeCapture({
      host: "cursor",
      eventType: "beforeSubmitPrompt",
      cwd,
      payload,
    })
    expect(second.wrote).toBe(false)
    expect(second.candidateCount).toBe(0)
    const lines = readFileSync(
      join(cwd, ".ai", "memory", "events", "candidates.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
    expect(lines).toHaveLength(1)
  })

  it("does not emit a Claude follow-up for leftover PostToolUse candidates", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-capture-claude-tool-"))
    mkdirSync(join(cwd, ".ai", "memory", "events"), { recursive: true })
    writeFileSync(
      join(cwd, ".ai", "memory", "events", "candidates.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        candidateId: "claudetool0000001",
        kind: "lesson",
        destination: ".ai/memory/lessons-learned.md",
        action: "Append a lesson",
        excerpt: "From now on always use a fake Claude tool-sourced fact",
        sourceEventType: "PostToolUse",
        sourceHost: "claude",
      })}\n`,
      "utf8",
    )
    const summary = summarizeCapture({ cwd, host: "claude" })
    expect(summary.priority).toBe("low")
    expect(summary.candidates).toEqual([])
    expect(formatStopHookOutput("claude", summary, {})).toEqual({})
    const lifecycle = JSON.parse(
      readFileSync(
        join(cwd, ".ai", "memory", "events", "lifecycle.json"),
        "utf8",
      ),
    ) as { dismissed?: string[] }
    expect(lifecycle.dismissed).toContain("claudetool0000001")
  })

  it("does not emit a Cursor follow-up for tool-sourced pending candidates", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-capture-tool-src-"))
    mkdirSync(join(cwd, ".ai", "memory", "events"), { recursive: true })
    writeFileSync(
      join(cwd, ".ai", "memory", "events", "candidates.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        candidateId: "toolsrc000000001",
        kind: "lesson",
        destination: ".ai/memory/lessons-learned.md",
        action: "Append a lesson",
        excerpt: "From now on always use a fake tool-sourced fact",
        sourceEventType: "postToolUse",
        sourceHost: "cursor",
      })}\n`,
      "utf8",
    )
    const summary = summarizeCapture({ cwd, host: "cursor" })
    expect(summary.priority).toBe("low")
    expect(summary.candidates).toEqual([])
    expect(
      formatStopHookOutput("cursor", summary, {}),
    ).toEqual({})
    const lifecycle = JSON.parse(
      readFileSync(join(cwd, ".ai", "memory", "events", "lifecycle.json"), "utf8"),
    ) as { dismissed?: string[] }
    expect(lifecycle.dismissed).toContain("toolsrc000000001")
  })

  it("emits a Cursor follow-up once for a never-shown user-prompt candidate", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-capture-once-"))
    observeCapture({
      host: "cursor",
      eventType: "beforeSubmitPrompt",
      cwd,
      payload: {
        prompt: "From now on always colocate Zod with routes",
        sessionId: "once-1",
      },
    })
    const first = summarizeCapture({ cwd, host: "cursor" })
    expect(first.priority).not.toBe("low")
    expect(first.candidates.length).toBeGreaterThan(0)
    expect(first.message).toContain(
      "Reply to the user with one short sentence naming only what was learned; if nothing was promoted, say nothing about memory.",
    )
    expect(
      formatStopHookOutput("cursor", first, {}).followup_message,
    ).toBeTruthy()
    acknowledgeSurfaced(first.surfacedIds, { cwd })
    const second = summarizeCapture({ cwd, host: "cursor" })
    expect(second.priority).toBe("low")
    expect(second.candidates).toEqual([])
    expect(formatStopHookOutput("cursor", second, {})).toEqual({})
  })

  it("does not recapture an injected Cursor Stop follow-up as a new lesson", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-capture-recapture-"))
    const firstObserve = observeCapture({
      host: "cursor",
      eventType: "beforeSubmitPrompt",
      cwd,
      payload: {
        prompt: "From now on always colocate Zod with routes",
        sessionId: "recapture",
      },
    })
    expect(firstObserve.wrote).toBe(true)
    const first = summarizeCapture({ cwd, host: "cursor" })
    const injected = formatStopHookOutput("cursor", first, {
      status: "completed",
      loop_count: 0,
    })
    expect(injected.followup_message).toBeTruthy()
    acknowledgeSurfaced(first.surfacedIds, { cwd })

    const followUpPrompt = String(injected.followup_message)
    expect(followUpPrompt).toContain("Memory candidates (")
    expect(followUpPrompt).toContain(
      "one short sentence naming only what was learned",
    )
    expect(
      observeCapture({
        host: "cursor",
        eventType: "beforeSubmitPrompt",
        cwd,
        payload: { prompt: followUpPrompt, sessionId: "recapture" },
      }).wrote,
    ).toBe(false)

    expect(
      observeCapture({
        host: "cursor",
        eventType: "beforeSubmitPrompt",
        cwd,
        payload: {
          prompt: {
            content: [{ type: "text", text: followUpPrompt }],
          },
          sessionId: "recapture",
        },
      }).wrote,
    ).toBe(false)

    const second = summarizeCapture({ cwd, host: "cursor" })
    expect(
      formatStopHookOutput("cursor", second, {
        status: "completed",
        loop_count: 1,
      }),
    ).toEqual({})
  })
})
