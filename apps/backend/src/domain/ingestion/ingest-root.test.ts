import { Sandbox } from "@vercel/sandbox"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ingestAgentCommand } from "./ingest-opencode.js"
import { assertIngestProvider } from "./ingest-prepare.js"
import {
  ROOT_STDERR_MAX_BYTES,
  ROOT_STDOUT_EVENT_MAX_BYTES,
  ROOT_STDOUT_MAX_BYTES,
  runAsRoot,
  vercelRootExec,
} from "./ingest-root.js"

/*
 * The hosted path runs the same root scripts as Docker, through the Vercel
 * SDK's `sudo` option. The Docker contract test runs those scripts for real,
 * also in an image whose default user has passwordless sudo as on Vercel;
 * this test proves the Vercel call. No Vercel sandbox runs here (T12). The
 * abort of a signalled script runs on real processes in the Docker contract
 * (`ingest-root.contract.test.ts`).
 */

type Call = { cmd: string; args?: string[]; sudo?: boolean }

type LogLine = { stream: "stdout" | "stderr"; data: string }

function fakeSandbox(
  exitCode: number,
  stderr = "",
  lines: () => Iterable<LogLine> = () => [
    { stream: "stdout", data: "out" },
    ...(stderr ? [{ stream: "stderr" as const, data: stderr }] : []),
  ],
) {
  const calls: Call[] = []
  return {
    calls,
    sandbox: {
      runCommand: async (input: Call) => {
        calls.push(input)
        return {
          exitCode,
          logs: async function* () {
            yield* lines()
          },
        }
      },
    },
  }
}

describe("vercelRootExec", () => {
  it("runs the script with sudo through sh", async () => {
    const { calls, sandbox } = fakeSandbox(0)
    expect(await vercelRootExec(sandbox)("mkdir -p /ctxpipe")).toEqual({
      stdout: "out",
      stderr: "",
      exitCode: 0,
    })
    expect(calls).toEqual([
      { cmd: "sh", args: ["-c", "mkdir -p /ctxpipe"], sudo: true },
    ])
  })

  it("throws with the stderr when a root script fails", async () => {
    const { sandbox } = fakeSandbox(1, "sudo: not allowed")
    await expect(runAsRoot(vercelRootExec(sandbox), "true")).rejects.toThrow(
      /exit 1.*sudo: not allowed/,
    )
  })
})

describe("vercelRootExec through the Vercel SDK", () => {
  /** One NDJSON log line of the SDK's `/logs` endpoint. */
  type Log = { stream: "stdout" | "stderr"; data: string }
  let logs: () => Generator<Log> = function* () {}
  let streamedLines = 0
  const session = {
    id: "ses_root",
    memory: 2048,
    vcpus: 1,
    region: "iad1",
    runtime: "node24",
    timeout: 60_000,
    status: "running",
    requestedAt: 1,
    createdAt: 1,
    cwd: "/vercel/sandbox",
    updatedAt: 1,
  }
  const ndjson = (lines: () => Generator<unknown>) => {
    const encoder = new TextEncoder()
    const iterator = lines()
    return new HttpResponse(
      new ReadableStream({
        pull(controller) {
          const next = iterator.next()
          if (next.done) controller.close()
          else
            controller.enqueue(
              encoder.encode(`${JSON.stringify(next.value)}\n`),
            )
        },
      }),
      { headers: { "content-type": "application/x-ndjson" } },
    )
  }
  const server = setupServer(
    http.get("https://vercel.com/api/v2/sandboxes/:name", ({ params }) =>
      HttpResponse.json({
        sandbox: {
          name: String(params.name),
          persistent: true,
          createdAt: 1,
          updatedAt: 1,
          currentSessionId: session.id,
          status: "running",
        },
        session,
        routes: [],
      }),
    ),
    http.post("https://vercel.com/api/v2/sandboxes/sessions/:id/cmd", () => {
      const command = {
        id: "cmd_root",
        name: "sh",
        args: [],
        cwd: "/vercel/sandbox",
        sessionId: session.id,
        startedAt: 1,
      }
      return ndjson(function* () {
        yield { command: { ...command, exitCode: null } }
        yield { command: { ...command, exitCode: 0 } }
      })
    }),
    http.get(
      "https://vercel.com/api/v2/sandboxes/sessions/:id/cmd/:cmd/logs",
      () =>
        ndjson(function* () {
          for (const line of logs()) {
            streamedLines++
            yield line
          }
        }),
    ),
  )
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
  afterAll(() => server.close())

  const root = async () =>
    vercelRootExec(
      await Sandbox.get({
        token: "t",
        teamId: "team_test",
        projectId: "prj_test",
        name: "ingest-root",
        resume: false,
      }),
    )

  it("keeps the start of a large stdout, its usage lines, and the end of a large stderr", async () => {
    // `opencode run` that writes far more than the caps: 1 MiB tool lines,
    // with a `step_finish` line after each. The worker must not keep all
    // of it (CTX-971), but it keeps every usage line.
    const tool = `${"x".repeat(1024 * 1024 - 1)}\n`
    const finish = (i: number) =>
      `${JSON.stringify({ type: "step_finish", part: { tokens: { input: i, output: 1 } } })}\n`
    logs = function* () {
      for (let i = 0; i < 32; i++) {
        yield { stream: "stdout", data: tool }
        yield { stream: "stdout", data: finish(i) }
        yield { stream: "stderr", data: `${i}:${tool}` }
      }
      yield {
        stream: "stdout",
        data: '{"type":"error","error":{"name":"APIError"}}',
      }
      yield { stream: "stderr", data: "the last error" }
    }
    const result = await (await root())("noisy")

    expect(streamedLines).toBe(32 * 3 + 2)
    expect(result.exitCode).toBe(0)
    expect(result.stdoutTruncated).toBe(true)
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(
      ROOT_STDOUT_MAX_BYTES + ROOT_STDOUT_EVENT_MAX_BYTES,
    )
    const lines = result.stdout.split("\n")
    expect(
      lines.filter((line) => line.startsWith('{"type":"step_finish"')),
    ).toEqual(Array.from({ length: 32 }, (_, i) => finish(i).trimEnd()))
    expect(lines.at(-1)).toBe('{"type":"error","error":{"name":"APIError"}}')
    expect(Buffer.byteLength(result.stderr)).toBe(ROOT_STDERR_MAX_BYTES)
    expect(result.stderr.endsWith("the last error")).toBe(true)
  })

  it("keeps a small stdout whole and does not mark it cut", async () => {
    logs = function* () {
      yield { stream: "stdout", data: '{"roots":' }
      yield { stream: "stdout", data: "[]}" }
    }
    const result = await (await root())("discover")
    expect(result.stdout).toBe('{"roots":[]}')
    expect(result.stdoutTruncated).toBeUndefined()
  })
})

describe("assertIngestProvider", () => {
  it("accepts Docker and Vercel", () => {
    expect(() => assertIngestProvider("docker")).not.toThrow()
    expect(() => assertIngestProvider("vercel")).not.toThrow()
  })

  it("refuses ingest in unsandboxed mode", () => {
    expect(() => assertIngestProvider("local-process")).toThrow(
      /needs a Docker or Vercel sandbox/,
    )
  })
})

describe("ingestAgentCommand", () => {
  it("runs the command as the agent user with only the given env", () => {
    expect(
      ingestAgentCommand({
        env: { HOME: "/ctxpipe/home" },
        command: "opencode --version",
      }),
    ).toBe(
      "runuser -u ctxpipe-agent -- env -i 'HOME=/ctxpipe/home' sh -c 'cd /ctxpipe/out && opencode --version'",
    )
  })
})
