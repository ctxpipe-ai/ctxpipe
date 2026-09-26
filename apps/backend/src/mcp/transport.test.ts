import { readFileSync } from "node:fs"
import { SpanKind } from "@opentelemetry/api"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { parse } from "dotenv"
import { eq } from "drizzle-orm"
import { initLogger } from "evlog"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { z } from "zod"
import type { AppEnv } from "../app/env.js"
import { closeDb, getSystemDb, initDb } from "../db/client.js"
import { conversations } from "../db/schema/conversations.js"
import { applyAttribution } from "../observability/attribution.js"
import { backendOtelMiddleware } from "../observability/http.js"
import { AttributionUrlSpanProcessor } from "../observability/otel.js"
import { mcpAdvisorThreadId } from "./advisorThread.js"
import { handleMcpTransportRequest } from "./transport.js"

const databaseUrl = (() => {
  try {
    return parse(
      readFileSync(new URL("../../.env.local", import.meta.url), "utf8"),
    ).DATABASE_URL
  } catch {
    return undefined
  }
})()

const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  spanProcessors: [
    new AttributionUrlSpanProcessor(),
    new SimpleSpanProcessor(exporter),
  ],
})

beforeAll(() => {
  provider.register()
  initLogger({
    env: { service: "ctxpipe-backend", environment: "test" },
    pretty: false,
  })
})

beforeEach(() => {
  exporter.reset()
})

afterAll(async () => {
  await provider.shutdown()
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
    const serverSpan = exporter
      .getFinishedSpans()
      .find(
        (span) => span.kind === SpanKind.SERVER && span.name === "POST /mcp",
      )
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

describe.skipIf(!databaseUrl)("MCP OAuth client actor", () => {
  const model = setupServer(
    http.all("http://model.test/*", () =>
      HttpResponse.json(
        { error: { message: "nope", type: "invalid_request_error" } },
        { status: 400 },
      ),
    ),
  )
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const orgId = `org_mcp_oauth_${suffix}`
  const userId = `user_oauth_${suffix}`
  const threadId = mcpAdvisorThreadId({
    orgId,
    actorKey: userId,
    currentProjectName: "my-backend",
    conversationId: "conv-xyz",
  })

  beforeAll(() => {
    model.listen({ onUnhandledRequest: "bypass" })
    initDb(databaseUrl ?? "")
  })

  afterAll(async () => {
    if (databaseUrl) {
      await getSystemDb()
        .delete(conversations)
        .where(eq(conversations.orgId, orgId))
    }
    model.close()
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

    const spans = exporter.getFinishedSpans()
    const serverSpan = spans.find(
      (span) => span.kind === SpanKind.SERVER && span.name === "POST /mcp",
    )
    expect(serverSpan?.attributes).toMatchObject({
      "ctxpipe.actor.type": "oauth_client",
      "ctxpipe.oauth.client_id": "client_oauth",
      "ctxpipe.mcp.tool": "ctx_advisor",
      "ctxpipe.conversation.id": threadId,
      "enduser.id": userId,
      "request.id": "req_mcp_oauth",
    })
    const actorSpans = spans.filter(
      (span) => span.attributes["ctxpipe.actor.type"] != null,
    )
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
  }, 20_000)
})
