import { afterEach, describe, expect, it, vi } from "vitest"

import type { RootExec } from "./ingest-root.js"
import {
  INGEST_STEP_LIMIT_MS,
  ingestStepCheckpoint,
  ingestStepSignal,
  runIngestFetch,
  runIngestShardStep,
} from "./ingest-shard-ops.js"

/*
 * The scan gate of a model step (CTX-1083). The host runs the `dependencies`
 * scan first, and runs the model only when the scan says that a claim is
 * possible. The sandbox is the environment here: a root command that records
 * what the host runs and answers the scan with a chosen result.
 */

function sandbox(scan: { exitCode: number; stdout: string }) {
  const commands: string[] = []
  const root: RootExec = async (script) => {
    commands.push(script)
    const isScan = script.includes("dependencies/scripts/scan.mjs")
    return {
      exitCode: isScan ? scan.exitCode : 0,
      stdout: isScan ? scan.stdout : "",
      stderr: "",
    }
  }
  const ran = (text: string) => commands.some((c) => c.includes(text))
  return { root, commands, ran }
}

const step = (skill: string) => ({
  name: `skill:repository:${skill}:ws_test`,
  skill,
  run: "model" as const,
  tier: "medium" as const,
  root: null,
  workspaceId: "ws_test",
  baseCommit: "a".repeat(40),
  rootMap: { roots: [] },
  signal: AbortSignal.timeout(30_000),
})
const input = (skill: string) => ({
  step: step(skill),
  agentEnv: {},
  remote: "/remote.git",
  sourceUrl: "https://github.com/example-org/shop",
  sourcePath: "sources/github/example-org/shop.md",
  model: "ctxpipe/test-model",
})

describe("the scan gate of the dependencies step", () => {
  it("runs no model when the scan says that no claim is possible, and finishes the step", async () => {
    const s = sandbox({ exitCode: 0, stdout: '{"needsModel":false}\n' })
    const result = await runIngestShardStep(s.root, input("dependencies"))
    expect(s.ran("--gate")).toBe(true)
    expect(s.ran("opencode")).toBe(false)
    expect(s.ran("ctxpipe-finish")).toBe(true)
    expect(result).toEqual({ usage: { inputTokens: 0, outputTokens: 0 } })
  })

  it("runs the model when the scan finds work", async () => {
    const s = sandbox({ exitCode: 0, stdout: '{"needsModel":true}\n' })
    await runIngestShardStep(s.root, input("dependencies"))
    expect(s.ran("opencode")).toBe(true)
  })

  it("runs the model when the scan fails or prints text that is not a result", async () => {
    for (const scan of [
      { exitCode: 1, stdout: "" },
      { exitCode: 0, stdout: "not json" },
      { exitCode: 0, stdout: '{"needsModel":"no"}' },
    ]) {
      const s = sandbox(scan)
      await runIngestShardStep(s.root, input("dependencies"))
      expect(s.ran("opencode")).toBe(true)
    }
  })

  it("does not scan for another skill", async () => {
    const s = sandbox({ exitCode: 0, stdout: '{"needsModel":false}\n' })
    await runIngestShardStep(s.root, input("apis"))
    expect(s.ran("scan.mjs")).toBe(false)
    expect(s.ran("opencode")).toBe(true)
  })
})

describe("the finder of a cursor skill (CTX-1487)", () => {
  function finderSandbox(finder: { exitCode: number; stdout: string }) {
    const commands: string[] = []
    const root: RootExec = async (script) => {
      commands.push(script)
      const isFinder = script.includes("--count")
      return {
        exitCode: isFinder ? finder.exitCode : 0,
        stdout: isFinder ? finder.stdout : "",
        stderr: "",
      }
    }
    return { root, commands }
  }
  const cursorInput = () => ({
    ...input("ownership"),
    step: { ...step("ownership"), run: "script" as const, cursor: true as const },
  })

  it("runs the finder before the skill and returns its count", async () => {
    const s = finderSandbox({ exitCode: 0, stdout: 'log line\n{"count":41}\n' })
    const result = await runIngestShardStep(s.root, cursorInput())
    expect(result).toEqual({ inputs: 41 })
    const finder = s.commands.findIndex(
      (c) =>
        c.includes("ownership/scripts/ownership.mjs") && c.includes("--count"),
    )
    const skill = s.commands.findIndex(
      (c) =>
        c.includes("ownership/scripts/ownership.mjs") && !c.includes("--count"),
    )
    expect(finder).toBeGreaterThan(-1)
    expect(skill).toBeGreaterThan(finder)
  })

  it("fails the step when the finder gives no count", async () => {
    for (const finder of [
      { exitCode: 1, stdout: '{"count":4}' },
      { exitCode: 0, stdout: "not json" },
      { exitCode: 0, stdout: '{"count":-1}' },
      { exitCode: 0, stdout: '{"count":1.5}' },
    ]) {
      const s = finderSandbox(finder)
      await expect(
        runIngestShardStep(s.root, cursorInput()),
      ).rejects.toMatchObject({ part: "count" })
      expect(s.commands.some((c) => c.includes("ctxpipe-finish"))).toBe(false)
    }
  })

  it("runs no finder for a skill with no cursor", async () => {
    const s = finderSandbox({ exitCode: 0, stdout: '{"count":3}' })
    const result = await runIngestShardStep(s.root, {
      ...input("ownership"),
      step: { ...step("ownership"), run: "script" as const },
    })
    expect(result).toEqual({})
    expect(s.commands.some((c) => c.includes("--count"))).toBe(false)
  })
})

describe("ingestStepCheckpoint", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("fires one minute before the step limit, so a stopped model step can still finish (CTX-1312)", () => {
    vi.useFakeTimers()
    const checkpoint = ingestStepCheckpoint()
    const limit = ingestStepSignal()
    vi.advanceTimersByTime(INGEST_STEP_LIMIT_MS - 60_001)
    expect(checkpoint.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(checkpoint.aborted).toBe(true)
    expect(limit.aborted).toBe(false)
    vi.advanceTimersByTime(60_000)
    expect(limit.aborted).toBe(true)
  })
})

/*
 * A clone through the egress proxy (CTX-1470). The sandbox is the
 * environment here: its exec gives the answers of Git in order, and the
 * Retry-After probe answers with `retryAfter`.
 */
function fetchSandbox(stderrs: string[], retryAfter = "") {
  const commands: string[] = []
  const handle: Parameters<typeof runIngestFetch>[0] = {
    process: {
      exec: async (command) => {
        if (command.includes("curl -s -o /dev/null -D -"))
          return { exitCode: 0, stdout: retryAfter, stderr: "" }
        commands.push(command)
        const stderr = stderrs.shift()
        return stderr === undefined
          ? { exitCode: 0, stdout: "done", stderr: "" }
          : { exitCode: 128, stdout: "", stderr }
      },
    },
  }
  return { handle, commands }
}

const proxy429 =
  "fatal: unable to access 'https://github.com/o/r.git/': CONNECT tunnel failed, response 429\n"
const cloneStep = {
  command: "git clone x",
  url: "https://github.com/o/r.git",
}

describe("runIngestFetch", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("runs a clone again after a short burst of 429s, with the fixed waits when the proxy gives no Retry-After", async () => {
    vi.useFakeTimers()
    const { handle, commands } = fetchSandbox([
      proxy429,
      "error: RPC failed; HTTP 429 curl 22 The requested URL returned error: 429\n",
    ])
    const fetching = runIngestFetch(handle, cloneStep)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(commands).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(commands).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(fetching).resolves.toBe("done")
    expect(commands).toHaveLength(3)
  })

  it("waits one second past the proxy's Retry-After", async () => {
    vi.useFakeTimers()
    const { handle, commands } = fetchSandbox([proxy429], "20\n")
    const fetching = runIngestFetch(handle, cloneStep)
    await vi.advanceTimersByTimeAsync(20_999)
    expect(commands).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(fetching).resolves.toBe("done")
    expect(commands).toHaveLength(2)
  })

  it("fails at once when the Retry-After goes past its 2-minute budget", async () => {
    const { handle, commands } = fetchSandbox([proxy429], "240\n")
    await expect(runIngestFetch(handle, cloneStep)).rejects.toThrow(
      /response 429/,
    )
    expect(commands).toHaveLength(1)
  })

  it("stops after 3 retries, so a long block still fails the step", async () => {
    vi.useFakeTimers()
    const { handle, commands } = fetchSandbox(Array(5).fill(proxy429))
    const fetching = runIngestFetch(handle, cloneStep)
    const failed = expect(fetching).rejects.toThrow(/response 429/)
    await vi.advanceTimersByTimeAsync(50_000)
    await failed
    expect(commands).toHaveLength(4)
  })

  it("does not run again on another error", async () => {
    const { handle, commands } = fetchSandbox([
      "fatal: repository 'https://github.com/o/r.git/' not found\n",
    ])
    await expect(runIngestFetch(handle, cloneStep)).rejects.toThrow(/not found/)
    expect(commands).toHaveLength(1)
  })

  it("stops its wait when the step ends", async () => {
    const { handle, commands } = fetchSandbox([proxy429])
    const controller = new AbortController()
    const fetching = runIngestFetch(handle, {
      ...cloneStep,
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(commands).toHaveLength(1))
    controller.abort(new Error("step limit"))
    await expect(fetching).rejects.toThrow(/step limit|aborted/)
    expect(commands).toHaveLength(1)
  })
})
