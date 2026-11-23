import type { SandboxHandle, SandboxProvider } from "@tanstack/ai-sandbox"
import { initLogger } from "evlog"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  OPENCODE_WARMUP_COMMAND,
  waitForOpencodeWarmup,
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
  const provider: SandboxProvider = {
    name: "stand-in",
    capabilities: () => {
      throw new Error("The warm-up reads no capability")
    },
    create: async () => handle,
    resume: async () => handle,
    destroy: async () => undefined,
  }
  return { provider, commands, finish: (code: number) => finish(code) }
}

describe("the OpenCode warm-up of a new AgentCore session", () => {
  it("starts on create, and a wait for it ends when the warm-up ends", async () => {
    const session = standIn("ses-new")
    const handle = await withOpencodeWarmup(session.provider).create({})
    expect(session.commands).toEqual([OPENCODE_WARMUP_COMMAND])

    let waited = false
    const fill = waitForOpencodeWarmup(handle.id).then(() => {
      waited = true
    })
    // Let every pending step run: the pool fill still waits.
    for (let step = 0; step < 10; step++) await Promise.resolve()
    expect(waited).toBe(false)
    session.finish(0)
    await fill
    expect(marks).toContainEqual(
      expect.objectContaining({ phase: "opencode-warmup", exitCode: 0 }),
    )
    // Done: a later wait does not wait.
    await waitForOpencodeWarmup(handle.id)
  })

  it("does not run for a resumed session, which already ran OpenCode", async () => {
    const session = standIn("ses-resumed")
    await withOpencodeWarmup(session.provider).resume({ id: "ses-resumed" })
    expect(session.commands).toEqual([])
  })
})
