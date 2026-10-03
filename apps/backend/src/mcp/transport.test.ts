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

const memberThreadId = "org_acme_user_1_my-backend_conv-xyz"
const orgServiceThreadId = "org_acme_org_my-backend_conv-org"

const spans = recordSpans()

beforeAll(() => {
  initLogger({
    env: { service: "ctxpipe-backend", environment: "test" },
    pretty: false,
  })
})

describe("MCP request attribution", () => {
  it("puts tool and conversation ids on the POST /mcp span and request log before the tool runs", async () => {
    const events: Record<string, unknown>[] = []
    const prompt = "SUPER_SECRET_PROMPT_SHOULD_NOT_LEAK"
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
      c.set("oauthOrganizationId", null)
      c.set("oauthClientId", null)
      c.set("orgApiKey", null)
      c.set("orgSlug", "acme")
      c.set("orgId", "org_acme")
      await next()
    })
    app.post("/mcp", (c) =>
      handleMcpTransportRequest(c, (server) => {
        server.registerTool(
          "ctx_advisor",
          {
            inputSchema: z.object({
              prompt: z.string(),
              conversationId: z.string().optional(),
              currentProjectName: z.string().optional(),
            }),
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
          name: "ctx_advisor",
          arguments: {
            prompt,
            conversationId: "conv-xyz",
            currentProjectName: "my-backend",
          },
        },
      }),
    })

    expect(response.status).toBe(200)
    const serverSpan = spans.spanNamed("POST /mcp")
    expect(serverSpan?.attributes).toMatchObject({
      "ctxpipe.mcp.tool": "ctx_advisor",
      "ctxpipe.conversation.id": memberThreadId,
      "request.id": "req_mcp_tool",
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      "ctxpipe.mcp.tool": "ctx_advisor",
      "ctxpipe.conversation.id": memberThreadId,
      requestId: "req_mcp_tool",
    })
    const serialized = JSON.stringify({
      span: serverSpan?.attributes,
      log: events[0],
    })
    expect(serialized).not.toContain(prompt)
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
          arguments: { prompt: "hello" },
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

  it("attributes org-service ctx_advisor threads without a user id", async () => {
    const app = new Hono<AppEnv>()
    app.use(contextStorage())
    app.use(
      evlog({
        drain: async () => undefined,
      }),
    )
    app.use("*", backendOtelMiddleware())
    app.use("*", async (c, next) => {
      c.set("env", {
        AUTH_BASE_URL: "https://localhost:3000",
      } as AppEnv["Variables"]["env"])
      c.set("user", null)
      c.set("session", null)
      c.set("oauthOrganizationId", null)
      c.set("oauthClientId", null)
      c.set("orgApiKey", {
        id: "key_org",
        orgId: "org_acme",
        configId: "organization",
      })
      c.set("orgSlug", "acme")
      c.set("orgId", "org_acme")
      await next()
    })
    app.post("/mcp", (c) =>
      handleMcpTransportRequest(c, (server) => {
        server.registerTool(
          "ctx_advisor",
          {
            inputSchema: z.object({
              prompt: z.string(),
              conversationId: z.string().optional(),
              currentProjectName: z.string().optional(),
            }),
          },
          async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
        )
      }),
    )

    const response = await app.request("http://backend.test/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "ctx_advisor",
          arguments: {
            prompt: "hello",
            conversationId: "conv-org",
            currentProjectName: "my-backend",
          },
        },
      }),
    })

    expect(response.status).toBe(200)
    expect(spans.spanNamed("POST /mcp")?.attributes).toMatchObject({
      "ctxpipe.mcp.tool": "ctx_advisor",
      "ctxpipe.conversation.id": orgServiceThreadId,
    })
    await response.body?.cancel()
  })

  it("omits conversation attribution when conversationId is blank", async () => {
    const app = new Hono<AppEnv>()
    app.use(contextStorage())
    app.use(
      evlog({
        drain: async () => undefined,
      }),
    )
    app.use("*", backendOtelMiddleware())
    app.use("*", async (c, next) => {
      c.set("env", {
        AUTH_BASE_URL: "https://localhost:3000",
      } as AppEnv["Variables"]["env"])
      c.set("user", { id: "user_1" } as AppEnv["Variables"]["user"])
      c.set("session", null)
      c.set("oauthOrganizationId", null)
      c.set("oauthClientId", null)
      c.set("orgApiKey", null)
      c.set("orgSlug", "acme")
      c.set("orgId", "org_acme")
      await next()
    })
    app.post("/mcp", (c) =>
      handleMcpTransportRequest(c, (server) => {
        server.registerTool(
          "ctx_advisor",
          {
            inputSchema: z.object({
              prompt: z.string(),
              conversationId: z.string().optional(),
            }),
          },
          async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
        )
      }),
    )

    const response = await app.request("http://backend.test/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "ctx_advisor",
          arguments: { prompt: "hello", conversationId: "   " },
        },
      }),
    })

    expect(response.status).toBe(200)
    expect(
      spans.spanNamed("POST /mcp")?.attributes["ctxpipe.conversation.id"],
    ).toBeUndefined()
    await response.body?.cancel()
  })
})
