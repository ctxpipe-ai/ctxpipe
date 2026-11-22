import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { initLogger } from "evlog"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { recordSpans } from "../../test/spans.js"
import type { AppEnv } from "../app/env.js"
import { applyAttribution } from "../observability/attribution.js"
import { backendOtelMiddleware } from "../observability/http.js"
import { applyLogContract } from "../observability/logContract.js"
import { runMcpToolCall } from "./correlation.js"
import { INSTRUCTION_RULES } from "./framework/instructions.js"
import { registerWorkspaceFileResource } from "./resources/workspace-file.js"
import {
  handleMcpTransportRequest,
  type McpTransportOptions,
} from "./transport.js"

const spans = recordSpans()

beforeAll(() => {
  initLogger({
    env: { service: "ctxpipe-backend", environment: "test" },
    pretty: false,
  })
})

describe("MCP request attribution", () => {
  it("puts the tool name on the POST /mcp span and request log before the tool runs", async () => {
    const events: Record<string, unknown>[] = []
    const query = "SUPER_SECRET_QUERY_SHOULD_NOT_LEAK"
    let toolStarted = false
    const app = new Hono<AppEnv>()
    app.use(contextStorage())
    app.use(
      evlog({
        drain: async (ctx) => {
          const batch = Array.isArray(ctx) ? ctx : [ctx]
          for (const item of batch) {
            events.push(item.event as Record<string, unknown>)
          }
        },
      }),
    )
    app.use("*", backendOtelMiddleware())
    app.use("*", async (c, next) => {
      c.set("env", {
        AUTH_BASE_URL: "https://localhost:3000",
      } as AppEnv["Variables"]["env"])
      c.set("user", {
        id: "user_1",
      } as AppEnv["Variables"]["user"])
      c.set("session", null)
      c.set("oauthReferenceId", null)
      c.set("oauthClientId", null)
      c.set("orgApiKey", null)
      c.set("orgSlug", "acme")
      c.set("orgId", "org_acme")
      await next()
    })
    app.post("/mcp", (c) =>
      handleMcpTransportRequest(c, (server) => {
        server.registerTool(
          "search_knowledge",
          {
            annotations: { readOnlyHint: true },
            inputSchema: z.object({ query: z.string() }),
          },
          async () => {
            toolStarted = true
            return { content: [{ type: "text" as const, text: "ok" }] }
          },
        )
      }),
    )

    const response = await app.request("http://backend.test/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "x-request-id": "req_mcp_tool",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "search_knowledge",
          arguments: { query },
        },
      }),
    })

    expect(response.status).toBe(200)
    const serverSpan = spans.spanNamed("POST /mcp")
    expect(serverSpan?.attributes).toMatchObject({
      "ctxpipe.mcp.tool": "search_knowledge",
      "request.id": "req_mcp_tool",
    })
    expect(serverSpan?.attributes["ctxpipe.conversation.id"]).toBeUndefined()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      "ctxpipe.mcp.tool": "search_knowledge",
      requestId: "req_mcp_tool",
    })
    const serialized = JSON.stringify({
      span: serverSpan?.attributes,
      log: events[0],
    })
    expect(serialized).not.toContain(query)
    await response.body?.cancel()

    expect(toolStarted).toBe(true)

    const longName = `tool_${"n".repeat(120)}`
    const longResponse = await app.request("http://backend.test/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: longName,
          arguments: { query: "hello" },
        },
      }),
    })
    const longSpan = spans.spanNamed("POST /mcp")
    expect(longSpan?.attributes["ctxpipe.mcp.tool"]).toBe(
      longName.slice(0, 100),
    )
    expect(JSON.stringify(longSpan?.attributes)).not.toContain(longName)
    await longResponse.body?.cancel()
  })
})

function buildApp(
  registerTools: (server: McpServer) => void,
  options: McpTransportOptions,
  events: Record<string, unknown>[] = [],
) {
  const app = new Hono<AppEnv>()
  app.use(contextStorage())
  app.use(
    evlog({
      drain: async (ctx) => {
        for (const item of Array.isArray(ctx) ? ctx : [ctx]) {
          events.push(item.event as Record<string, unknown>)
        }
      },
    }),
  )
  app.use("*", backendOtelMiddleware())
  app.use("*", async (c, next) => {
    c.set("env", {
      AUTH_BASE_URL: "https://localhost:3000",
    } as AppEnv["Variables"]["env"])
    c.set("user", { id: "user_1" } as AppEnv["Variables"]["user"])
    c.set("session", null)
    c.set("oauthReferenceId", null)
    c.set("oauthClientId", null)
    c.set("orgApiKey", null)
    c.set("orgSlug", "acme")
    c.set("orgId", "org_acme")
    await next()
  })
  app.post("/mcp", (c) => handleMcpTransportRequest(c, registerTools, options))
  return app
}

function post(app: Hono<AppEnv>, body: unknown) {
  return app.request("http://backend.test/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

describe("MCP tool call request log", () => {
  const callEvents: Record<string, unknown>[] = []
  // The event of a call goes to the global drain, as in production.
  beforeAll(() => {
    initLogger({
      env: { service: "ctxpipe-backend", environment: "test" },
      pretty: false,
      drain: (ctx) => {
        applyLogContract(ctx.event)
        callEvents.push(ctx.event as Record<string, unknown>)
      },
    })
  })
  afterAll(() => {
    initLogger({
      env: { service: "ctxpipe-backend", environment: "test" },
      pretty: false,
    })
  })

  it("keeps SSE and puts the facts of the call on a call event, with no late-set warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const events: Record<string, unknown>[] = []
    let release = () => {}
    const toolMayEnd = new Promise<void>((resolve) => {
      release = resolve
    })
    const app = buildApp(
      (server) =>
        server.registerTool(
          "search_knowledge",
          {
            annotations: { readOnlyHint: true },
            inputSchema: z.object({ query: z.string() }),
          },
          (_args, extra) =>
            runMcpToolCall(
              { toolName: "search_knowledge", extra },
              async () => {
                await toolMayEnd
                // As `withCallOrg` does for the org that the call names.
                applyAttribution({
                  "ctxpipe.org.id": "org_acme",
                  "ctxpipe.org.slug": "acme",
                })
                return { content: [{ type: "text" as const, text: "ok" }] }
              },
            ),
        ),
      {},
      events,
    )

    const response = await app.request("http://backend.test/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "x-request-id": "req_mcp_call",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search_knowledge", arguments: { query: "hello" } },
      }),
    })
    // The response streams, and the request event is out before the tool ends.
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    release()
    expect(await response.text()).toContain("ok")

    const lateSets = warn.mock.calls.filter(([message]) =>
      String(message).includes("called after the wide event was emitted"),
    )
    warn.mockRestore()
    expect(lateSets).toEqual([])
    expect(events).toHaveLength(1)
    expect(callEvents).toHaveLength(1)
    expect(callEvents[0]).toMatchObject({
      operation: "mcp.call",
      "request.id": "req_mcp_call",
      "ctxpipe.mcp.tool": "search_knowledge",
      "ctxpipe.mcp.result.bytes": expect.any(Number),
      "ctxpipe.org.id": "org_acme",
      "ctxpipe.org.slug": "acme",
    })
  })
})

describe("MCP resource read attribution", () => {
  it("puts the resource name, not the URI, on the POST /mcp span and request log", async () => {
    const events: Record<string, unknown>[] = []
    const app = buildApp(
      (server) => registerWorkspaceFileResource(server),
      {},
      events,
    )

    // A bad percent escape fails before any database read.
    const response = await post(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: "ctxpipe://acme/payments/knowledge/%E0%A4%A.md" },
    })
    expect(response.status).toBe(200)
    await response.text()

    const serverSpan = spans.spanNamed("POST /mcp")
    expect(serverSpan?.attributes["ctxpipe.mcp.resource"]).toBe(
      "workspace-file",
    )
    expect(serverSpan?.attributes["ctxpipe.mcp.tool"]).toBeUndefined()
    expect(events[0]).toMatchObject({
      "ctxpipe.mcp.resource": "workspace-file",
    })
    expect(
      JSON.stringify({ span: serverSpan?.attributes, log: events[0] }),
    ).not.toContain("knowledge/")
  })
})

describe("MCP tool input size", () => {
  it("refuses a tool call with more input elements than any tool takes, before the tool runs", async () => {
    let toolRan = false
    const app = buildApp((server) => {
      server.registerTool(
        "search_knowledge",
        {
          annotations: { readOnlyHint: true },
          inputSchema: z.object({ items: z.array(z.string()) }),
        },
        async () => {
          toolRan = true
          return { content: [{ type: "text" as const, text: "ok" }] }
        },
      )
    }, {})

    const call = (items: string[]) =>
      post(app, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search_knowledge", arguments: { items } },
      })

    const tooMany = await call(Array.from({ length: 10_001 }, () => "x"))
    expect(tooMany.status).toBe(200)
    expect(await tooMany.text()).toContain('"isError":true')
    expect(toolRan).toBe(false)

    const fine = await call(["a", "b"])
    expect(await fine.text()).toContain('"text":"ok"')
    expect(toolRan).toBe(true)
  })
})

describe("MCP server instructions", () => {
  it("sends the fixed rules when the per-org instructions fail to load", async () => {
    const events: Record<string, unknown>[] = []
    const app = buildApp(
      () => {},
      {
        instructions: async () => {
          throw new Error("database is down")
        },
      },
      events,
    )

    const response = await post(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain(
      JSON.stringify(INSTRUCTION_RULES).slice(1, -1),
    )
    expect(JSON.stringify(events)).toContain("database is down")
  })
})
