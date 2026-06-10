/**
 * Live integration tests against pinned @agentmemory/agentmemory (agentmemory
 * `npm run test:integration` analogue).
 *
 * Ported from upstream integration.test.ts:
 *   - health / livez readiness
 *   - POST /agentmemory/search after import
 *   - auth bearer when AGENTMEMORY_SECRET is set
 *
 * Skipped upstream blocks (not ctxpipe MCP surface): session/observe lifecycle,
 * viewer, context, semantic/procedural/relations dashboards.
 *
 * ctxpipe-only: MCP stdio memory_save → .ai/memory, memory_recall source,
 * repo isolation, hydration via supervisor.
 *
 * Run: pnpm --filter ctxpipe test:memory:integration
 * Default `pnpm --filter ctxpipe test` excludes this file.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  agentMemoryImport,
  agentMemorySearch,
  agentMemoryLiveZ,
} from "../../src/memory/agentmemory-client.js"
import {
  buildImportPayload,
  scanMemoryTree,
} from "../../src/memory/hydration.js"
import { createMcpServer } from "../../src/memory/mcp-server.js"
import {
  createSupervisor,
  PINNED_AGENTMEMORY_VERSION,
  type RuntimeState,
  type Supervisor,
} from "../../src/memory/supervisor.js"
import { detectRepoFingerprint, resolveMemoryRoot } from "../../src/memory/paths.js"
import { jsonRpc, getToolResult, toolPayload } from "./memory-test-helpers.js"
import {
  assertCanonicalFile,
  seedMarkdown,
  seedRepoConfig,
  tmpDir,
} from "./memory-test-helpers.js"

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const BIN = join(PKG_ROOT, "bin", "ctxpipe.js")

const EXTERNAL_URL = process.env.AGENTMEMORY_URL?.replace(/\/$/, "")
const EXTERNAL_SECRET = process.env.AGENTMEMORY_SECRET || undefined

type RpcResponse = {
  id: number
  result?: unknown
  error?: { message: string }
}

function integrationHint(): string {
  return (
    "Memory integration requires a running AgentMemory server. " +
    "Either set AGENTMEMORY_URL to an existing server or allow this test to spawn " +
    `npx @agentmemory/agentmemory@${PINNED_AGENTMEMORY_VERSION} (needs network on first npx). ` +
    "When spawning, AgentMemory's iii-http worker still requires loopback port 3111 to be free."
  )
}

function isLoopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once("error", () => resolve(false))
    srv.listen({ port, host: "127.0.0.1" }, () => {
      srv.close(() => resolve(true))
    })
  })
}

function mcpRpcClient(child: ChildProcessWithoutNullStreams) {
  let buffer = ""
  let nextId = 1
  const inflight = new Map<
    number,
    { resolve: (v: RpcResponse) => void; reject: (e: Error) => void }
  >()
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk)
    let nl = buffer.indexOf("\n")
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf("\n")
      if (!line) continue
      try {
        const json = JSON.parse(line) as RpcResponse
        const h = inflight.get(json.id)
        if (h) {
          inflight.delete(json.id)
          h.resolve(json)
        }
      } catch {
        // ignore
      }
    }
  })
  return {
    call(method: string, params?: unknown, timeoutMs = 60_000) {
      const id = nextId++
      return new Promise<RpcResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          inflight.delete(id)
          reject(new Error(`Timed out on ${method}`))
        }, timeoutMs)
        inflight.set(id, {
          resolve: (v) => {
            clearTimeout(timer)
            resolve(v)
          },
          reject: (e) => {
            clearTimeout(timer)
            reject(e)
          },
        })
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
      })
    },
    notify(method: string, params?: unknown) {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
      )
    },
  }
}

const SKIP_SPAWN_MESSAGE =
  "Port 3111 is in use (AgentMemory default iii-http port). " +
  "Stop the other process, set AGENTMEMORY_URL to an existing server, " +
  "or run integration on CI where the port is free."

describe("memory/integration-agentmemory", () => {
  let cwd: string
  let stateRoot: string
  let runtime: RuntimeState | undefined
  let initError: string | undefined
  let supervisor: Supervisor | null = null
  let mcpChild: ChildProcessWithoutNullStreams | null = null

  function skipUnlessReady(ctx: { skip: (note?: string) => never }): asserts runtime is RuntimeState {
    if (initError) ctx.skip(initError)
    if (!runtime) ctx.skip(SKIP_SPAWN_MESSAGE)
  }

  beforeAll(async () => {
    if (!EXTERNAL_URL && !(await isLoopbackPortFree(3111))) {
      initError = SKIP_SPAWN_MESSAGE
      return
    }
    process.env.CI = "true"
    cwd = tmpDir("ctxpipe-am-integ-cwd-")
    stateRoot = tmpDir("ctxpipe-am-integ-state-")
    process.env.CTXPIPE_MEMORY_STATE_ROOT = stateRoot
    seedRepoConfig(cwd, { orgSlug: "acme" })
    seedMarkdown(cwd, [
      {
        id: "integ-seed",
        type: "pattern",
        body: "integration seed memory for real AgentMemory",
      },
    ])

    if (EXTERNAL_URL) {
      const health = await fetch(`${EXTERNAL_URL}/agentmemory/health`).catch(
        () => null,
      )
      if (!health?.ok) {
        initError = `${integrationHint()} (AGENTMEMORY_URL not reachable)`
        return
      }
      const live = await agentMemoryLiveZ(EXTERNAL_URL)
      if (!live) {
        initError = `${integrationHint()} (livez failed at ${EXTERNAL_URL})`
        return
      }
      runtime = {
        provider: "agentmemory",
        agentmemoryVersion: PINNED_AGENTMEMORY_VERSION,
        url: EXTERNAL_URL,
        viewerUrl: EXTERNAL_URL,
        pid: -1,
        startedAt: new Date().toISOString(),
        mode: "local-only",
        hostedModel: "signed-out",
        ports: { rest: 0, streams: 0, viewer: 0, engineWs: 0 },
        secret: EXTERNAL_SECRET,
      }
    } else {
      const fingerprint = detectRepoFingerprint(cwd)
      supervisor = createSupervisor({
        fingerprint,
        readinessTimeoutMs: 180_000,
      })
      try {
        runtime = await supervisor.ensureRunning()
      } catch (err) {
        initError = `${integrationHint()} (${err instanceof Error ? err.message : String(err)})`
        return
      }
      const live = await agentMemoryLiveZ(runtime.url)
      if (!live) {
        initError = `${integrationHint()} (livez failed at ${runtime.url})`
        return
      }
    }

    const scan = scanMemoryTree(resolveMemoryRoot(cwd))
    await agentMemoryImport({
      url: runtime.url,
      secret: runtime.secret,
      payload: buildImportPayload({
        strategy: "replace",
        records: scan.records,
        deletedIds: [],
        agentmemoryVersion: PINNED_AGENTMEMORY_VERSION,
      }),
    })
  }, 200_000)

  afterAll(async () => {
    if (mcpChild) {
      try {
        mcpChild.kill("SIGTERM")
      } catch {
        // ignored
      }
    }
    if (supervisor) {
      await supervisor.stop().catch(() => {})
    }
    delete process.env.CTXPIPE_MEMORY_STATE_ROOT
  })

  it("health endpoint responds", async (ctx) => {
    skipUnlessReady(ctx)
    const res = await fetch(`${runtime.url}/agentmemory/health`)
    expect(res.ok).toBe(true)
  })

  it("search finds imported Markdown after direct import", async (ctx) => {
    skipUnlessReady(ctx)
    const hits = await agentMemorySearch({
      url: runtime.url,
      secret: runtime.secret,
      query: "integration seed memory",
      project: "acme",
      cwd,
      limit: 5,
    })
    expect(hits.length).toBeGreaterThan(0)
    const ids = hits.map((h) => h.id)
    expect(
      ids.some((id) => id.includes("integ-seed") || id.includes("ctxpipe_integ-seed")),
    ).toBe(true)
  })

  it("rejects unauthenticated search when secret is configured", async (ctx) => {
    skipUnlessReady(ctx)
    if (!runtime.secret) return
    const res = await fetch(`${runtime.url}/agentmemory/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "test", project: "acme", cwd }),
    })
    expect(res.status).toBe(401)
  })

  it("MCP memory_save writes .ai/memory and recall uses agentmemory", async (ctx) => {
    skipUnlessReady(ctx)
    const stubSupervisor: Supervisor = {
      async ensureRunning() {
        return runtime
      },
      async stop() {
        return false
      },
      current() {
        return runtime
      },
    }

    if (EXTERNAL_URL) {
      const server = createMcpServer({
        baseUrl: "http://127.0.0.1:0",
        cwd,
        supervisor: stubSupervisor,
      })
      const save = await server.handle(
        jsonRpc(1, "tools/call", {
          name: "memory_save",
          arguments: {
            id: "integ-mcp-save",
            type: "lesson",
            body: "Written via real AgentMemory integration MCP test.",
          },
        }),
      )
      expect(getToolResult(save).isError).toBeFalsy()
      assertCanonicalFile(cwd, {
        id: "integ-mcp-save",
        type: "lesson",
        bodyContains: "integration MCP test",
      })
      const recall = await server.handle(
        jsonRpc(2, "tools/call", {
          name: "memory_recall",
          arguments: { query: "integration MCP" },
        }),
      )
      const recallBody = toolPayload(getToolResult(recall)) as {
        source: string
        matches: Array<{ id: string }>
      }
      expect(recallBody.source).toBe("agentmemory")
      return
    }

    mcpChild = spawn(
      process.execPath,
      [BIN, "memory", "mcp", "--base-url", "http://127.0.0.1:0"],
      {
        cwd,
        env: {
          ...process.env,
          CTXPIPE_MEMORY_STATE_ROOT: stateRoot,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    ) as ChildProcessWithoutNullStreams

    const rpc = mcpRpcClient(mcpChild)
    await rpc.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest-integration", version: "1.0.0" },
    })
    rpc.notify("notifications/initialized", {})

    const save = await rpc.call("tools/call", {
      name: "memory_save",
      arguments: {
        id: "integ-mcp-save",
        type: "lesson",
        title: "Integration MCP Save",
        body: "Written via real AgentMemory integration MCP stdio test.",
      },
    })
    const saveBody = JSON.parse(
      (save.result as { content?: Array<{ text: string }> })?.content?.[0]
        ?.text ?? "{}",
    ) as { status: string }
    expect(saveBody.status).toBe("saved")
    assertCanonicalFile(cwd, {
      id: "integ-mcp-save",
      type: "lesson",
      bodyContains: "integration MCP stdio",
    })

    const recall = await rpc.call("tools/call", {
      name: "memory_recall",
      arguments: { query: "integration MCP stdio" },
    })
    const recallBody = JSON.parse(
      (recall.result as { content?: Array<{ text: string }> })?.content?.[0]
        ?.text ?? "{}",
    ) as { source: string; matches: Array<{ id: string }> }
    expect(recallBody.source).toBe("agentmemory")
    expect(
      recallBody.matches.some((m) => String(m.id).includes("integ-mcp-save")),
    ).toBe(true)

    mcpChild.kill("SIGTERM")
    mcpChild = null
  }, 90_000)

  it("two repos do not share search results", async (ctx) => {
    skipUnlessReady(ctx)
    const cwdB = tmpDir("ctxpipe-am-integ-b-")
    seedRepoConfig(cwdB, { orgSlug: "globex" })
    seedMarkdown(cwdB, [
      { id: "repo-b-only", type: "pattern", body: "repo b exclusive memory" },
    ])

    const scanB = scanMemoryTree(resolveMemoryRoot(cwdB))
    await agentMemoryImport({
      url: runtime.url,
      secret: runtime.secret,
      payload: buildImportPayload({
        strategy: "merge",
        records: scanB.records,
        deletedIds: [],
        agentmemoryVersion: PINNED_AGENTMEMORY_VERSION,
      }),
    })

    const hitsA = await agentMemorySearch({
      url: runtime.url,
      secret: runtime.secret,
      query: "repo b exclusive",
      project: "acme",
      cwd,
      limit: 5,
    })
    expect(
      hitsA.every((h) => !String(h.content).includes("repo b exclusive")),
    ).toBe(true)

    const hitsB = await agentMemorySearch({
      url: runtime.url,
      secret: runtime.secret,
      query: "repo b exclusive",
      project: "globex",
      cwd: cwdB,
      limit: 5,
    })
    expect(hitsB.length).toBeGreaterThan(0)
  })
})
