import { SpanStatusCode } from "@opentelemetry/api"
import { eq } from "drizzle-orm"
import { initLogger } from "evlog"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { describeWithDatabase } from "../../test/db.js"
import { useMswServer } from "../../test/msw.js"
import { recordSpans } from "../../test/spans.js"
import type { AppEnv } from "../app/env.js"
import { closeDb, getSystemDb, initDb } from "../db/client.js"
import { conversations } from "../db/schema/conversations.js"
import { applyAttribution } from "../observability/attribution.js"
import { backendOtelMiddleware } from "../observability/http.js"
import { mcpAdvisorThreadId } from "./advisorThread.js"
import { handleMcpTransportRequest } from "./transport.js"

const spans = recordSpans()
// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
useMswServer(
  http.all("http://model.test/*", () =>
    HttpResponse.json(
      { error: { message: "nope", type: "invalid_request_error" } },
      { status: 400 },
    ),
  ),
)

describeWithDatabase("MCP OAuth client actor", () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const orgId = `org_mcp_oauth_${suffix}`
  const userId = `user_oauth_${suffix}`
  const threadId = mcpAdvisorThreadId({
    orgId,
    actor: { type: "user", userId },
    currentProjectName: "my-backend",
    conversationId: "conv-xyz",
  })

  beforeAll(() => {
    initLogger({
      env: { service: "ctxpipe-backend", environment: "test" },
      pretty: false,
    })
    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl) throw new Error("DATABASE_URL is unset")
    initDb(databaseUrl)
  })

  afterAll(async () => {
    await getSystemDb()
      .delete(conversations)
      .where(eq(conversations.orgId, orgId))
    await closeDb()
  })

  it("keeps oauth_client after the real ctx_advisor tool runs", async () => {
    vi.stubEnv("MODEL_PROVIDER", "openai-like")
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
    vi.stubEnv("MODEL_PROVIDER_URL", "http://model.test/v1")
    const { registerMcpTools } = await import("./tools.js")

    const events: Record<string, unknown>[] = []
    const prompt = "SUPER_SECRET_PROMPT_SHOULD_NOT_LEAK"
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
      c.set("user", { id: userId } as AppEnv["Variables"]["user"])
      c.set("session", {
        id: "sess_oauth",
      } as AppEnv["Variables"]["session"])
      c.set("oauthOrganizationId", orgId)
      c.set("oauthClientId", "client_oauth")
      c.set("orgApiKey", null)
      c.set("personalApiKeyId", null)
      c.set("orgSlug", "acme")
      c.set("orgId", orgId)
      applyAttribution({
        "ctxpipe.actor.type": "oauth_client",
        "ctxpipe.org.id": orgId,
        "ctxpipe.org.slug": "acme",
        "enduser.id": userId,
        "ctxpipe.oauth.client_id": "client_oauth",
      })
      await next()
    })
    app.post("/mcp", (c) => handleMcpTransportRequest(c, registerMcpTools))

    const response = await app.request("http://backend.test/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "x-request-id": "req_mcp_oauth",
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

    const body = await response.text()
    expect(body).not.toContain(prompt)
    const result = mcpToolResult(body)
    expect(result.isError).toBe(true)
    const text = result.content?.find((part) => part.type === "text")?.text
    expect(text).toEqual(expect.any(String))
    expect(text?.length).toBeGreaterThan(0)

    const serverSpan = spans.spanNamed("POST /mcp")
    expect(serverSpan?.attributes).toMatchObject({
      "ctxpipe.actor.type": "oauth_client",
      "ctxpipe.oauth.client_id": "client_oauth",
      "ctxpipe.mcp.tool": "ctx_advisor",
      "ctxpipe.conversation.id": threadId,
      "enduser.id": userId,
      "request.id": "req_mcp_oauth",
    })
    const toolSpan = spans.spanNamed("mcp.tool ctx_advisor")
    expect(toolSpan?.status.code).toBe(SpanStatusCode.ERROR)
    const actorSpans = spans
      .finishedSpans()
      .filter((span) => span.attributes["ctxpipe.actor.type"] != null)
    expect(actorSpans.length).toBeGreaterThan(0)
    for (const span of actorSpans) {
      expect(span.attributes["ctxpipe.actor.type"]).toBe("oauth_client")
    }
    const requestLog = events.find(
      (event) => event["ctxpipe.mcp.tool"] === "ctx_advisor",
    )
    expect(requestLog).toMatchObject({
      "ctxpipe.actor.type": "oauth_client",
      "ctxpipe.conversation.id": threadId,
      "enduser.id": userId,
    })
    expect(
      JSON.stringify({ span: serverSpan?.attributes, log: requestLog }),
    ).not.toContain(prompt)

    const rows = await getSystemDb()
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, threadId))
    expect(rows).toHaveLength(1)
  }, 30_000)
})

function mcpToolResult(body: string): {
  isError?: boolean
  content?: Array<{ type?: string; text?: string }>
} {
  const payloads: unknown[] = []
  const trimmed = body.trim()
  if (trimmed.startsWith("{")) {
    payloads.push(JSON.parse(trimmed))
  } else {
    for (const line of body.split("\n")) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : ""
      if (!data.startsWith("{")) continue
      payloads.push(JSON.parse(data))
    }
  }
  for (const payload of payloads) {
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("result" in payload) ||
      typeof payload.result !== "object" ||
      payload.result === null
    ) {
      continue
    }
    return payload.result as {
      isError?: boolean
      content?: Array<{ type?: string; text?: string }>
    }
  }
  throw new Error("MCP response did not include a tool result")
}
