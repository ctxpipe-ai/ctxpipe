import { initLogger } from "evlog"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { HttpResponse, http } from "msw"
import { afterEach, beforeAll, expect, it, vi } from "vitest"
import { useMswServer } from "../../../test/msw.js"
import { recordSpans } from "../../../test/spans.js"
import type { AppEnv } from "../../app/env.js"
import { backendOtelMiddleware } from "../../observability/http.js"

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

let createDataStreamConversationTransport: typeof import("./transport.js").createDataStreamConversationTransport

beforeAll(async () => {
  initLogger({
    env: { service: "ctxpipe-backend", environment: "test" },
    pretty: false,
  })
  // transport.ts loads the conversation graph, which opens a checkpointer
  // pool when DATABASE_URL is set. This test only needs the attribution call.
  vi.stubEnv("DATABASE_URL", "")
  vi.stubEnv("MODEL_PROVIDER", "openai-like")
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  vi.stubEnv("MODEL_PROVIDER_URL", "http://model.test/v1")
  ;({ createDataStreamConversationTransport } = await import("./transport.js"))
}, 20_000)

afterEach(() => {
  vi.unstubAllEnvs()
})

it("sets ctxpipe.conversation.id on the web chat request", async () => {
  const events: Record<string, unknown>[] = []
  const conversationId = "conv_web_1"
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
    c.set("user", { id: "user_1" } as AppEnv["Variables"]["user"])
    c.set("session", null)
    c.set("oauthOrganizationId", null)
    c.set("oauthClientId", null)
    c.set("orgApiKey", null)
    c.set("orgSlug", "acme")
    c.set("orgId", "org_acme")
    await next()
  })
  app.post("/conversations", () =>
    createDataStreamConversationTransport().toResponse({
      conversationId,
      checkpointNamespace: "conversation",
      prompt: "What database does this org use?",
      source: "web",
      userId: "user_1",
    }),
  )

  const response = await app.request("http://backend.test/conversations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": "req_web_chat",
    },
  })
  await response.body?.cancel()

  const serverSpan = spans.spanNamed("POST /conversations")
  expect(serverSpan?.attributes["ctxpipe.conversation.id"]).toBe(conversationId)
  expect(events[0]).toMatchObject({
    "ctxpipe.conversation.id": conversationId,
    requestId: "req_web_chat",
  })
})
