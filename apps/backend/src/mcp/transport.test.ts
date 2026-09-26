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
      "ctxpipe.conversation.id": "org_acme_user_1_my-backend_conv-xyz",
      "request.id": "req_mcp_tool",
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      "ctxpipe.mcp.tool": "ctx_advisor",
      "ctxpipe.conversation.id": "org_acme_user_1_my-backend_conv-xyz",
      requestId: "req_mcp_tool",
    })
    const serialized = JSON.stringify({
      span: serverSpan?.attributes,
      log: events[0],
    })
    expect(serialized).not.toContain(prompt)
    await response.body?.cancel()

    expect(toolStarted).toBe(true)
  })
})
