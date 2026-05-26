import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const THIS_FILE_DIR = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(THIS_FILE_DIR, "..", "..")
const BIN = join(PKG_ROOT, "bin", "ctxpipe.js")
const FAKE = join(THIS_FILE_DIR, "fixtures", "fake-agentmemory.cjs")

type RpcResponse = {
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

type ToolText = { type: "text"; text: string }

type ToolResult = { content: ToolText[]; isError?: boolean }

function newRpcClient(child: ChildProcessWithoutNullStreams): {
  call: (
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ) => Promise<RpcResponse>
  notify: (method: string, params?: unknown) => void
  stderr: () => string
} {
  let buffer = ""
  let nextId = 1
  const inflight = new Map<
    number,
    { resolve: (value: RpcResponse) => void; reject: (err: Error) => void }
  >()
  let stderrText = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk) => {
    stderrText += String(chunk)
  })
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk)
    let newline = buffer.indexOf("\n")
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf("\n")
      if (line.length === 0) continue
      try {
        const json = JSON.parse(line) as RpcResponse
        const handler = inflight.get(json.id)
        if (handler) {
          inflight.delete(json.id)
          handler.resolve(json)
        }
      } catch {
        // ignore parse errors from notifications etc
      }
    }
  })
  child.on("exit", () => {
    for (const handler of inflight.values()) {
      handler.reject(new Error(`mcp child exited: ${stderrText}`))
    }
    inflight.clear()
  })

  return {
    call(method, params, timeoutMs = 8_000) {
      const id = nextId++
      const message = { jsonrpc: "2.0", id, method, params }
      return new Promise<RpcResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          inflight.delete(id)
          reject(new Error(`Timed out waiting for ${method} (${stderrText})`))
        }, timeoutMs)
        inflight.set(id, {
          resolve: (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          reject: (err) => {
            clearTimeout(timer)
            reject(err)
          },
        })
        child.stdin.write(`${JSON.stringify(message)}\n`)
      })
    },
    notify(method, params) {
      const message = { jsonrpc: "2.0", method, params }
      child.stdin.write(`${JSON.stringify(message)}\n`)
    },
    stderr: () => stderrText,
  }
}

function spawnMemoryMcp(env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    [BIN, "memory", "mcp", "--base-url", "http://127.0.0.1:0"],
    {
      env: { ...env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  ) as ChildProcessWithoutNullStreams
}

function getToolResult(response: RpcResponse): ToolResult {
  return (response.result ?? { content: [] }) as ToolResult
}

function payload(result: ToolResult): unknown {
  return JSON.parse(result.content[0]?.text ?? "{}")
}

describe("memory/mcp-stdio (end-to-end CLI binary)", () => {
  let cwd: string
  let stateRoot: string
  let home: string
  let stoppers: Array<() => void> = []

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "ctxpipe-cli-cwd-"))
    stateRoot = mkdtempSync(join(tmpdir(), "ctxpipe-cli-state-"))
    home = mkdtempSync(join(tmpdir(), "ctxpipe-cli-home-"))
    // Seed a repo config so orgSlug is populated
    mkdirSync(join(cwd, ".ctxpipe"), { recursive: true })
    writeFileSync(
      join(cwd, ".ctxpipe", "config.json"),
      JSON.stringify({
        orgSlug: "acme",
        baseUrl: "http://127.0.0.1:0",
        memory: { provider: "agentmemory", enabled: true, memoryRoot: ".ai/memory" },
      }),
      "utf8",
    )
  })

  afterEach(() => {
    for (const stop of stoppers) {
      try {
        stop()
      } catch {
        // ignored
      }
    }
    stoppers = []
  })

  it("signed-out save+recall round-trip writes canonical Markdown and returns it", async () => {
    const child = spawnMemoryMcp({
      ...process.env,
      HOME: home,
      CTXPIPE_MEMORY_STATE_ROOT: stateRoot,
      CTXPIPE_MEMORY_DISABLE_SUPERVISOR: "1",
      // Run in the seeded cwd
      PWD: cwd,
    })
    child.on("error", () => {})
    stoppers.push(() => child.kill("SIGTERM"))

    // Workaround for child not honouring PWD: chdir via initial cwd option.
    child.kill("SIGTERM")
    const realChild = spawn(
      process.execPath,
      [BIN, "memory", "mcp", "--base-url", "http://127.0.0.1:0"],
      {
        env: {
          ...process.env,
          HOME: home,
          CTXPIPE_MEMORY_STATE_ROOT: stateRoot,
          CTXPIPE_MEMORY_DISABLE_SUPERVISOR: "1",
        },
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ) as ChildProcessWithoutNullStreams
    realChild.on("error", () => {})
    stoppers.push(() => realChild.kill("SIGTERM"))
    const rpc = newRpcClient(realChild)

    const init = await rpc.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest", version: "1.0.0" },
    })
    const initResult = init.result as { serverInfo?: { name?: string } }
    expect(initResult.serverInfo?.name).toBe("ctxpipe-memory")
    rpc.notify("notifications/initialized", {})

    const tools = await rpc.call("tools/list")
    const toolList = (tools.result as { tools: Array<{ name: string }> }).tools
    expect(toolList.map((t) => t.name)).toContain("memory_save")
    expect(toolList.map((t) => t.name)).toContain("memory_recall")
    expect(toolList.map((t) => t.name)).not.toContain("memory_export")

    const save = await rpc.call("tools/call", {
      name: "memory_save",
      arguments: {
        id: "auth-session-refresh",
        type: "architecture",
        title: "Auth Session Refresh",
        body: "Better Auth session refresh details for the backend.",
        concepts: ["auth", "sessions"],
        files: ["apps/backend/src/auth.ts"],
      },
    })
    const saveResult = getToolResult(save)
    expect(saveResult.isError).toBeFalsy()
    const saveBody = payload(saveResult) as { status: string; id: string }
    expect(saveBody.status).toBe("saved")
    expect(saveBody.id).toBe("auth-session-refresh")

    const file = join(
      cwd,
      ".ai",
      "memory",
      "architecture",
      "auth-session-refresh.md",
    )
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, "utf8")).toContain("id: auth-session-refresh")

    const recall = await rpc.call("tools/call", {
      name: "memory_recall",
      arguments: { query: "session refresh" },
    })
    const recallResult = getToolResult(recall)
    expect(recallResult.isError).toBeFalsy()
    const recallBody = payload(recallResult) as {
      source: string
      matches: Array<{ id: string; title: string }>
    }
    expect(recallBody.source).toBe("markdown-fallback")
    expect(recallBody.matches[0]?.id).toBe("auth-session-refresh")

    realChild.kill("SIGTERM")
  })

  it("speaks MCP against a fake AgentMemory runtime when wired via env", async () => {
    const child = spawn(
      process.execPath,
      [BIN, "memory", "mcp", "--base-url", "http://127.0.0.1:0"],
      {
        env: {
          ...process.env,
          HOME: home,
          CTXPIPE_MEMORY_STATE_ROOT: stateRoot,
          CTXPIPE_MEMORY_AGENTMEMORY_COMMAND: process.execPath,
          CTXPIPE_MEMORY_AGENTMEMORY_ARGS: FAKE,
        },
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ) as ChildProcessWithoutNullStreams
    child.on("error", () => {})
    stoppers.push(() => child.kill("SIGTERM"))
    const rpc = newRpcClient(child)

    await rpc.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest", version: "1.0.0" },
    })
    rpc.notify("notifications/initialized", {})

    const save = await rpc.call(
      "tools/call",
      {
        name: "memory_save",
        arguments: {
          id: "fake-roundtrip",
          type: "pattern",
          title: "Fake Roundtrip",
          body: "Round trip via the fake AgentMemory binary.",
        },
      },
      15_000,
    )
    expect(getToolResult(save).isError).toBeFalsy()

    const recall = await rpc.call(
      "tools/call",
      {
        name: "memory_recall",
        arguments: { query: "fake roundtrip" },
      },
      15_000,
    )
    const body = payload(getToolResult(recall)) as {
      source: string
      matches: Array<{ id: string }>
    }
    expect(body.source).toBe("agentmemory")
    expect(body.matches.map((m) => m.id)).toContain("ctxpipe_fake-roundtrip")

    child.kill("SIGTERM")
  })
})
