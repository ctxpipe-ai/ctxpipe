import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  createMcpServer,
  type JsonRpcRequest,
  type ToolResult,
} from "../../src/memory/mcp-server.js"
import type { Supervisor, RuntimeState } from "../../src/memory/supervisor.js"

function tmp(prefix = "ctxpipe-policy-"): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function jsonRpc(id: number, method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params }
}

function getToolResult(response: unknown): ToolResult {
  const r = response as { result?: { content?: ToolResult["content"]; isError?: boolean } }
  return {
    content: r.result?.content ?? [],
    isError: r.result?.isError ?? false,
  }
}

function payload(result: ToolResult): unknown {
  const text = result.content[0]?.text ?? ""
  return JSON.parse(text)
}

function seedRepoConfig(cwd: string, opts: { orgSlug?: string } = {}): void {
  const dir = join(cwd, ".ctxpipe")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      orgSlug: opts.orgSlug ?? "acme",
      baseUrl: "http://127.0.0.1:0",
      memory: { provider: "agentmemory", enabled: true, memoryRoot: ".ai/memory" },
    }),
    "utf8",
  )
}

function fakeSupervisor(runtime: RuntimeState | null): Supervisor {
  let state: RuntimeState | null = runtime
  return {
    async ensureRunning() {
      if (!state) throw new Error("not configured")
      return state
    },
    async stop() {
      state = null
      return true
    },
    current() {
      return state
    },
  }
}

describe("memory/policy proxy", () => {
  let cwd: string
  beforeEach(() => {
    cwd = tmp()
    process.env.CTXPIPE_MEMORY_STATE_ROOT = tmp("ctxpipe-state-")
    seedRepoConfig(cwd)
  })
  afterEach(() => {
    delete process.env.CTXPIPE_MEMORY_STATE_ROOT
  })

  it("lists only non-hidden tools", async () => {
    const server = createMcpServer({
      baseUrl: "http://127.0.0.1:0",
      cwd,
      startSupervisor: false,
    })
    const response = await server.handle(jsonRpc(1, "tools/list"))
    const tools = (response as { result?: { tools?: Array<{ name: string }> } })
      .result?.tools
    expect(tools).toBeDefined()
    if (!tools) return
    const names = tools.map((t) => t.name).sort()
    expect(names).toContain("memory_save")
    expect(names).toContain("memory_recall")
    expect(names).toContain("memory_status")
    expect(names).not.toContain("memory_export")
    expect(names).not.toContain("memory_governance_delete")
  })

  it("memory_save writes a canonical Markdown file before hydrating", async () => {
    const server = createMcpServer({
      baseUrl: "http://127.0.0.1:0",
      cwd,
      startSupervisor: false,
      supervisor: fakeSupervisor(null),
    })
    const response = await server.handle(
      jsonRpc(1, "tools/call", {
        name: "memory_save",
        arguments: {
          id: "auth-session-refresh",
          type: "architecture",
          title: "Auth Session Refresh",
          body: "We refresh Better Auth sessions through ...",
          concepts: ["auth", "sessions"],
          files: ["apps/backend/src/auth.ts"],
        },
      }),
    )
    const result = getToolResult(response)
    expect(result.isError).toBeFalsy()
    const body = payload(result) as { status: string; id: string }
    expect(body.status).toBe("saved")
    expect(body.id).toBe("auth-session-refresh")
    const file = join(
      cwd,
      ".ai",
      "memory",
      "architecture",
      "auth-session-refresh.md",
    )
    const text = readFileSync(file, "utf8")
    expect(text).toContain("id: auth-session-refresh")
    expect(text).toContain("- apps/backend/src/auth.ts")
  })

  it("memory_recall uses Markdown fallback when no AgentMemory runtime is available", async () => {
    seedMarkdown(cwd, [
      {
        id: "x-auth",
        type: "pattern",
        body: "we use Better Auth refresh tokens",
        concepts: ["auth"],
      },
      {
        id: "x-otel",
        type: "pattern",
        body: "OpenTelemetry collector setup",
        concepts: ["telemetry"],
      },
    ])
    const server = createMcpServer({
      baseUrl: "http://127.0.0.1:0",
      cwd,
      startSupervisor: false,
      supervisor: fakeSupervisor(null),
    })
    const response = await server.handle(
      jsonRpc(2, "tools/call", {
        name: "memory_recall",
        arguments: { query: "auth", limit: 5 },
      }),
    )
    const result = getToolResult(response)
    expect(result.isError).toBeFalsy()
    const body = payload(result) as {
      source: string
      matches: Array<{ id: string }>
    }
    expect(body.source).toBe("markdown-fallback")
    expect(body.matches.map((m) => m.id)).toContain("x-auth")
    expect(body.matches.map((m) => m.id)).not.toContain("x-otel")
  })

  it("memory_summarize_session returns signed-out shape when no auth exists", async () => {
    const server = createMcpServer({
      baseUrl: "http://127.0.0.1:0",
      cwd,
      startSupervisor: false,
      supervisor: fakeSupervisor(null),
    })
    const response = await server.handle(
      jsonRpc(3, "tools/call", {
        name: "memory_summarize_session",
        arguments: {},
      }),
    )
    const result = getToolResult(response)
    const body = payload(result) as { status: string; reason: string }
    expect(body.status).toBe("enhanced-memory-unavailable")
    expect(body.reason).toBe("signed-out")
  })

  it("refuses hidden tools with a clear error", async () => {
    const server = createMcpServer({
      baseUrl: "http://127.0.0.1:0",
      cwd,
      startSupervisor: false,
      supervisor: fakeSupervisor(null),
    })
    const response = await server.handle(
      jsonRpc(4, "tools/call", {
        name: "memory_export",
        arguments: {},
      }),
    )
    const result = getToolResult(response)
    expect(result.isError).toBe(true)
  })

  it("refuses to hydrate when memory tree has duplicate ids", async () => {
    const dir = join(cwd, ".ai", "memory", "pattern")
    mkdirSync(dir, { recursive: true })
    const fm = (id: string, body: string) =>
      `---\nid: ${id}\ntype: pattern\nconcepts: []\nfiles: []\ncreatedAt: 2026-05-25T00:00:00.000Z\nupdatedAt: 2026-05-25T00:00:00.000Z\n---\n# ${id}\n${body}\n`
    writeFileSync(join(dir, "a.md"), fm("dup", "a"), "utf8")
    writeFileSync(join(dir, "b.md"), fm("dup", "b"), "utf8")
    const server = createMcpServer({
      baseUrl: "http://127.0.0.1:0",
      cwd,
      startSupervisor: false,
      supervisor: fakeSupervisor(null),
    })
    const response = await server.handle(
      jsonRpc(5, "tools/call", {
        name: "memory_recall",
        arguments: { query: "anything" },
      }),
    )
    const result = getToolResult(response)
    expect(result.isError).toBe(true)
    const body = payload(result) as { status: string; reason: string }
    expect(body.status).toBe("hydration-refused")
    expect(body.reason).toBe("duplicate-id")
  })
})

function seedMarkdown(
  cwd: string,
  records: Array<{
    id: string
    type: string
    body: string
    concepts?: string[]
  }>,
): void {
  for (const r of records) {
    const dir = join(cwd, ".ai", "memory", r.type)
    mkdirSync(dir, { recursive: true })
    const content = `---\nid: ${r.id}\ntype: ${r.type}\nconcepts: [${(r.concepts ?? []).join(", ")}]\nfiles: []\ncreatedAt: 2026-05-25T00:00:00.000Z\nupdatedAt: 2026-05-25T00:00:00.000Z\n---\n# ${r.id}\n${r.body}\n`
    writeFileSync(join(dir, `${r.id}.md`), content, "utf8")
  }
}
