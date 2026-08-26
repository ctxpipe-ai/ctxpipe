import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chat } from "@tanstack/ai"
import { opencodeText } from "@tanstack/ai-opencode"
import {
  createSecrets,
  defineSandbox,
  defineWorkspace,
  fileSkill,
  gitSource,
  withSandbox,
} from "@tanstack/ai-sandbox"
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
import { OpenAPIHono } from "@hono/zod-openapi"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"
import { contextStorage, withTestRequestLogger } from "../../test/hono-test-logger.js"
import { withTestLogger } from "../../test/with-test-logger.js"
import { createDataStreamConversationTransport } from "../conversations/transport.js"
import { workspaceChatOpenaiRoutes } from "../../routes/v1/workspace-chat-openai.js"
import { WORKSPACE_CHAT_SANDBOX_SETUP } from "./chat-runtime.js"
import {
  WORKSPACE_CHAT_LOCAL_PROCESS_SCRUB_ENV,
  workspaceChatOpenCodeConfig,
  workspaceChatOpenCodeContract,
} from "./workspace-chat-opencode-contract.js"
import { mintWorkspaceChatToken } from "./workspace-chat-token.js"

const LIVE_AUTH_SECRET = "abcdefghijklmnopqrstuvwxyz123456"

const live = process.env.OPENCODE_LIVE === "1"

vi.mock("../../auth/config.js", () => ({
  getAuth: () => ({
    api: { getSession: async () => null },
  }),
}))

vi.mock("../../auth/withAuth.js", () => ({
  withOrgIdContext: async (_org: unknown, fn: () => unknown) => fn(),
}))

vi.mock("../../db/client.js", () => ({
  tryGetOrgDb: () => undefined,
  tryGetOrgDbOrgId: () => undefined,
  assertNotInOrgDbContext: () => undefined,
  withOrgDbContext: async (_orgId: string, fn: () => unknown) => fn(),
}))

vi.mock("../../graphs/conversationGraph/nodes/conversationNaming.js", () => ({
  nameConversationIfUnnamed: vi.fn().mockResolvedValue(null),
}))

vi.mock("../../models/conversation-messages.js", () => ({
  loadConversationTurns: vi.fn(async () => []),
  appendConversationTurn: vi.fn(async () => {}),
}))

vi.mock("../../models/conversations.js", () => ({
  getConversation: vi.fn(async (id: string) => ({
    id,
    orgId: "org_live",
    workspaceId: "ws_live",
  })),
}))

vi.mock("../../models/workspaces.js", () => ({
  persistSandboxInstance: vi.fn(async () => {}),
  deleteSandboxInstance: vi.fn(async () => {}),
  claimSandboxInstance: vi.fn(async (input: { id: string }) => ({
    record: input,
    inserted: true,
  })),
  listSandboxInstances: vi.fn(async () => []),
  heartbeatSandboxInstance: vi.fn(async () => {}),
  getSandboxInstance: vi.fn(async () => null),
  getWorkspaceById: vi.fn(async () => ({
    id: "ws_live",
    orgId: "org_live",
    workspaceRepositoryUrl: "https://github.com/acme/docs",
    activeProjectionUrl: null,
    activeProjectionSha: null,
    writeStatus: "read_only",
  })),
  listLinkedRepositories: vi.fn(async () => []),
  listWorkspaceKnowledgeUnits: vi.fn(async () => ({
    units: [],
    lastUpdatedAt: null,
  })),
  listWorkspaceKnowledgeUnitsForChat: vi.fn(async () => {
    throw new Error("skip retrieval tools in live fallback")
  }),
}))

vi.mock("../../retrieval/index.js", () => ({
  hybridSearch: async () => {
    throw new Error("skip hybrid search in live fallback")
  },
}))

vi.mock("../../retrieval/services/modelProvider.js", () => ({
  generateEmbedding: async () => {
    throw new Error("skip embeddings in live fallback")
  },
}))

const savedHome = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
}

describe.skipIf(!live)("workspace chat OpenCode fallback (live)", () => {
  it("scrubs host provider keys from the local-process env", async () => {
    process.env.MODEL_PROVIDER_API_KEY = "sk-must-not-leak"
    process.env.ANTHROPIC_API_KEY = "sk-anthropic-must-not-leak"
    const provider = localProcessSandbox({
      scrubEnv: [...WORKSPACE_CHAT_LOCAL_PROCESS_SCRUB_ENV],
    })
    const handle = await provider.create({ id: "scrub-live" })
    try {
      const leaked = await handle.process.exec(
        "printenv MODEL_PROVIDER_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY || true",
      )
      expect(leaked.stdout).not.toContain("sk-must-not-leak")
      expect(leaked.stdout).not.toContain("sk-anthropic-must-not-leak")
    } finally {
      await handle.destroy()
    }
  })

  it(
    "streams a stub completion through the ctxpipe proxy on local_process",
    { timeout: 180_000 },
    async () => {
    isolateHome()
    const upstreamHits: Array<{
      host: string
      model: string
      path: string
      stream: boolean
      authorization: string | null
      messageCount: number
      keys: string[]
      max_tokens?: unknown
      stream_options?: unknown
      preview?: string
    }> = []
    const upstream = await listenOpenAiStub((req, url, body) => {
      const messages = Array.isArray(body.messages) ? body.messages : []
      upstreamHits.push({
        host: url.host,
        model: body.model ?? "",
        path: url.pathname,
        stream: body.stream === true,
        authorization: req.headers.authorization ?? null,
        messageCount: messages.length,
        keys: Object.keys(body).sort(),
        max_tokens: body.max_tokens,
        stream_options: body.stream_options,
        preview: JSON.stringify(messages).slice(0, 400),
      })
      return Array.isArray(body.tools)
        ? "I read the workspace README. fallback-stub-ok"
        : "Live Stub Title"
    })
    process.env.MODEL_PROVIDER = "openai-like"
    process.env.MODEL_PROVIDER_API_KEY = "sk-live-upstream"
    process.env.MODEL_PROVIDER_URL = `${upstream.baseUrl}/v1`
    process.env.MODEL_FAST_NAME = "openai/gpt-5.6-terra"
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENROUTER_API_KEY
    delete process.env.SANDBOX_PROVIDER

    const contract = workspaceChatOpenCodeContract(process.env)
    expect(contract.ok).toBe(true)
    if (!contract.ok) return

    const proxy = await listenWorkspaceChatOpenai({
      upstreamUrl: contract.upstreamBaseUrl,
      apiKey: contract.apiKey,
      conversationId: "conv_live_fallback",
    })
    const runToken = proxy.token
    const config = workspaceChatOpenCodeConfig({
      modelBase: contract.modelBase,
    })
    const configPath = join(tmpdir(), "ctxpipe-opencode-live.json")
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
    const source = makeGitRepo()
    const chunks: object[] = []
    try {
      const stream = chat({
        adapter: opencodeText(contract.opencodeModel, {
          port: 4096,
          permissionMode: "acceptEdits",
        }),
        threadId: "conv_live_fallback",
        messages: [{ role: "user", content: "say ok" }],
        middleware: [
          withSandbox(
            defineSandbox({
              id: `live:${source.ref}`,
              provider: localProcessSandbox({
                scrubEnv: [...WORKSPACE_CHAT_LOCAL_PROCESS_SCRUB_ENV],
              }),
              workspace: defineWorkspace({
                source: gitSource({ url: source.url, ref: source.ref }),
                setup: [...WORKSPACE_CHAT_SANDBOX_SETUP],
                secrets: createSecrets({
                  CTXPIPE_OPENCODE_RUN_TOKEN: runToken,
                  CTXPIPE_MODEL_PROXY_URL: proxy.baseUrl,
                }),
                skills: [
                  fileSkill({
                    path: "opencode.json",
                    content: `${JSON.stringify(config, null, 2)}\n`,
                  }),
                ],
              }),
              lifecycle: {
                reuse: "thread",
                snapshot: "after-setup",
                keepAlive: "5m",
              },
            }),
          ),
        ],
      })
      for await (const chunk of stream as AsyncIterable<object>) {
        chunks.push(chunk)
      }
    } finally {
      await proxy.close()
      await upstream.close()
    }

    const text = chunks
      .map((chunk) => {
        const record = chunk as { type?: string; delta?: string }
        return record.type === "TEXT_MESSAGE_CONTENT"
          ? (record.delta ?? "")
          : ""
      })
      .join("")
    const fatal = chunks.find((chunk) => {
      const record = chunk as { type?: string }
      return record.type === "RUN_ERROR"
    })
    expect(fatal).toBeUndefined()
    expect(chunks.some((chunk) => (chunk as { type?: string }).type === "RUN_FINISHED")).toBe(
      true,
    )
    expect(text.length).toBeGreaterThan(0)
    expect(upstreamHits.length).toBeGreaterThan(0)
    expect(
      upstreamHits.every((hit) => hit.model === "openai/gpt-5.6-terra"),
    ).toBe(true)
    expect(upstreamHits.some((hit) => hit.host.includes("anthropic"))).toBe(
      false,
    )
    expect(upstreamHits.some((hit) => hit.host.includes("openai.com"))).toBe(
      false,
    )
    expect(
      upstreamHits.every((hit) => hit.authorization === "Bearer sk-live-upstream"),
    ).toBe(true)
    },
  )

  it(
    "conversation POST streams through the same local_process fallback",
    { timeout: 180_000 },
    async () => {
      isolateHome()
      const upstreamHits: Array<{
        host: string
        model: string
        authorization: string | null
      }> = []
      const upstream = await listenOpenAiStub((req, url, body) => {
        upstreamHits.push({
          host: url.host,
          model: body.model ?? "",
          authorization: req.headers.authorization ?? null,
        })
        return Array.isArray(body.tools)
          ? "conversation-post-stub-ok"
          : "Conversation Post Title"
      })
      process.env.MODEL_PROVIDER = "openai-like"
      process.env.MODEL_PROVIDER_API_KEY = "sk-live-upstream"
      process.env.MODEL_PROVIDER_URL = `${upstream.baseUrl}/v1`
      process.env.MODEL_FAST_NAME = "openai/gpt-5.6-terra"
      process.env.AUTH_SECRET = LIVE_AUTH_SECRET
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.OPENAI_API_KEY
      delete process.env.OPENROUTER_API_KEY
      delete process.env.SANDBOX_PROVIDER

      const completions = await listenWorkspaceChatOpenai({
        upstreamUrl: `${upstream.baseUrl}/v1`,
        apiKey: "sk-live-upstream",
        conversationId: "conv_live_post",
      })
      process.env.PORT = String(completions.port)

      const source = makeGitRepo()
      const transport = createDataStreamConversationTransport()
      try {
        const res = await withTestLogger(() =>
          transport.toResponse({
            conversationId: "conv_live_post",
            checkpointNamespace: "",
            prompt: "say ok",
            orgId: "org_live",
            orgSlug: "acme",
            workspaceId: "ws_live",
            desiredUrl: source.url,
            desiredSha: source.ref,
            lastBranch: source.ref,
            writeStatus: "read_only",
          }),
        )
        expect(res.status).toBe(200)
        const body = await res.text()
        expect(body).not.toMatch(
          /Unexpected server error\. Check server logs for details\./,
        )
        expect(body.length).toBeGreaterThan(0)
        const started = body.indexOf("RUN_STARTED")
        const delta = body.search(/TEXT_MESSAGE_CONTENT|"delta":/)
        const finished = body.indexOf("RUN_FINISHED")
        expect(started).toBeGreaterThanOrEqual(0)
        expect(delta).toBeGreaterThan(started)
        if (finished >= 0) expect(delta).toBeLessThan(finished)
        expect(upstreamHits.length).toBeGreaterThan(0)
        expect(
          upstreamHits.every((hit) => hit.model === "openai/gpt-5.6-terra"),
        ).toBe(true)
        expect(
          upstreamHits.every(
            (hit) => hit.authorization === "Bearer sk-live-upstream",
          ),
        ).toBe(true)
        expect(upstreamHits.some((hit) => hit.host.includes("anthropic"))).toBe(
          false,
        )
        expect(upstreamHits.some((hit) => hit.host.includes("openai.com"))).toBe(
          false,
        )
      } finally {
        await completions.close()
        await upstream.close()
      }
    },
  )

  afterEach(() => {
    restoreHome()
  })
})

function isolateHome(): void {
  const home = mkdtempSync(join(tmpdir(), "opencode-home-"))
  process.env.HOME = home
  process.env.XDG_CONFIG_HOME = join(home, "config")
  process.env.XDG_DATA_HOME = join(home, "data")
  process.env.XDG_STATE_HOME = join(home, "state")
  process.env.XDG_CACHE_HOME = join(home, "cache")
  mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true })
  delete process.env.OPENCODE_AUTH_CONTENT
}

function restoreHome(): void {
  for (const [key, value] of Object.entries(savedHome)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function makeGitRepo(): { url: string; ref: string } {
  const dir = mkdtempSync(join(tmpdir(), "ws-live-"))
  execSync("git init -b main", { cwd: dir })
  writeFileSync(join(dir, "README.md"), "live workspace\n")
  execSync(
    "git add README.md && git -c user.email=live@ctxpipe.test -c user.name=live commit -m init",
    { cwd: dir },
  )
  const sha = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim()
  return { url: dir, ref: sha }
}

async function listenOpenAiStub(
  handler: (
    req: IncomingMessage,
    url: URL,
    body: {
      model?: string
      stream?: boolean
      messages?: unknown[]
      max_tokens?: unknown
      stream_options?: unknown
      reasoning_effort?: unknown
      tools?: unknown
    },
  ) => string,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`)
      const body = (
        chunks.length > 0
          ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
          : {}
      ) as {
        model?: string
        stream?: boolean
        messages?: unknown[]
        max_tokens?: unknown
        stream_options?: unknown
        tools?: unknown
      }
      const content = handler(req, url, body)
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl_live",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model ?? "openai/gpt-5.6-terra",
            choices: [
              { index: 0, delta: { role: "assistant" }, finish_reason: null },
            ],
          })}\n\n`,
        )
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl_live",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model ?? "openai/gpt-5.6-terra",
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          })}\n\n`,
        )
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl_live",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model ?? "openai/gpt-5.6-terra",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 8,
              completion_tokens: 3,
              total_tokens: 11,
            },
          })}\n\n`,
        )
        res.end("data: [DONE]\n\n")
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          id: "chatcmpl_live",
          object: "chat.completion",
          created: 1,
          model: body.model ?? "openai/gpt-5.6-terra",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              finish_reason: "stop",
            },
          ],
        }),
      )
    })()
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("expected tcp address")
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

async function listenWorkspaceChatOpenai(input: {
  upstreamUrl: string
  apiKey: string
  conversationId: string
}): Promise<{
  baseUrl: string
  port: number
  token: string
  close: () => Promise<void>
}> {
  const token = mintWorkspaceChatToken({
    authSecret: LIVE_AUTH_SECRET,
    orgId: "org_live",
    conversationId: input.conversationId,
  })
  const env = {
    AUTH_BASE_URL: "https://backend.example.com",
    AUTH_SECRET: LIVE_AUTH_SECRET,
    PORT: 3000,
    MODEL_PROVIDER: "openai-like",
    MODEL_PROVIDER_URL: input.upstreamUrl,
    MODEL_PROVIDER_API_KEY: input.apiKey,
    MODEL_FAST_NAME: "openai/gpt-5.6-terra",
  } as AppEnv["Variables"]["env"]
  const app = new OpenAPIHono<AppEnv>().basePath(
    "/:orgSlug/api/v1/workspace-chat/openai",
  )
  app.use(contextStorage())
  app.use(withTestRequestLogger)
  app.use("*", async (c, next) => {
    c.set("env", env)
    c.set("user", null)
    c.set("session", null)
    c.set("orgSlug", c.req.param("orgSlug") ?? null)
    c.set("orgId", "org_live")
    await next()
  })
  app.route("/", workspaceChatOpenaiRoutes)
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      const request = new Request(url, {
        method: req.method,
        headers: req.headers as HeadersInit,
        body:
          req.method === "GET" || req.method === "HEAD"
            ? undefined
            : Buffer.concat(chunks),
      })
      const response = await app.fetch(request)
      res.statusCode = response.status
      response.headers.forEach((value, key) => {
        res.setHeader(key, value)
      })
      res.end(Buffer.from(await response.arrayBuffer()))
    })()
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const listenAddress = server.address()
  if (!listenAddress || typeof listenAddress === "string") {
    throw new Error("expected tcp address")
  }
  return {
    baseUrl: `http://127.0.0.1:${listenAddress.port}/acme/api/v1/workspace-chat/openai/v1`,
    port: listenAddress.port,
    token,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
