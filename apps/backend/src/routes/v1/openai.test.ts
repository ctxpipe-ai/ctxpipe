import { createServer, type Server } from "node:http"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { OpenAPIHono } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"

const mockChatInvoke = vi.hoisted(() =>
  vi.fn(async () => ({ content: "from bedrock" })),
)
const mockChatStream = vi.hoisted(() => vi.fn())
const chatBedrockConverseConstructor = vi.hoisted(() => {
  class MockChatBedrockConverse {
    invoke = mockChatInvoke
    stream = mockChatStream
    constructor(_fields: unknown) {}
  }
  return vi.fn(MockChatBedrockConverse)
})

const mockBedrockSend = vi.hoisted(() => vi.fn())

vi.mock("@langchain/aws", () => ({
  ChatBedrockConverse: chatBedrockConverseConstructor,
}))

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
  class MockInvokeModelCommand {
    input: unknown
    constructor(input: unknown) {
      this.input = input
    }
  }
  class MockBedrockRuntimeClient {
    send = mockBedrockSend
    constructor(_config: unknown) {}
  }
  return {
    BedrockRuntimeClient: MockBedrockRuntimeClient,
    InvokeModelCommand: MockInvokeModelCommand,
  }
})

vi.mock("../../observability/logger.js", () => ({
  getLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  }),
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

let openaiRoutes: typeof import("./openai.js").openaiRoutes

beforeAll(async () => {
  ;({ openaiRoutes } = await import("./openai.js"))
})

type UpstreamHandler = (req: {
  url: string
  method: string
  body: unknown
  authorization: string | undefined
}) => { status?: number; body?: unknown; raw?: string; contentType?: string }

function startUpstream(handler: UpstreamHandler): Promise<{
  origin: string
  close: () => Promise<void>
  server: Server
}> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      let buffer = ""
      req.setEncoding("utf8")
      req.on("data", (chunk) => (buffer += chunk))
      req.on("end", () => {
        const body = buffer.length > 0 ? JSON.parse(buffer) : undefined
        const result = handler({
          url: req.url ?? "",
          method: req.method ?? "GET",
          body,
          authorization: req.headers.authorization,
        })
        res.statusCode = result.status ?? 200
        res.setHeader("content-type", result.contentType ?? "application/json")
        if (result.raw !== undefined) {
          res.end(result.raw)
        } else {
          res.end(JSON.stringify(result.body ?? {}))
        }
      })
    })
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      const address = server.address()
      if (!address || typeof address !== "object") {
        reject(new Error("could not start upstream"))
        return
      }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r())
          }),
        server,
      })
    })
  })
}

type AppOpts = {
  authed?: boolean
  orgId?: string | null
  upstreamUrl?: string
  apiKey?: string
  modelProvider?: string
  bedrockRegion?: string
  allowedChatModels?: string[]
  allowedEmbeddingModels?: string[]
}

function appWithRoutes(opts: AppOpts): OpenAPIHono<AppEnv> {
  const env: Partial<Record<string, string>> = {
    AUTH_BASE_URL: "https://backend.example.com",
  }
  if (opts.upstreamUrl) env.MODEL_PROVIDER_URL = opts.upstreamUrl
  if (opts.apiKey) env.MODEL_PROVIDER_API_KEY = opts.apiKey
  if (opts.modelProvider) env.MODEL_PROVIDER = opts.modelProvider
  if (opts.bedrockRegion) env.MODEL_BEDROCK_AWS_REGION = opts.bedrockRegion
  const chat = opts.allowedChatModels ?? ["gpt-5.4-nano", "gpt-5.4-mini"]
  if (chat[0]) env.MODEL_FAST_NAME = chat[0]
  if (chat[1]) env.MODEL_MEDIUM_NAME = chat[1]
  if (chat[2]) env.MODEL_HIGH_NAME = chat[2]
  const embeddings = opts.allowedEmbeddingModels ?? ["text-embedding-3-small"]
  if (embeddings[0]) env.MODEL_EMBEDDING_NAME = embeddings[0]

  const app = new OpenAPIHono<AppEnv>().basePath("/:orgSlug/api/v1/openai")
  app.use("*", async (c, next) => {
    c.set("env", env as AppEnv["Variables"]["env"])
    if (opts.authed) {
      c.set("user", {
        id: "user_test",
        email: "test@example.com",
      } as AppEnv["Variables"]["user"])
      c.set("session", {
        id: "sess_test",
        userId: "user_test",
      } as AppEnv["Variables"]["session"])
    } else {
      c.set("user", null)
      c.set("session", null)
    }
    c.set("orgSlug", c.req.param("orgSlug") ?? null)
    c.set("orgId", opts.orgId ?? null)
    await next()
  })
  app.route("/", openaiRoutes)
  return app
}

describe("v1/openai proxy", () => {
  let upstream: Awaited<ReturnType<typeof startUpstream>> | null = null

  beforeEach(() => {
    upstream = null
    chatBedrockConverseConstructor.mockClear()
    mockChatInvoke.mockClear()
    mockBedrockSend.mockReset()
  })
  afterEach(async () => {
    if (upstream) {
      await upstream.close()
      upstream = null
    }
  })

  it("returns 401 when no user/session is set (signed-out)", async () => {
    const app = appWithRoutes({ authed: false, orgId: "org_acme" })
    const res = await app.request("/acme/api/v1/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-nano",
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(401)
  })

  it("returns 404 when the org slug isn't bound (withNetworkOrgContext upstream sets orgId=null)", async () => {
    const app = appWithRoutes({ authed: true, orgId: null })
    const res = await app.request("/missing/api/v1/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-nano",
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(404)
  })

  it("returns 503 with a structured payload when no upstream API key is configured", async () => {
    const app = appWithRoutes({ authed: true, orgId: "org_acme" })
    const res = await app.request("/acme/api/v1/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-nano",
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { status: string; reason: string; message: string }
    expect(body.status).toBe("enhanced-memory-unavailable")
    expect(body.reason).toBe("no-upstream-key")
    expect(body.message).toMatch(/MODEL_PROVIDER_API_KEY/)
    expect(body.message).toMatch(/MODEL_PROVIDER=bedrock/)
  })

  it("rejects models not in the allowlist with 400", async () => {
    upstream = await startUpstream(() => ({ body: { ok: true } }))
    const app = appWithRoutes({
      authed: true,
      orgId: "org_acme",
      upstreamUrl: upstream.origin,
      apiKey: "sk-upstream",
      allowedChatModels: ["gpt-5.4-nano"],
    })
    const res = await app.request("/acme/api/v1/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-banned",
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; allowedModels: string[] }
    expect(body.error).toMatch(/model not allowed/i)
    expect(body.allowedModels).toContain("gpt-5.4-nano")
  })

  it("allows chat when request model matches configured spec base id", async () => {
    let seen: { body?: unknown } = {}
    upstream = await startUpstream((req) => {
      seen = req
      return {
        body: {
          id: "chatcmpl-spec",
          choices: [{ message: { role: "assistant", content: "ok" } }],
        },
      }
    })
    const app = appWithRoutes({
      authed: true,
      orgId: "org_acme",
      upstreamUrl: upstream.origin,
      apiKey: "sk-upstream",
      allowedChatModels: [
        "openai/gpt-5.5?reasoning.effort=low",
        "openai/gpt-5.5?reasoning.effort=medium",
        "openai/gpt-5.5?reasoning.effort=high",
      ],
    })
    const res = await app.request("/acme/api/v1/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(200)
    expect(seen.body).toMatchObject({ model: "openai/gpt-5.5" })
  })

  it("returns base model ids in allowlist error when specs include query params", async () => {
    upstream = await startUpstream(() => ({ body: { ok: true } }))
    const app = appWithRoutes({
      authed: true,
      orgId: "org_acme",
      upstreamUrl: upstream.origin,
      apiKey: "sk-upstream",
      allowedChatModels: [
        "openai/gpt-5.5?reasoning.effort=low",
        "openai/gpt-5.5?reasoning.effort=medium",
      ],
    })
    const res = await app.request("/acme/api/v1/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-banned",
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { allowedModels: string[] }
    expect(body.allowedModels).toEqual(["openai/gpt-5.5"])
  })

  it("handles Bedrock chat via native ChatBedrockConverse when MODEL_PROVIDER=bedrock", async () => {
    const app = appWithRoutes({
      authed: true,
      orgId: "org_acme",
      modelProvider: "bedrock",
      bedrockRegion: "us-east-1",
    })
    const res = await app.request("/acme/api/v1/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-nano",
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(200)
    expect(chatBedrockConverseConstructor).toHaveBeenCalled()
    expect(mockChatInvoke).toHaveBeenCalled()
    const call = chatBedrockConverseConstructor.mock.calls[0]?.[0] as {
      model?: string
      region?: string
    }
    expect(call?.model).toBe("gpt-5.4-nano")
    expect(call?.region).toBe("us-east-1")
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>
    }
    expect(body.choices[0]?.message.content).toBe("from bedrock")
  })

  it("forwards chat completions to upstream with the server-side API key", async () => {
    let seen: {
      authorization?: string
      url?: string
      body?: unknown
    } = {}
    upstream = await startUpstream((req) => {
      seen = req
      return {
        body: {
          id: "chatcmpl-1",
          choices: [{ message: { role: "assistant", content: "hi back" } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        },
      }
    })
    const app = appWithRoutes({
      authed: true,
      orgId: "org_acme",
      upstreamUrl: upstream.origin,
      apiKey: "sk-upstream-secret",
    })
    const res = await app.request("/acme/api/v1/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer ctxpipe-user-token",
      },
      body: JSON.stringify({
        model: "gpt-5.4-nano",
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(200)
    expect(seen.authorization).toBe("Bearer sk-upstream-secret")
    expect(seen.url).toBe("/v1/chat/completions")
    expect(seen.body).toMatchObject({ model: "gpt-5.4-nano" })
    const body = (await res.json()) as { id: string }
    expect(body.id).toBe("chatcmpl-1")
  })

  it("passes streaming SSE bodies through unchanged", async () => {
    const sse = [
      `data: {"id":"x","choices":[{"delta":{"content":"hello"}}]}`,
      ``,
      `data: {"id":"x","choices":[{"delta":{"content":" world"}}]}`,
      ``,
      `data: [DONE]`,
      ``,
    ].join("\n")
    upstream = await startUpstream(() => ({
      contentType: "text/event-stream",
      raw: sse,
    }))
    const app = appWithRoutes({
      authed: true,
      orgId: "org_acme",
      upstreamUrl: upstream.origin,
      apiKey: "sk-upstream",
    })
    const res = await app.request("/acme/api/v1/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-nano",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()
    expect(text).toContain(`"delta":{"content":"hello"}`)
    expect(text).toContain(`[DONE]`)
  })

  it("forwards embedding calls to /v1/embeddings", async () => {
    let seen: {
      url?: string
      authorization?: string
      body?: unknown
    } = {}
    upstream = await startUpstream((req) => {
      seen = req
      return {
        body: {
          object: "list",
          data: [{ embedding: [0.1, 0.2], index: 0 }],
        },
      }
    })
    const app = appWithRoutes({
      authed: true,
      orgId: "org_acme",
      upstreamUrl: upstream.origin,
      apiKey: "sk-upstream",
    })
    const res = await app.request("/acme/api/v1/openai/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: "hello",
      }),
    })
    expect(res.status).toBe(200)
    expect(seen.url).toBe("/v1/embeddings")
    expect(seen.authorization).toBe("Bearer sk-upstream")
    expect(seen.body).toMatchObject({ model: "text-embedding-3-small" })
    const body = (await res.json()) as { data: Array<{ embedding: number[] }> }
    expect(body.data[0]?.embedding).toEqual([0.1, 0.2])
  })

  it("handles Bedrock embeddings via native InvokeModel", async () => {
    const embedding = new Array(1536).fill(0.03)
    mockBedrockSend.mockResolvedValue({
      body: new TextEncoder().encode(
        JSON.stringify({ embeddings: { float: [embedding] } }),
      ),
    })
    const app = appWithRoutes({
      authed: true,
      orgId: "org_acme",
      modelProvider: "bedrock",
      bedrockRegion: "us-east-1",
      allowedEmbeddingModels: ["cohere.embed-v4:0"],
    })
    const res = await app.request("/acme/api/v1/openai/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "cohere.embed-v4:0",
        input: "hello",
      }),
    })
    expect(res.status).toBe(200)
    expect(mockBedrockSend).toHaveBeenCalled()
    const body = (await res.json()) as { data: Array<{ embedding: number[] }> }
    expect(body.data[0]?.embedding).toHaveLength(2000)
  })

  it("surfaces upstream 4xx responses to the caller", async () => {
    upstream = await startUpstream(() => ({
      status: 429,
      body: { error: { message: "rate limited" } },
    }))
    const app = appWithRoutes({
      authed: true,
      orgId: "org_acme",
      upstreamUrl: upstream.origin,
      apiKey: "sk-upstream",
    })
    const res = await app.request("/acme/api/v1/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-nano",
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(429)
  })
})
