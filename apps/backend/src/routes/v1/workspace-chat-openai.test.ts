import { createServer, type Server } from "node:http"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OpenAPIHono } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { mintWorkspaceChatToken } from "../../domain/workspaces/workspace-chat-token.js"
import { contextStorage, withTestRequestLogger } from "../../test/hono-test-logger.js"
import { workspaceChatOpenaiRoutes } from "./workspace-chat-openai.js"

const AUTH_SECRET = "abcdefghijklmnopqrstuvwxyz123456"

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

function appWithRoutes(input: {
  upstreamUrl?: string
  apiKey?: string
  fastModel?: string
}): OpenAPIHono<AppEnv> {
  const env: Partial<Record<string, string | number>> = {
    AUTH_BASE_URL: "https://backend.example.com",
    AUTH_SECRET,
    PORT: 3000,
    MODEL_PROVIDER: "openai-like",
  }
  if (input.upstreamUrl) env.MODEL_PROVIDER_URL = input.upstreamUrl
  if (input.apiKey) env.MODEL_PROVIDER_API_KEY = input.apiKey
  env.MODEL_FAST_NAME = input.fastModel ?? "openai/gpt-5.6-terra"

  const app = new OpenAPIHono<AppEnv>().basePath(
    "/:orgSlug/api/v1/workspace-chat/openai",
  )
  app.use(contextStorage())
  app.use(withTestRequestLogger)
  app.use("*", async (c, next) => {
    c.set("env", env as AppEnv["Variables"]["env"])
    c.set("user", {
      id: "user_session",
      email: "user@example.com",
    } as AppEnv["Variables"]["user"])
    c.set("session", {
      id: "sess_user",
      userId: "user_session",
    } as AppEnv["Variables"]["session"])
    c.set("orgSlug", c.req.param("orgSlug") ?? null)
    c.set("orgId", "org_1")
    await next()
  })
  app.route("/", workspaceChatOpenaiRoutes)
  return app
}

function chatToken(now = Date.now()): string {
  return mintWorkspaceChatToken({
    authSecret: AUTH_SECRET,
    orgId: "org_1",
    conversationId: "conv_1",
    now,
  })
}

describe("workspace-chat openai completions", () => {
  let upstream: Awaited<ReturnType<typeof startUpstream>> | null = null

  beforeEach(() => {
    upstream = null
  })
  afterEach(async () => {
    if (upstream) {
      await upstream.close()
      upstream = null
    }
  })

  it("returns 401 without a chat token", async () => {
    const app = appWithRoutes({})
    const res = await app.request(
      "/acme/api/v1/workspace-chat/openai/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.6-terra",
          messages: [{ role: "user", content: "hi" }],
        }),
      },
    )
    expect(res.status).toBe(401)
  })

  it("rejects a user session token", async () => {
    const app = appWithRoutes({})
    const res = await app.request(
      "/acme/api/v1/workspace-chat/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer sess_user",
        },
        body: JSON.stringify({
          model: "openai/gpt-5.6-terra",
          messages: [{ role: "user", content: "hi" }],
        }),
      },
    )
    expect(res.status).toBe(401)
  })

  it("forwards completions with a minted chat token and forces the locked model", async () => {
    let seen: { body?: unknown; authorization?: string } = {}
    upstream = await startUpstream((req) => {
      seen = req
      return {
        body: {
          id: "chatcmpl_ws",
          choices: [{ message: { role: "assistant", content: "ok" } }],
        },
      }
    })
    const app = appWithRoutes({
      upstreamUrl: upstream.origin,
      apiKey: "sk-upstream",
      fastModel: "openai/gpt-5.6-terra",
    })
    const res = await app.request(
      "/acme/api/v1/workspace-chat/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${chatToken()}`,
        },
        body: JSON.stringify({
          model: "anthropic/claude-sonnet-4-5",
          messages: [{ role: "user", content: "hi" }],
        }),
      },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      choices: [{ message: { content: "ok" } }],
    })
    expect(seen.authorization).toBe("Bearer sk-upstream")
    expect(seen.body).toMatchObject({
      model: "openai/gpt-5.6-terra",
      messages: [{ role: "user", content: "hi" }],
    })
  })

  it("rejects embeddings", async () => {
    const app = appWithRoutes({
      apiKey: "sk-upstream",
    })
    const res = await app.request(
      "/acme/api/v1/workspace-chat/openai/v1/embeddings",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${chatToken()}`,
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: "hi",
        }),
      },
    )
    expect(res.status).toBe(404)
  })

  it("forwards to OpenRouter when MODEL_PROVIDER_URL is unset", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input)
      expect(url).toBe("https://openrouter.ai/api/v1/chat/completions")
      return new Response(
        JSON.stringify({
          id: "chatcmpl_or",
          choices: [{ message: { role: "assistant", content: "ok" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    })
    vi.stubGlobal("fetch", fetchMock)
    try {
      const app = appWithRoutes({ apiKey: "sk-or-v1-test" })
      const res = await app.request(
        "/acme/api/v1/workspace-chat/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${chatToken()}`,
          },
          body: JSON.stringify({
            model: "openai/gpt-5.6-terra",
            messages: [{ role: "user", content: "hi" }],
          }),
        },
      )
      expect(res.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
