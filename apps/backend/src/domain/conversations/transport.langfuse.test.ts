import { resourceFromAttributes } from "@opentelemetry/resources"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { initLogger } from "evlog"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"
import { applyAttribution } from "../../observability/attribution.js"
import { backendOtelMiddleware } from "../../observability/http.js"
import { LangfuseContextSpanProcessor } from "../../observability/langfuseContextProcessor.js"
import { otelDeploymentEnvironment } from "../../observability/otel.js"
import { withTestRequestLogger } from "../../test/hono-test-logger.js"

const environment = otelDeploymentEnvironment()
const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({
    "service.name": "ctxpipe-test",
    "deployment.environment": environment,
  }),
  spanProcessors: [
    new LangfuseContextSpanProcessor(),
    new SimpleSpanProcessor(exporter),
  ],
})

let workspaceChatStreamResponse: typeof import("./transport.js").workspaceChatStreamResponse

beforeAll(async () => {
  provider.register()
  initLogger({
    env: { service: "ctxpipe-backend", environment: "test" },
    pretty: false,
  })
  // transport.ts loads the conversation graph, which opens a checkpointer
  // pool when DATABASE_URL is set. This test only needs the live stream path.
  vi.stubEnv("DATABASE_URL", "")
  vi.stubEnv("MODEL_PROVIDER", "openai-like")
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  vi.stubEnv("MODEL_PROVIDER_URL", "http://model.test/v1")
  ;({ workspaceChatStreamResponse } = await import("./transport.js"))
}, 20_000)

beforeEach(() => {
  exporter.reset()
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await provider.shutdown()
})

it("tags the live create-stream generation from the request bag, not baggage", async () => {
  const conversationId = "conv_create_lf"
  const app = new Hono<AppEnv>()
  app.use(contextStorage())
  app.use("*", backendOtelMiddleware())
  app.use(withTestRequestLogger)
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
    applyAttribution({
      "enduser.id": "user_1",
      "ctxpipe.org.id": "org_acme",
      "ctxpipe.org.slug": "acme",
      "ctxpipe.actor.type": "user",
    })
    await next()
  })
  app.post("/conversations", () => {
    applyAttribution({ "ctxpipe.conversation.id": conversationId })
    return workspaceChatStreamResponse({
      conversationId,
      checkpointNamespace: "conversation",
      prompt: "What database does this org use?",
      source: "web",
      userId: "user_1",
      orgId: "org_acme",
      orgSlug: "acme",
      workspaceId: "ws_1",
      desiredUrl: "https://github.com/example/repo",
      resolveRuntime: async () => {
        throw new Error("stop-after-embedded-generation")
      },
    })
  })

  const response = await app.request("http://backend.test/conversations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      baggage:
        "ctxpipe.org.id=org_SPOOFED,ctxpipe.org.slug=spoofed,ctxpipe.conversation.id=conv_SPOOFED",
      "x-request-id": "req_create_chat",
    },
  })
  await response.text()

  const turn = exporter
    .getFinishedSpans()
    .find((span) => span.name === "workspace-chat.turn")
  expect(turn?.attributes["langfuse.trace.tags"]).toEqual(
    expect.arrayContaining(["org:acme", `env:${environment}`]),
  )
  expect(turn?.attributes["langfuse.trace.metadata.orgId"]).toBe("org_acme")
  expect(turn?.attributes["langfuse.trace.metadata.orgSlug"]).toBe("acme")
  expect(turn?.attributes["langfuse.trace.metadata.requestId"]).toBe(
    "req_create_chat",
  )
  expect(turn?.attributes["session.id"]).toBe(conversationId)
  expect(JSON.stringify(turn?.attributes)).not.toContain("org_SPOOFED")
  expect(JSON.stringify(turn?.attributes)).not.toContain("conv_SPOOFED")
})
