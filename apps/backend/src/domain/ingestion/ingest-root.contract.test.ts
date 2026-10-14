import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import { afterEach, describe, expect, it, vi } from "vitest"
import { workspaceChatDockerImage } from "../workspaces/chat-runtime.js"
import { dockerRootExec } from "./ingest-root.js"
import { INGEST_STEP_LIMIT_MS, ingestStepSignal } from "./ingest-shard-ops.js"

/*
 * Contract (Docker): a hung step ends at the step limit, and its processes
 * are gone before the exec returns. Only `setTimeout` is fake: the step
 * limit timer. Docker I/O uses Node's internal timers.
 */

afterEach(() => {
  vi.useRealTimers()
})

describe("dockerRootExec with a step limit", () => {
  it(
    "ends the whole process group of a hung agent command at the limit",
    { timeout: 180_000 },
    async () => {
      const provider = dockerSandbox({ image: workspaceChatDockerImage() })
      const handle = await provider.create({
        id: `ingest-root-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      })
      try {
        const root = dockerRootExec(handle.id)
        const count = async () =>
          Number(
            (
              await root(
                "ps -eo args | grep -c '^sleep 86[4]00' || true",
              )
            ).stdout.trim(),
          )
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
        const signal = ingestStepSignal()
        // An agent command with a child in the background, as `opencode run`
        // starts its own children.
        const hung = root(
          "runuser -u node -- sh -c 'sleep 86400 & sleep 86400'",
          { signal },
        )
        const outcome = hung.then(
          () => "finished",
          (error: Error) => error.message,
        )
        while ((await count()) < 2) {}
        vi.advanceTimersByTime(INGEST_STEP_LIMIT_MS - 1)
        expect(signal.aborted).toBe(false)
        vi.advanceTimersByTime(1)
        expect(await outcome).toBe("The ingest step reached its time limit")
        expect(await count()).toBe(0)
      } finally {
        vi.useRealTimers()
        await provider.destroy({ id: handle.id })
      }
    },
  )
})
