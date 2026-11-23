import type {
  SandboxHandle,
  SandboxProvider as TanstackSandboxProvider,
} from "@tanstack/ai-sandbox"
import { afterEach, describe, expect, it, vi } from "vitest"

import { withProxyCa } from "./sandbox-provider.js"

// The sandbox is the environment: a provider whose sandboxes record each
// command, as a remote sandbox runs it.
function recordingProvider() {
  const commands: string[] = []
  const handle = (id: string) =>
    ({
      id,
      process: {
        exec: async (command: string) => {
          commands.push(`${id}: ${command}`)
          return { exitCode: 0, stdout: "", stderr: "" }
        },
      },
      destroy: async () => undefined,
    }) as unknown as SandboxHandle
  let created = 0
  const provider = {
    name: "recording",
    capabilities: () => ({}),
    create: async () => handle(`sbx-${++created}`),
    resume: async ({ id }: { id: string }) => handle(id),
    destroy: async () => undefined,
  } as unknown as TanstackSandboxProvider
  const caWrites = (id: string) =>
    commands.filter(
      (command) =>
        command.startsWith(`${id}: `) && command.includes("BEGIN CERT"),
    ).length
  return { provider, caWrites }
}

const CA = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----"

describe("withProxyCa", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("lets the first attach after a create skip the CA write, and only that one", async () => {
    const { provider, caWrites } = recordingProvider()
    const withCa = withProxyCa(provider, CA)

    const created = await withCa.create({})
    expect(caWrites(created.id)).toBe(1)

    await withCa.resume({ id: created.id })
    expect(caWrites(created.id)).toBe(1)

    // The agent may have removed the file during the turn.
    await withCa.resume({ id: created.id })
    await withCa.resume({ id: created.id })
    expect(caWrites(created.id)).toBe(3)
  })

  it("writes the CA on an attach 60 s after the create", async () => {
    vi.useFakeTimers()
    const { provider, caWrites } = recordingProvider()
    const withCa = withProxyCa(provider, CA)

    const created = await withCa.create({})
    vi.advanceTimersByTime(60_000)
    await withCa.resume({ id: created.id })

    expect(caWrites(created.id)).toBe(2)
  })

  it("writes another CA on the attach after a create", async () => {
    const { provider, caWrites } = recordingProvider()

    const created = await withProxyCa(provider, CA).create({})
    await withProxyCa(provider, CA.replace("AAAA", "BBBB")).resume({
      id: created.id,
    })

    expect(caWrites(created.id)).toBe(2)
  })

  it("writes the CA again after an attach with another CA", async () => {
    const { provider, caWrites } = recordingProvider()
    const withCa = withProxyCa(provider, CA)

    const created = await withCa.create({})
    await withProxyCa(provider, CA.replace("AAAA", "BBBB")).resume({
      id: created.id,
    })
    await withCa.resume({ id: created.id })

    expect(caWrites(created.id)).toBe(3)
  })
})
