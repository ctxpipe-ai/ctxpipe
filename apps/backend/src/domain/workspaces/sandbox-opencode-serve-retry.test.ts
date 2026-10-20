import type { SandboxHandle, SandboxProvider } from "@tanstack/ai-sandbox"
import { describe, expect, it } from "vitest"
import { withOpencodeServeRetry } from "./sandbox-process-guards.js"

async function* lines(...chunks: string[]) {
  for (const chunk of chunks) yield chunk
}

/** A stand-in `opencode serve`: each start gets the next scripted outcome. */
function standIn(outcomes: Array<{ stdout: string[]; stderr: string[] }>) {
  const commands: string[] = []
  const connected: number[] = []
  const handle = {
    process: {
      spawn: async (command: string) => {
        commands.push(command)
        const outcome = outcomes[commands.length - 1]
        if (!outcome) throw new Error("Unexpected extra start")
        return {
          pid: commands.length,
          stdin: { write: async () => undefined, end: async () => undefined },
          stdout: lines(...outcome.stdout),
          stderr: lines(...outcome.stderr),
          wait: async () => 0,
          kill: async () => undefined,
        }
      },
    },
    ports: {
      connect: async (port: number) => {
        connected.push(port)
        return { url: `http://127.0.0.1:${port}` }
      },
    },
    destroy: async () => undefined,
  } as unknown as SandboxHandle
  const provider = {
    name: "stand-in",
    capabilities: () => ({}),
    create: async () => handle,
    resume: async () => handle,
    destroy: async () => undefined,
  } as unknown as SandboxProvider
  return { provider, commands, connected }
}

async function start(provider: SandboxProvider, freePorts: number[]) {
  const handle = await withOpencodeServeRetry(
    provider,
    async () => freePorts.shift() ?? 0,
  ).create({} as never)
  const proc = await handle.process.spawn(
    "opencode serve --hostname=127.0.0.1 --port=4001",
  )
  let out = ""
  for await (const chunk of proc.stdout) out += chunk
  let err = ""
  for await (const chunk of proc.stderr) err += chunk
  return { handle, out, err }
}

describe("withOpencodeServeRetry", () => {
  it("starts again on a fresh port when the first port is in use, and connects to the new port", async () => {
    const { provider, commands, connected } = standIn([
      { stdout: [], stderr: ["Error: listen EADDRINUSE: 127.0.0.1:4001"] },
      {
        stdout: ["opencode server listening on http://127.0.0.1:5002"],
        stderr: [],
      },
    ])
    const { handle, out } = await start(provider, [5002])
    expect(commands).toEqual([
      "opencode serve --hostname=127.0.0.1 --port=4001",
      "opencode serve --hostname=127.0.0.1 --port=5002",
    ])
    expect(out).toContain("opencode server listening")
    await handle.ports.connect(4001)
    expect(connected).toEqual([5002])
  })

  it("stops after 3 starts and gives the output of the last one", async () => {
    const taken = { stdout: [], stderr: ["listen EADDRINUSE"] }
    const { provider, commands } = standIn([taken, taken, taken])
    const { err } = await start(provider, [5002, 5003])
    expect(commands).toHaveLength(3)
    expect(err).toContain("EADDRINUSE")
  })

  it("starts again when OpenCode 1.18.34 says only ServeError for a taken port", async () => {
    const { provider, commands } = standIn([
      {
        stdout: [
          "Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.\n",
        ],
        stderr: [
          "\u001b[91m\u001b[1mError: \u001b[0mUnexpected error\n\nServeError\n",
        ],
      },
      {
        stdout: ["opencode server listening on http://127.0.0.1:5002"],
        stderr: [],
      },
    ])
    const { out } = await start(provider, [5002])
    expect(commands).toHaveLength(2)
    expect(out).toContain("opencode server listening")
  })

  it("does not start again for another cause, and keeps its output", async () => {
    const { provider, commands } = standIn([
      { stdout: [], stderr: ["Error: Unexpected error\n\nConfigInvalidError"] },
    ])
    const { err } = await start(provider, [5002])
    expect(commands).toHaveLength(1)
    expect(err).toContain("ConfigInvalidError")
  })
})
