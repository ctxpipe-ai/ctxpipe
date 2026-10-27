import { randomUUID } from "node:crypto"

import { OpenAPIHono } from "@hono/zod-openapi"
import { SpanKind } from "@opentelemetry/api"
import { resourceFromAttributes } from "@opentelemetry/resources"
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest"

import { describeWithDatabase } from "../../../test/db.js"
import { useMswServer } from "../../../test/msw.js"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { conversations } from "../../db/schema/conversations.js"
import { sandboxLocks } from "../../db/schema/sandbox-locks.js"
import { workspaces } from "../../db/schema/workspaces.js"
import {
  beginWorkspaceChatTurn,
  finishWorkspaceChatTurn,
} from "../../domain/workspaces/workspace-chat-otel.js"
import { mintWorkspaceChatRunCapability } from "../../domain/workspaces/workspace-chat-run-capability.js"
import { generateObjectId } from "../../lib/id.js"
import { backendOtelMiddleware } from "../../observability/http.js"
import { LangfuseContextSpanProcessor } from "../../observability/langfuseContextProcessor.js"
import { otelDeploymentEnvironment } from "../../observability/otel.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { workspaceChatOpenaiRoutes } from "./workspace-chat-openai.js"

const AUTH_SECRET = "abcdefghijklmnopqrstuvwxyz123456"
const MODEL_PROVIDER_URL = "http://model-provider.test/v1"
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

const server = useMswServer(
  http.post(`${MODEL_PROVIDER_URL}/chat/completions`, () =>
    HttpResponse.json({
      id: "chatcmpl_ws",
      choices: [{ message: { role: "assistant", content: "ok" } }],
    }),
  ),
)

beforeAll(() => {
  provider.register()
})

beforeEach(() => {
  exporter.reset()
})

afterAll(async () => {
  await provider.shutdown()
})

function appWithRoutes(): OpenAPIHono<AppEnv> {
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://localhost:5432/ctxpipe_test",
    GRAPH_DB_URI: "redis://localhost:6379",
    AUTH_BASE_URL: "https://backend.example.com",
    AUTH_SECRET,
    PORT: "3000",
    MODEL_PROVIDER: "openai-like",
    MODEL_PROVIDER_URL,
    MODEL_PROVIDER_API_KEY: "sk-upstream",
    MODEL_FAST_NAME: "test/model-fast?reasoning.effort=high",
  })

  const app = new OpenAPIHono<AppEnv>().basePath(
    "/:orgSlug/api/v1/workspace-chat/openai",
  )
  app.use(contextStorage())
  app.use("*", backendOtelMiddleware())
  app.use(withTestRequestLogger)
  app.use("*", async (c, next) => {
    c.set("env", env)
    await next()
  })
  app.route("/", workspaceChatOpenaiRoutes)
  return app
}

function serverSpan() {
  const finished = exporter.getFinishedSpans()
  for (let index = finished.length - 1; index >= 0; index--) {
    const span = finished[index]
    if (span?.kind === SpanKind.SERVER) return span
  }
  return undefined
}

describeWithDatabase("workspace-chat capability attribution", () => {
  const orgId = generateObjectId("org")
  const orgSlug = `acme-${orgId.slice(-8)}`
  const workspaceId = generateObjectId("ws")
  const conversationId = generateObjectId("conv")
  const sha = "a".repeat(40)
  const lockOwner = randomUUID()
  const repoUrl = `https://github.com/ctxpipe-ai/${workspaceId}`

  beforeAll(async () => {
    initDb(process.env.DATABASE_URL as string)
    await getSystemDb().insert(organizations).values({
      id: orgId,
      name: "Capability attribution org",
      slug: orgSlug,
      createdAt: new Date(),
    })
    await withOrgDbContext(orgId, async (db) => {
      await db.insert(workspaces).values({
        id: workspaceId,
        orgId,
        slug: `ws-${workspaceId.slice(-8)}`,
        displayName: "Capability attribution workspace",
        workspaceRepositoryUrl: repoUrl,
        desiredGeneration: 1,
        desiredSha: sha,
        desiredDefaultBranch: "main",
      })
      await db.insert(conversations).values({
        id: conversationId,
        orgId,
        workspaceId,
        name: "Capability attribution conversation",
        source: "ui",
      })
      await db.insert(sandboxLocks).values({
        orgId,
        key: `chat-thread:${conversationId}`,
        owner: lockOwner,
        expiresAt: new Date(Date.now() + 60_000),
      })
    })
  })

  afterEach(() => {
    finishWorkspaceChatTurn(conversationId)
  })

  afterAll(async () => {
    await withOrgDbContext(orgId, async (db) => {
      await db.delete(sandboxLocks).where(eq(sandboxLocks.orgId, orgId))
      await db.delete(conversations).where(eq(conversations.orgId, orgId))
      await db.delete(workspaces).where(eq(workspaces.orgId, orgId))
    })
    await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
    await closeDb()
  })

  function capability(): Promise<string> {
    return mintWorkspaceChatRunCapability({
      authSecret: AUTH_SECRET,
      orgId,
      orgSlug,
      conversationId,
      expectedOwner: lockOwner,
      revision: {
        workspaceId,
        generation: 1,
        remote: { url: repoUrl, connectionId: null },
        sha,
        defaultBranch: "main",
        access: "read",
      },
      purpose: "workspace-chat-model",
    })
  }

  it("records the model, the reasoning effort, the tokens, the cost, the prompt, and the output of a streamed generation", async () => {
    let upstreamBody: Record<string, unknown> = {}
    const sse = [
      {
        model: "test/model-fast-20260901",
        choices: [{ delta: { content: "Hel" } }],
      },
      { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 7200,
          completion_tokens: 40,
          prompt_tokens_details: { cached_tokens: 6800 },
          cost: 0.0021,
        },
      },
    ]
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .concat("data: [DONE]\n\n")
      .join("")
    server.use(
      http.post(
        `${MODEL_PROVIDER_URL}/chat/completions`,
        async ({ request }) => {
          upstreamBody = (await request.json()) as Record<string, unknown>
          return new HttpResponse(sse, {
            headers: { "content-type": "text/event-stream" },
          })
        },
      ),
    )
    beginWorkspaceChatTurn(conversationId, conversationId, { orgId, orgSlug })
    const res = await appWithRoutes().request(
      `/${orgSlug}/api/v1/workspace-chat/openai/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await capability()}`,
        },
        body: JSON.stringify({
          model: "anything",
          stream: true,
          messages: [
            { role: "user", content: "Say hello" },
            {
              role: "tool",
              content: "token ghp_abcdefghijklmnopqrstuvwxyz0123",
            },
          ],
        }),
      },
    )
    expect(res.status).toBe(200)
    await res.text()

    expect(upstreamBody.stream_options).toEqual({ include_usage: true })
    const generation = exporter
      .getFinishedSpans()
      .find((item) => item.name === "generation #0")
    expect(generation?.attributes).toMatchObject({
      "gen_ai.request.model": "test/model-fast",
      "gen_ai.response.model": "test/model-fast-20260901",
      "gen_ai.usage.input_tokens": 7200,
      "gen_ai.usage.output_tokens": 40,
      "gen_ai.usage.cache_read.input_tokens": 6800,
      "gen_ai.usage.cost": 0.0021,
      "gen_ai.response.finish_reasons": "stop",
      "gen_ai.request.reasoning_effort": "high",
    })
    expect(upstreamBody.reasoning_effort).toBe("high")
    expect(
      JSON.parse(String(generation?.attributes["langfuse.observation.input"])),
    ).toEqual([
      { role: "user", content: "Say hello" },
      { role: "tool", content: "token [masked]" },
    ])
    expect(
      JSON.parse(String(generation?.attributes["langfuse.observation.output"])),
    ).toEqual({ role: "assistant", content: "Hello" })
  })

  it("attributes completions from the verified run capability, not the URL slug or baggage", async () => {
    const capability = await mintWorkspaceChatRunCapability({
      authSecret: AUTH_SECRET,
      orgId,
      orgSlug,
      conversationId,
      expectedOwner: lockOwner,
      revision: {
        workspaceId,
        generation: 1,
        remote: { url: repoUrl, connectionId: null },
        sha,
        defaultBranch: "main",
        access: "read",
      },
      purpose: "workspace-chat-model",
    })

    beginWorkspaceChatTurn(conversationId, conversationId, { orgId, orgSlug })
    const res = await appWithRoutes().request(
      "/spoofed-org/api/v1/workspace-chat/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${capability}`,
          baggage:
            "ctxpipe.org.id=org_SPOOFED,ctxpipe.org.slug=spoofed,ctxpipe.conversation.id=conv_SPOOFED",
          "x-request-id": "req_ws_cap",
        },
        body: JSON.stringify({
          model: "test/model-fast",
          messages: [{ role: "user", content: "secret-prompt-token" }],
        }),
      },
    )

    expect(res.status).toBe(200)
    await res.json()
    const span = serverSpan()
    expect(span?.attributes).toMatchObject({
      "ctxpipe.org.id": orgId,
      "ctxpipe.org.slug": orgSlug,
      "ctxpipe.conversation.id": conversationId,
      "request.id": "req_ws_cap",
    })
    expect(span?.attributes["ctxpipe.org.slug"]).not.toBe("spoofed")
    expect(JSON.stringify(span?.attributes)).not.toContain("conv_SPOOFED")
    expect(JSON.stringify(span?.attributes)).not.toContain(
      "secret-prompt-token",
    )
    const generation = exporter
      .getFinishedSpans()
      .find((item) => item.name.startsWith("generation"))
    expect(generation?.attributes["langfuse.trace.tags"]).toEqual(
      expect.arrayContaining([`org:${orgSlug}`, `env:${environment}`]),
    )
    expect(generation?.attributes["langfuse.trace.metadata.orgSlug"]).toBe(
      orgSlug,
    )
  })
})
