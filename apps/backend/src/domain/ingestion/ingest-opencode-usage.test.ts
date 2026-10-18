import { execFile } from "node:child_process"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  ingestFailureHint,
  ingestModelRunCommand,
  parseOpenCodeError,
  parseOpenCodeLogMessages,
  parseOpenCodeUsage,
} from "./ingest-opencode-usage.js"

/*
 * The events of `opencode run --format json` (OpenCode 1.18.34), in the shape
 * that its run command writes: `{ type, timestamp, sessionID, part }` on each
 * line. The model calls of one step: a tool call, then the last answer.
 */
const session = "ses_5a1c0f2e7ffeYb3kQ9dQm2Lx1"
const event = (type: string, part: Record<string, unknown>) =>
  JSON.stringify({ type, timestamp: 1760700000000, sessionID: session, part })
const stepFinish = (input: {
  cost: number
  input: number
  output: number
  reasoning: number
  read: number
  write: number
}) =>
  event("step_finish", {
    id: "prt_a1",
    sessionID: session,
    messageID: "msg_a1",
    type: "step-finish",
    reason: "tool-calls",
    snapshot: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    cost: input.cost,
    tokens: {
      input: input.input,
      output: input.output,
      reasoning: input.reasoning,
      cache: { read: input.read, write: input.write },
    },
  })
const recorded = (costs: [number, number]) =>
  [
    event("step_start", { id: "prt_s1", type: "step-start" }),
    event("tool_use", {
      id: "prt_t1",
      type: "tool",
      tool: "bash",
      state: { status: "completed", output: "staged knowledge/a.md" },
    }),
    stepFinish({
      cost: costs[0],
      input: 1200,
      output: 300,
      reasoning: 50,
      read: 4000,
      write: 800,
    }),
    event("step_start", { id: "prt_s2", type: "step-start" }),
    event("text", { id: "prt_x1", type: "text", text: "Done." }),
    stepFinish({
      cost: costs[1],
      input: 200,
      output: 40,
      reasoning: 0,
      read: 5000,
      write: 0,
    }),
  ].join("\n")

/*
 * The `error` event of OpenCode 1.18.34 when its proxy refuses the model
 * call, as `opencode run --format json` wrote it (the message can hold the
 * text of the request, so the log must not show it).
 */
const refusedCall = JSON.stringify({
  type: "error",
  timestamp: 1760700000000,
  sessionID: session,
  error: {
    name: "APIError",
    data: {
      message: "Forbidden: denied private-source-text",
      statusCode: 403,
      isRetryable: false,
      metadata: { url: "http://backend.test:3000/openai/v1/chat/completions" },
    },
  },
})

describe("parseOpenCodeUsage", () => {
  it("adds the tokens and the cost of each model call when OpenCode reports a cost", () => {
    expect(parseOpenCodeUsage(recorded([0.0123, 0.0021]))).toEqual({
      inputTokens: 1200 + 4000 + 800 + 200 + 5000,
      outputTokens: 300 + 50 + 40,
      costUsd: expect.closeTo(0.0144, 10),
    })
  })

  it("gives only the tokens when a model call reports no cost", () => {
    expect(parseOpenCodeUsage(recorded([0, 0]))).toEqual({
      inputTokens: 11_200,
      outputTokens: 390,
    })
    expect(parseOpenCodeUsage(recorded([0.01, 0]))).not.toHaveProperty(
      "costUsd",
    )
  })

  it("gives no usage when no line is a step_finish event", () => {
    expect(parseOpenCodeUsage("")).toBeUndefined()
    expect(
      parseOpenCodeUsage(event("text", { type: "text", text: "Done." })),
    ).toBeUndefined()
    expect(parseOpenCodeUsage('{"type":"step_finish" broken')).toBeUndefined()
  })
})

describe("ingestModelRunCommand", () => {
  let bin: string
  const run = promisify(execFile)

  beforeAll(async () => {
    // A stand-in `opencode` on PATH: it writes the recorded events, keeps its
    // arguments in a file, writes a text line, then exits with $OPENCODE_EXIT.
    bin = await mkdtemp(join(tmpdir(), "opencode-usage-"))
    await writeFile(
      join(bin, "events.jsonl"),
      `${recorded([0.01, 0.02])}\n${refusedCall}\n`,
    )
    await writeFile(
      join(bin, "opencode"),
      `#!/bin/sh\ncat "${join(bin, "events.jsonl")}"\necho "$*" > "${join(bin, "args")}"\necho "Done."\nexit "\${OPENCODE_EXIT:-0}"\n`,
    )
    await chmod(join(bin, "opencode"), 0o755)
  })

  afterAll(() => rm(bin, { recursive: true, force: true }))

  async function sh(exit: number) {
    return run(
      "sh",
      [
        "-c",
        ingestModelRunCommand({ prompt: "Run the skill.", model: "ctxpipe/m" }),
      ],
      {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          OPENCODE_EXIT: String(exit),
        },
      },
    ).then(
      (result) => ({ code: 0, stdout: result.stdout }),
      (error: { code: number; stdout: string }) => ({
        code: error.code,
        stdout: error.stdout,
      }),
    )
  }

  it("keeps only the step_finish and error lines, with JSON events and the model", async () => {
    const result = await sh(0)
    expect(result.code).toBe(0)
    const lines = result.stdout.trim().split("\n")
    expect(lines).toHaveLength(3)
    expect(
      lines
        .slice(0, 2)
        .every((line) => line.startsWith('{"type":"step_finish"')),
    ).toBe(true)
    expect(parseOpenCodeError(result.stdout)).toEqual({
      name: "APIError",
      statusCode: 403,
    })
    expect(parseOpenCodeUsage(result.stdout)?.costUsd).toBeCloseTo(0.03, 10)
    expect((await readFile(join(bin, "args"), "utf8")).trim()).toBe(
      "run --format json --model ctxpipe/m Run the skill.",
    )
  })

  it("exits with the exit code of opencode run", async () => {
    const result = await sh(3)
    expect(result.code).toBe(3)
    expect(parseOpenCodeUsage(result.stdout)).toMatchObject({
      inputTokens: 11_200,
    })
  })
})

describe("parseOpenCodeError", () => {
  it("gives the name and the status of the last error event, never its message", () => {
    const summary = parseOpenCodeError(`${recorded([0, 0])}\n${refusedCall}`)
    expect(summary).toEqual({ name: "APIError", statusCode: 403 })
    expect(JSON.stringify(summary)).not.toContain("private-source-text")
  })

  it("gives unknown for a name that is not an identifier, and no status out of range", () => {
    const odd = JSON.stringify({
      type: "error",
      error: { name: "private source text", data: { statusCode: 9000 } },
    })
    expect(parseOpenCodeError(odd)).toEqual({ name: "unknown" })
    expect(parseOpenCodeError(recorded([0, 0]))).toBeUndefined()
  })
})

describe("ingestFailureHint", () => {
  it.each([
    ["getaddrinfo ENOTFOUND backend.sandbox.internal", "ENOTFOUND"],
    ["connect ECONNREFUSED 172.30.99.11:14322", "ECONNREFUSED"],
    ["Error: read ECONNRESET", "ECONNRESET"],
    ["The operation timed out.", "ETIMEDOUT"],
    ["HTTP/1.1 407 Proxy Authentication Required", "proxy"],
    [
      "Cannot connect to API: Unable to connect. Is the computer able to access the url?",
      "connect",
    ],
    ["ConfigInvalidError: opencode.json", "config"],
    ["Error: something private-source-text", "other"],
  ] as const)("classifies %j as %s", (output, hint) => {
    expect(ingestFailureHint(output)).toBe(hint)
  })
})

describe("parseOpenCodeLogMessages", () => {
  it("keeps the distinct short ERROR and WARN messages and drops paths and INFO lines", () => {
    const log = [
      'timestamp=2026-10-18T12:54:33.185Z level=INFO run=a message=init',
      'timestamp=2026-10-18T12:54:33.190Z level=ERROR run=a message="Failed to fetch models.dev" cause="Cause([Fail(HttpClientError: 403)])"',
      'timestamp=2026-10-18T12:54:33.221Z level=WARN run=a message="background dependency install failed" dir=/ctxpipe/home/config/opencode',
      'timestamp=2026-10-18T12:54:33.300Z level=WARN run=a message="server unavailable" key=tanstack type=remote status=failed',
      'timestamp=2026-10-18T12:54:33.310Z level=WARN run=a message="server unavailable" key=tanstack',
      'timestamp=2026-10-18T12:54:33.400Z level=ERROR run=a message="/ctxpipe/source/private/file.ts failed"',
    ].join("\n")
    expect(parseOpenCodeLogMessages(log)).toEqual([
      "Failed to fetch models.dev",
      "background dependency install failed",
      "server unavailable",
    ])
  })
})
