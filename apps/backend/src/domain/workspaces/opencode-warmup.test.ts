import type { SandboxHandle, SandboxProvider } from "@tanstack/ai-sandbox"
import { initLogger } from "evlog"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  OPENCODE_WARMUP_COMMAND,
  opencodeWarmupDone,
  withOpencodeWarmup,
} from "./opencode-warmup.js"

const marks: Record<string, unknown>[] = []
beforeAll(() => {
  initLogger({
    env: { service: "ctxpipe-backend", environment: "test" },
    pretty: false,
    drain: (ctx) => {
      const event = ctx.event as Record<string, unknown>
      if (event.step === "sandbox-lifecycle") marks.push(event)
    },
  })
})
afterAll(() => {
  initLogger({ enabled: false })
})

/** A stand-in session whose warm-up ends when the test says so. */
function standIn(id: string) {
  const commands: string[] = []
  let finish: (code: number) => void = () => undefined
  const handle = {
    id,
    process: {
      spawn: async (command: string) => {
        commands.push(command)
        const exited = new Promise<number>((resolve) => {
          finish = resolve
        })
        return { pid: 1, wait: () => exited, kill: async () => undefined }
      },
    },
  } as unknown as SandboxHandle
  const provider = {
    name: "stand-in",
    capabilities: () => ({}),
    create: async () => handle,
    resume: async () => handle,
    destroy: async () => undefined,
  } as unknown as SandboxProvider
  return { provider, commands, finish: (code: number) => finish(code) }
}

describe("the OpenCode warm-up of a new AgentCore session", () => {
  it("starts on create, and the turn waits for it before it stops the agent's processes", async () => {
    const session = standIn("ses-new")
    const handle = await withOpencodeWarmup(session.provider).create({})
    expect(session.commands).toEqual([OPENCODE_WARMUP_COMMAND])

    let waited = false
    const turn = opencodeWarmupDone(handle.id).then(() => {
      waited = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(waited).toBe(false)
    session.finish(0)
    await turn
    expect(marks).toContainEqual(
      expect.objectContaining({ phase: "opencode-warmup", exitCode: 0 }),
    )
    // Done: the next turn does not wait.
    await opencodeWarmupDone(handle.id)
  })

  it("does not run for a resumed session, which already ran OpenCode", async () => {
    const session = standIn("ses-resumed")
    await withOpencodeWarmup(session.provider).resume({ id: "ses-resumed" })
    expect(session.commands).toEqual([])
  })
})
