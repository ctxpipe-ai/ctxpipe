import { initLogger } from "evlog"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"
import { recordSpans } from "../../test/spans.js"
import type { AppEnv } from "../app/env.js"
import { backendOtelMiddleware } from "../observability/http.js"
import { handleMcpTransportRequest } from "./transport.js"

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
