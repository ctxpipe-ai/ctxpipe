import { execFile } from "node:child_process"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  ingestModelRunCommand,
  parseOpenCodeErrors,
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

describe("parseOpenCodeUsage", () => {
  it("adds the tokens and the cost of each model call when OpenCode reports a cost", () => {
    expect(parseOpenCodeUsage(recorded([0.0123, 0.0021]))).toEqual({
      inputTokens: 1200 + 4000 + 800 + 200 + 5000,
      outputTokens: 300 + 50 + 40,
      cacheReadTokens: 4000 + 5000,
      costUsd: expect.closeTo(0.0144, 10),
    })
  })

  it("gives only the tokens when a model call reports no cost", () => {
    expect(parseOpenCodeUsage(recorded([0, 0]))).toEqual({
      inputTokens: 11_200,
      outputTokens: 390,
      cacheReadTokens: 9000,
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

/** An `error` event as OpenCode 1.18.34 writes it for a failed model call. */
const errorEvent = (error: Record<string, unknown>) =>
  JSON.stringify({
    type: "error",
    timestamp: 1760700000000,
    sessionID: session,
    error,
  })

describe("parseOpenCodeErrors", () => {
  it("gives the name and the HTTP status of each error event, and no message text", () => {
    const stdout = [
      errorEvent({
        name: "APIError",
        data: {
          message: "upstream said: source text",
          statusCode: 502,
          isRetryable: true,
          responseBody: "source text",
          metadata: { url: "http://backend.test/v1/chat/completions" },
        },
      }),
      errorEvent({
        name: "UnknownError",
        data: { message: "fetch failed: source text" },
      }),
      errorEvent({ name: "not a name: source text", data: {} }),
    ].join("\n")
    const errors = parseOpenCodeErrors(stdout)
    expect(errors).toEqual([
      { name: "APIError", status: 502 },
      { name: "UnknownError" },
      { name: "unknown" },
    ])
    expect(JSON.stringify(errors)).not.toContain("source text")
  })

  it("gives no error for other events and broken lines", () => {
    expect(parseOpenCodeErrors(recorded([0, 0]))).toEqual([])
    expect(parseOpenCodeErrors('{"type":"error" broken')).toEqual([])
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
      `${recorded([0.01, 0.02])}\n${errorEvent({ name: "APIError", data: { statusCode: 429 } })}\n`,
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
    expect(parseOpenCodeErrors(result.stdout)).toEqual([
      { name: "APIError", status: 429 },
    ])
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
