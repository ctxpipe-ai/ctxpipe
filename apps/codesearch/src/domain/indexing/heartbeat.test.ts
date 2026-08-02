import { writeFileSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import * as observability from "../../observability/logger.js"
import { runScipIndexer } from "./scipIndexers.js"

describe("SCIP indexer heartbeat", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "heartbeat-test-"))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("registers a heartbeat callback and emits ≥1 event when triggered", async () => {
    const logInfoSpy = vi
      .spyOn(observability.log, "info")
      .mockImplementation(() => undefined)

    const checkoutPath = join(tmpDir, "checkout")
    const shardPath = join(tmpDir, "go.scip")
    await mkdir(checkoutPath)

    let resolveExit!: (code: number) => void
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve
    })

    // Capture the heartbeat setInterval callback so we can fire it manually
    // (avoids needing vi.useFakeTimers which conflicts with vi.stubGlobal("Bun")).
    const capturedIntervals: Array<{ fn: () => void; ms: number }> = []
    const realSetInterval = globalThis.setInterval.bind(globalThis)
    vi.stubGlobal("setInterval", (fn: () => void, ms: number) => {
      capturedIntervals.push({ fn, ms })
      return realSetInterval(fn, ms)
    })
    vi.stubGlobal("clearInterval", vi.fn())

    vi.stubGlobal("Bun", {
      spawn: vi.fn().mockImplementation((argv: string[]) => {
        writeFileSync(argv.at(-1) as string, "fake-scip-index")
        return { pid: 1234, exited, stdout: null, stderr: null }
      }),
    })

    // Start the indexer (does not await — subprocess never exits until resolveExit).
    const indexerPromise = runScipIndexer({
      indexerId: "go",
      checkoutPath,
      shardPath,
    })

    // Wait until the heartbeat interval has been registered (i.e. Bun.spawn was called
    // and the setInterval call inside runIndexerProcess has been reached).
    await vi.waitFor(() => {
      expect(
        capturedIntervals.some((i) => i.ms === 30_000),
      ).toBe(true)
    })

    // Manually fire the heartbeat callback — simulates the child being alive for 30 s.
    const heartbeatEntry = capturedIntervals.find((i) => i.ms === 30_000)!
    heartbeatEntry.fn()

    const heartbeatCalls = (
      logInfoSpy.mock.calls as Array<[Record<string, unknown>]>
    ).filter(([e]) => e?.step === "codesearch.index.phase.heartbeat")

    expect(heartbeatCalls.length).toBeGreaterThanOrEqual(1)
    expect(heartbeatCalls[0]?.[0]).toMatchObject({
      step: "codesearch.index.phase.heartbeat",
      indexerId: "go",
      pid: 1234,
    })

    // Let the subprocess exit cleanly.
    resolveExit(0)
    await indexerPromise
  })

  it("clears the heartbeat interval once the subprocess exits", async () => {
    const checkoutPath = join(tmpDir, "checkout2")
    const shardPath = join(tmpDir, "go2.scip")
    await mkdir(checkoutPath)

    const clearIntervalSpy = vi.fn()
    const registeredIds: number[] = []
    const realSetInterval = globalThis.setInterval.bind(globalThis)

    vi.stubGlobal("setInterval", (fn: () => void, ms: number) => {
      const id = realSetInterval(fn, ms) as unknown as number
      registeredIds.push(id)
      return id
    })
    vi.stubGlobal("clearInterval", clearIntervalSpy)

    vi.stubGlobal("Bun", {
      spawn: vi.fn().mockImplementation((argv: string[]) => {
        writeFileSync(argv.at(-1) as string, "fake-scip-index")
        return { pid: 5678, exited: Promise.resolve(0), stdout: null, stderr: null }
      }),
    })

    await runScipIndexer({ indexerId: "go", checkoutPath, shardPath })

    // clearInterval must have been called for the heartbeat timer.
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
  })
})
