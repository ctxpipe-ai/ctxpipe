import { describe, expect, it } from "vitest"

import { PUBLISH_TURN_WAIT_MS, waitForPublishTurn } from "./publish-turn.js"

/**
 * A stand-in for the OpenWorkflow step API with its replay rule: a step with
 * a recorded output returns that output and does not run again. Each sleep
 * moves the clock by its 60 seconds plus the delay before a worker claims
 * the run again.
 */
function engine(claimDelayMs: number) {
  const clock = { now: Date.parse("2026-10-21T03:21:32Z") }
  const history = new Map<string, unknown>()
  const step = {
    async run<T>(config: { name: string }, fn: () => Promise<T>): Promise<T> {
      if (history.has(config.name)) return history.get(config.name) as T
      const output = await fn()
      history.set(config.name, output)
      return output
    },
    async sleep(name: string): Promise<void> {
      if (history.has(name)) return
      clock.now += 60_000 + claimDelayMs
      history.set(name, true)
    },
  }
  return { clock, history, step }
}

const alwaysWait = async () => ({
  wait: "An earlier ingestion run of this source publishes to the same Workspace.",
})

describe("waitForPublishTurn", () => {
  it("goes on after 60 minutes of wall time when the worker claims the run late", async () => {
    // Production claimed a woken run about 90 seconds after its sleep ended.
    const { clock, step } = engine(90_000)
    const startedAt = new Date(clock.now)

    const wait = await waitForPublishTurn({
      step,
      startedAt,
      check: alwaysWait,
      now: () => clock.now,
    })

    expect(wait.outcome).toBe("deadline")
    const waited = clock.now - startedAt.getTime()
    expect(waited).toBeGreaterThanOrEqual(PUBLISH_TURN_WAIT_MS)
    expect(waited).toBeLessThan(PUBLISH_TURN_WAIT_MS + 3 * 60_000)
    // A count of 60 checks would have waited 2.5 hours here.
    expect(wait.checks).toBeLessThan(30)
  })

  it("starts work at once when no earlier run publishes to the Workspace", async () => {
    const { clock, step } = engine(0)
    const startedAt = new Date(clock.now)

    const wait = await waitForPublishTurn({
      step,
      startedAt,
      check: async () => ({ turn: true }),
      now: () => clock.now,
    })

    expect(wait).toEqual({ outcome: "turn", checks: 1 })
    expect(clock.now).toBe(startedAt.getTime())
  })

  it("takes the recorded path on a replay, and a replay does not move the deadline", async () => {
    const { clock, step } = engine(90_000)
    const startedAt = new Date(clock.now)
    let turnAfter = 3
    const check = async () =>
      turnAfter-- > 0 ? alwaysWait() : ({ turn: true } as const)
    const first = await waitForPublishTurn({
      step,
      startedAt,
      check,
      now: () => clock.now,
    })

    // The worker replays the run much later, past the deadline.
    clock.now += 2 * PUBLISH_TURN_WAIT_MS
    const replay = await waitForPublishTurn({
      step,
      startedAt,
      check: alwaysWait,
      now: () => clock.now,
    })

    expect(first).toEqual({ outcome: "turn", checks: 4 })
    expect(replay).toEqual(first)
  })

  it("stops at once when a newer run of the source replaces the run, also on a replay (CTX-1040)", async () => {
    const { clock, step } = engine(90_000)
    const startedAt = new Date(clock.now)
    let waitFor = 2
    const check = async (): Promise<
      { wait: string } | { superseded: string }
    > => (waitFor-- > 0 ? alwaysWait() : { superseded: "run_newer" })
    const first = await waitForPublishTurn({
      step,
      startedAt,
      check,
      now: () => clock.now,
    })
    const afterFirst = clock.now

    // A replay takes the recorded checks: no new check, and no sleep.
    const replay = await waitForPublishTurn({
      step,
      startedAt,
      check: async () => ({ turn: true }),
      now: () => clock.now,
    })

    expect(first).toEqual({
      outcome: "superseded",
      checks: 3,
      newerRunId: "run_newer",
    })
    expect(replay).toEqual(first)
    expect(clock.now).toBe(afterFirst)
  })

  it("stops at the first stored deadline when a step retry moves startedAt", async () => {
    const { clock, step } = engine(0)
    const startedAt = new Date(clock.now)
    await waitForPublishTurn({
      step,
      startedAt,
      check: alwaysWait,
      now: () => clock.now,
    })
    const firstEnd = clock.now

    // A retry set startedAt 30 minutes later; the run replays from history.
    const replay = await waitForPublishTurn({
      step,
      startedAt: new Date(startedAt.getTime() + 30 * 60_000),
      check: alwaysWait,
      now: () => clock.now,
    })

    expect(replay.outcome).toBe("deadline")
    expect(clock.now).toBe(firstEnd)
    expect(firstEnd - startedAt.getTime()).toBe(PUBLISH_TURN_WAIT_MS)
  })

  it("stops at the first deadline when the first check throws once and startedAt moves later", async () => {
    const { clock, step } = engine(0)
    const startedAt = new Date(clock.now)
    let calls = 0
    const check = async () => {
      if (calls++ === 0) throw new Error("database unavailable")
      return alwaysWait()
    }
    const options = { step, check, now: () => clock.now }
    await expect(waitForPublishTurn({ ...options, startedAt })).rejects.toThrow(
      "database unavailable",
    )

    // The engine retries the run 30 minutes later and resets startedAt.
    clock.now += 30 * 60_000
    const retryStart = new Date(clock.now)
    const retry = await waitForPublishTurn({
      ...options,
      startedAt: retryStart,
    })

    expect(retry.outcome).toBe("deadline")
    expect(clock.now).toBe(startedAt.getTime() + PUBLISH_TURN_WAIT_MS)
  })

  it("keeps waiting on a recorded check from before the deadline field, then gives up 60 minutes after the start", async () => {
    const { clock, history, step } = engine(0)
    const begin = clock.now
    // A run that an earlier release started 10 minutes ago.
    history.set("publish-turn:0", { wait: "earlier run" })
    history.set("wait-publish-turn:0", true)

    const wait = await waitForPublishTurn({
      step,
      startedAt: new Date(begin - 10 * 60_000),
      check: alwaysWait,
      now: () => clock.now,
    })

    expect(wait.outcome).toBe("deadline")
    // It kept waiting about 50 more minutes, not 0.
    expect(clock.now - begin).toBe(50 * 60_000)
  })
})
