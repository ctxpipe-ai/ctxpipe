import { APIError, Sandbox } from "@vercel/sandbox"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

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

type Call = { cmd: string; args?: string[]; sudo?: boolean; detached?: boolean }

type LogLine = { stream: "stdout" | "stderr"; data: string }

/**
 * An in-memory Vercel sandbox. The first command starts with no exit code.
 * Each `getCommand` read takes the next item of `readResults`: an exit code,
 * `null` while it runs, or an error to throw. Each later command (the stop
 * script of an abort) ends at once with exit 0.
 */
function fakeSandbox(
  readResults: (number | null | Error)[],
  lines: () => Iterable<LogLine> = () => [{ stream: "stdout", data: "out" }],
) {
  const calls: Call[] = []
  const killed: string[] = []
  let readCount = 0
  let logReads = 0
  const command = (cmdId: string, exitCode: number | null) => ({
    cmdId,
    exitCode,
    logs: async function* () {
      logReads++
      yield* lines()
    },
    kill: async () => {
      killed.push(cmdId)
    },
  })
  return {
    calls,
    killed,
    reads: () => readCount,
    logReads: () => logReads,
    sandbox: {
      runCommand: async (input: Call & { detached: true }) => {
        calls.push(input)
        return calls.length === 1
          ? command("cmd_1", null)
          : command(`cmd_${calls.length}`, 0)
      },
      getCommand: async (cmdId: string) => {
        readCount++
        const next = readResults.shift()
        if (next instanceof Error) throw next
        return command(cmdId, next ?? null)
      },
    },
  }
}

/** A dropped connection, as undici reports it in production. */
const terminated = () =>
  new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } })

describe("vercelRootExec", () => {
  // The waits use `node:timers/promises`, which fake timers do not cover,
  // so these tests wait in real time. The retry wait is short for that.

  /** Run `promise` to its end, as a value or an error. */
  const settle = <T>(promise: Promise<T>) =>
    promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )

  it("starts the script detached with sudo through sh", async () => {
    const { calls, sandbox } = fakeSandbox([0])
    expect(await settle(vercelRootExec(sandbox)("mkdir -p /ctxpipe"))).toEqual({
      value: { stdout: "out", stderr: "", exitCode: 0 },
    })
    expect(calls).toEqual([
      {
        cmd: "sh",
        args: ["-c", "mkdir -p /ctxpipe"],
        sudo: true,
        detached: true,
      },
    ])
  })

  it("reads the command again with short requests until it ends, then reads its logs once", async () => {
    const fake = fakeSandbox([null, null, 3], () => [
      { stream: "stdout", data: "line 1\n" },
      { stream: "stderr", data: "warn" },
      { stream: "stdout", data: "line 2" },
    ])
    expect(await settle(vercelRootExec(fake.sandbox)("step"))).toEqual({
      value: { stdout: "line 1\nline 2", stderr: "warn", exitCode: 3 },
    })
    expect(fake.reads()).toBe(3)
    expect(fake.logReads()).toBe(1)
  })

  it("waits at most a few seconds between two reads", async () => {
    const fake = fakeSandbox([])
    const controller = new AbortController()
    const running = settle(
      vercelRootExec(fake.sandbox)("long step", { signal: controller.signal }),
    )
    await new Promise((resolve) => setTimeout(resolve, 3_700))
    controller.abort(new Error("test end"))
    await running
    // Waits of 100 ms, 200 ms, 400 ms, 800 ms, and 1.6 s: five reads in 3.7 s.
    expect(fake.reads()).toBeGreaterThanOrEqual(5)
  }, 10_000)

  it("does not fail the command on a few failed reads", async () => {
    const fake = fakeSandbox([
      null,
      terminated(),
      new TypeError("fetch failed"),
      null,
      terminated(),
      0,
    ])
    expect(await settle(vercelRootExec(fake.sandbox)("step"))).toEqual({
      value: { stdout: "out", stderr: "", exitCode: 0 },
    })
  })

  it.each([
    ["a 502 answer", 502],
    ["a 429 answer", 429],
    ["a broken body with status 200", 200],
  ])("tries a read again after %s", async (_name, status) => {
    const fake = fakeSandbox([new APIError(new Response(null, { status })), 0])
    expect(await settle(vercelRootExec(fake.sandbox)("step"))).toEqual({
      value: { stdout: "out", stderr: "", exitCode: 0 },
    })
    expect(fake.reads()).toBe(2)
  })

  it("fails the command when too many reads in sequence fail, and kills it", async () => {
    const fake = fakeSandbox([null, ...Array.from({ length: 6 }, terminated)])
    const outcome = await settle(vercelRootExec(fake.sandbox)("step"))
    expect(outcome).toEqual({ error: expect.any(TypeError) })
    expect(fake.reads()).toBe(7)
    expect(fake.killed).toEqual(["cmd_1"])
  })

  it("counts only failures in sequence", async () => {
    const fail = () => new Error("read failed")
    const fake = fakeSandbox([
      ...Array.from({ length: 5 }, fail),
      null,
      ...Array.from({ length: 5 }, fail),
      0,
    ])
    expect(await settle(vercelRootExec(fake.sandbox)("step"))).toEqual({
      value: { stdout: "out", stderr: "", exitCode: 0 },
    })
    expect(fake.killed).toEqual([])
  })

  it("does not kill the command when it ends well", async () => {
    const fake = fakeSandbox([null, 0])
    await settle(vercelRootExec(fake.sandbox)("step"))
    expect(fake.killed).toEqual([])
  })

  it("reads the logs again from the start when the log read drops", async () => {
    let attempt = 0
    const fake = fakeSandbox([0], function* () {
      attempt++
      yield { stream: "stdout", data: "part\n" }
      if (attempt === 1) throw terminated()
      yield { stream: "stdout", data: "end" }
    })
    expect(await settle(vercelRootExec(fake.sandbox)("step"))).toEqual({
      value: { stdout: "part\nend", stderr: "", exitCode: 0 },
    })
    expect(fake.logReads()).toBe(2)
    expect(fake.killed).toEqual([])
  })

  it("fails the command and kills it when the log read keeps failing", async () => {
    const fake = fakeSandbox([0], function* () {
      yield { stream: "stdout", data: "part\n" }
      throw new APIError(new Response(null, { status: 200 }))
    })
    const outcome = await settle(vercelRootExec(fake.sandbox)("step"))
    expect(outcome).toEqual({ error: expect.any(APIError) })
    expect(fake.logReads()).toBe(3)
    expect(fake.killed).toEqual(["cmd_1"])
  })

  it("on abort, stops the wait at once and kills the command", async () => {
    const fake = fakeSandbox([])
    const controller = new AbortController()
    const running = vercelRootExec(fake.sandbox)("sleep 600", {
      signal: controller.signal,
    }).then(
      () => "finished",
      (error: Error) => error.message,
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
    controller.abort(new Error("step limit"))
    expect(await running).toBe("step limit")
    expect(fake.killed).toEqual(["cmd_1"])
    const readsAtAbort = fake.reads()
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(fake.reads()).toBe(readsAtAbort)
    // The command, then the stop script of the abort.
    expect(fake.calls[1]?.args?.[1]).toContain("kill -TERM")
  })

  it("throws with the stderr when a root script fails", async () => {
    const { sandbox } = fakeSandbox([1], () => [
      { stream: "stderr", data: "sudo: not allowed" },
    ])
    const outcome = await settle(runAsRoot(vercelRootExec(sandbox), "true"))
    expect(outcome).toEqual({
      error: expect.objectContaining({
        message: expect.stringMatching(/exit 1.*sudo: not allowed/),
      }),
    })
  })
})

describe("vercelRootExec through the Vercel SDK", () => {
  /** One NDJSON log line of the SDK's `/logs` endpoint. */
  type Log = { stream: "stdout" | "stderr"; data: string }
  let logs: () => Generator<Log> = function* () {}
  let streamedLines = 0
  let reads = 0
  /** The next reads of the command answer with a body that breaks. */
  let brokenReads = 0
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
  const command = {
    id: "cmd_root",
    name: "sh",
    args: [],
    cwd: "/vercel/sandbox",
    sessionId: session.id,
    startedAt: 1,
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
    http.post(
      "https://vercel.com/api/v2/sandboxes/sessions/:id/cmd",
      async ({ request }) => {
        // Detached: the start answers at once, with no exit code yet.
        expect(await request.json()).not.toHaveProperty("wait")
        reads = 0
        return HttpResponse.json({ command: { ...command, exitCode: null } })
      },
    ),
    // A short read of the command: it runs on the first read, then ends.
    http.get(
      "https://vercel.com/api/v2/sandboxes/sessions/:id/cmd/:cmd",
      () => {
        // Status 200, then the body breaks. The SDK does not retry this: it
        // throws an `APIError` with status 200.
        if (brokenReads-- > 0)
          return new HttpResponse(
            new ReadableStream({
              start(controller) {
                controller.error(new TypeError("terminated"))
              },
            }),
          )
        return HttpResponse.json({
          command: { ...command, exitCode: reads++ === 0 ? null : 0 },
        })
      },
    ),
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
  afterEach(() => {
    brokenReads = 0
  })

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
    expect(reads).toBe(2)
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

  it("tries a read again when its body breaks, as the SDK reports it", async () => {
    logs = function* () {
      yield { stream: "stdout", data: "done" }
    }
    brokenReads = 2
    const result = await (await root())("step")
    expect(result).toEqual({ stdout: "done", stderr: "", exitCode: 0 })
    // Two broken bodies, then the answer that has no exit code, then the end.
    expect(reads).toBe(2)
  }, 15_000)

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
