import { setTimeout as sleep } from "node:timers/promises"
import { initLogger } from "evlog"
import { describe, expect, it, vi } from "vitest"
import { tryEmitIndexEvent } from "./indexingLog.js"
import { createLogger, withLogger } from "./logger.js"

describe("tryEmitIndexEvent", () => {
  // Real timers: a timer keeps the async context it was created in, which is
  // what loses events after a flush rotates the logger.
  it("delivers events from timers and branches created before a flush", async () => {
    const emitted: Array<Record<string, unknown>> = []
    initLogger({
      env: { service: "codesearch-test", environment: "test" },
      pretty: false,
      silent: true,
      drain: (ctx) => {
        emitted.push(ctx.event as Record<string, unknown>)
      },
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    await withLogger(createLogger({ repoId: "repo_1" }), async () => {
      const heartbeat = setInterval(() => {
        tryEmitIndexEvent("codesearch.index.phase.heartbeat", { pid: 7 })
      }, 30)
      const branch = new Promise<void>((resolve) => {
        setTimeout(() => {
          tryEmitIndexEvent("codesearch.index.phase.end", { phase: "zoekt" })
          resolve()
        }, 45)
      })

      tryEmitIndexEvent("codesearch.index.phase.start", { phase: "zoekt" })
      await sleep(70)
      await branch
      clearInterval(heartbeat)
    })

    const steps = emitted.map((event) => [event.step, event.repoId])
    expect(steps).toEqual([
      ["codesearch.index.phase.start", "repo_1"],
      ["codesearch.index.phase.heartbeat", "repo_1"],
      ["codesearch.index.phase.end", "repo_1"],
      ["codesearch.index.phase.heartbeat", "repo_1"],
    ])
    expect(
      warn.mock.calls.filter(([message]) =>
        String(message).includes("Keys dropped"),
      ),
    ).toEqual([])
  })
})
