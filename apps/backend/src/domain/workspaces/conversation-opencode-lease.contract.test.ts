import { createServer } from "node:net"
import { startOpencodeServerInSandbox } from "@tanstack/ai-opencode"
import type {
  ProcessOptions,
  SandboxHandle,
  SpawnHandle,
} from "@tanstack/ai-sandbox"
import { afterEach, describe, expect, it } from "vitest"
import {
  claimUnsandboxedOpencodePort,
  conversationScopedToolBridgeProvisioner,
  releaseConversationOpencodeLease,
  reuseOpencodeServeHandle,
} from "./conversation-opencode-lease.js"
import { withSandboxLifecycleContext } from "./sandbox-lifecycle-timing.js"

const CONVERSATION_ID = "conv_opencode_lease"

afterEach(async () => {
  await releaseConversationOpencodeLease(CONVERSATION_ID)
})

describe("conversation-scoped tool bridge", () => {
  it("keeps one bearer URL and runs the latest execute after close", async () => {
    let seen = ""
    const provisioner = conversationScopedToolBridgeProvisioner(CONVERSATION_ID)
    const first = await provisioner.provision(
      [
        {
          name: "echo_lease",
          description: "Echo a value",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
          execute(args) {
            seen = String((args as { value: string }).value)
            return { from: "first", value: seen }
          },
        },
      ],
      { provider: "local-process" },
    )

    const second = await provisioner.provision(
      [
        {
          name: "echo_lease",
          description: "Echo a value",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
          execute(args) {
            seen = String((args as { value: string }).value)
            return { from: "second", value: seen }
          },
        },
      ],
      { provider: "local-process" },
    )

    expect(second.url).toBe(first.url)
    expect(second.token).toBe(first.token)
    expect(second.name).toBe(first.name)

    await first.close()
    await second.close()

    const response = await fetch(second.url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${second.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "echo_lease", arguments: { value: "after-close" } },
      }),
    })
    expect(response.status).toBe(200)
    const event = (await response.text())
      .split("\n")
      .find((line) => line.startsWith("data: "))
    expect(JSON.parse(event?.slice(6) ?? "null")).toMatchObject({
      result: {
        content: [
          { type: "text", text: '{"from":"second","value":"after-close"}' },
        ],
      },
    })
    expect(seen).toBe("after-close")

    const endpoint = new URL(second.url)
    await releaseConversationOpencodeLease(CONVERSATION_ID)
    const replacement = createServer()
    await new Promise<void>((resolve, reject) => {
      replacement.once("error", reject)
      replacement.listen(Number(endpoint.port), "127.0.0.1", resolve)
    })
    await new Promise<void>((resolve) => replacement.close(() => resolve()))
  })
})

describe("conversation-lifetime opencode serve", () => {
  it("shares one serve PID across two stock adapter starts", async () => {
    let spawns = 0
    let kills = 0
    const sandbox = reuseOpencodeServeHandle(
      fakeServeSandbox(
        () => {
          spawns += 1
          return fakeListeningServe(4242 + spawns, 18000 + spawns)
        },
        () => {
          kills += 1
        },
      ),
      () => CONVERSATION_ID,
    )

    const env = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        mcp: { tanstack: { type: "remote", url: "http://127.0.0.1:9/mcp" } },
      }),
    }
    const first = await withSandboxLifecycleContext(CONVERSATION_ID, () =>
      startOpencodeServerInSandbox(sandbox, {
        port: 18001,
        hostname: "127.0.0.1",
        cwd: ".",
        env,
      }),
    )
    const attachStarted = Date.now()
    const second = await withSandboxLifecycleContext(CONVERSATION_ID, () =>
      startOpencodeServerInSandbox(sandbox, {
        port: 18001,
        hostname: "127.0.0.1",
        cwd: ".",
        env,
      }),
    )
    const attachMs = Date.now() - attachStarted

    expect(spawns).toBe(1)
    expect(attachMs).toBeLessThan(500)
    expect(new URL(first.baseUrl).port).toBe(new URL(second.baseUrl).port)
    await first.dispose()
    await second.dispose()
    expect(kills).toBe(0)

    await releaseConversationOpencodeLease(CONVERSATION_ID)
    expect(kills).toBe(1)
  })

  it("reuses the unsandboxed listen port for the same conversation", async () => {
    const first = await claimUnsandboxedOpencodePort(CONVERSATION_ID)
    const second = await claimUnsandboxedOpencodePort(CONVERSATION_ID)
    expect(second).toBe(first)
    expect(first).toBeGreaterThan(0)
  })
})

function fakeListeningServe(pid: number, port: number): SpawnHandle {
  const ready = `opencode server listening on http://127.0.0.1:${port}\n`
  return {
    pid,
    stdout: (async function* () {
      yield ready
    })(),
    stderr: (async function* () {})(),
    stdin: {
      write: async () => undefined,
      end: async () => undefined,
    },
    wait: () => new Promise(() => undefined),
    kill: async () => undefined,
  }
}

function fakeServeSandbox(
  spawn: (command: string, options?: ProcessOptions) => SpawnHandle,
  onRealKill: () => void,
): SandboxHandle {
  return {
    id: "sbx_lease",
    provider: "local-process",
    workspaceRoot: "/tmp",
    capabilities: {
      fs: true,
      exec: true,
      env: true,
      ports: true,
      backgroundProcesses: true,
      writableStdin: true,
    },
    fs: {} as SandboxHandle["fs"],
    git: {} as SandboxHandle["git"],
    env: { set: async () => undefined },
    ports: {
      connect: async (port: number) => ({
        url: `http://127.0.0.1:${port}`,
        close: async () => undefined,
      }),
    },
    process: {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      spawn: async (command: string, options?: ProcessOptions) => {
        const proc = spawn(command, options)
        return {
          ...proc,
          kill: async () => {
            onRealKill()
            await proc.kill()
          },
        }
      },
    },
    destroy: async () => undefined,
  } as unknown as SandboxHandle
}
