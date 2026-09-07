import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { OpenAPIHono } from "@hono/zod-openapi"
import type { ModelMessage } from "@tanstack/ai"
import { reconstructChat } from "@tanstack/ai-persistence"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest"
import type { AppEnv } from "../../app/env.js"
import { withUserIdContext } from "../../auth/context.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations, users } from "../../db/schema/auth.js"
import { conversations } from "../../db/schema/conversations.js"
import {
  workspaceSandboxInstances,
  workspaces,
} from "../../db/schema/workspaces.js"
import { workspaceChatOpenaiRoutes } from "../../routes/v1/workspace-chat-openai.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import { withTestLogger } from "../../test/with-test-logger.js"
import { destroySandboxesForConversation } from "./sandbox-registry.js"
import { streamTanstackWorkspaceChat } from "./tanstack-workspace-chat.js"
import { workspaceChatPersistence } from "./workspace-chat-persistence.js"

config({
  path: resolve(import.meta.dirname, "../../../.env.local"),
  quiet: true,
})

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required; run pnpm --filter @ctxpipe/backend test against a migrated Postgres (ctxpipe_app after owner migrate)",
  )
}

const runId = `chatlive_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
const org = {
  id: `${runId}_org`,
  slug: `${runId}-org`,
  name: "Live multi-turn org",
}
const userId = `${runId}_user`
const workspaceId = `ws_${runId}`
const conversationId = `conv_${runId}`
const llmOrigin = "https://llm.msw.test"

const savedHome = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  OPENCODE_AUTH_CONTENT: process.env.OPENCODE_AUTH_CONTENT,
  MODEL_PROVIDER: process.env.MODEL_PROVIDER,
  MODEL_PROVIDER_API_KEY: process.env.MODEL_PROVIDER_API_KEY,
  MODEL_PROVIDER_URL: process.env.MODEL_PROVIDER_URL,
  MODEL_FAST_NAME: process.env.MODEL_FAST_NAME,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  SANDBOX_PROVIDER: process.env.SANDBOX_PROVIDER,
}
const temporaryHomes: string[] = []

function lastUserText(body: {
  messages?: Array<{ role?: string; content?: unknown }>
}): string {
  const messages = body.messages ?? []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== "user") continue
    return typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content ?? "")
  }
  return ""
}

function openaiSse(content: string, model: string) {
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl_msw",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(finish === "stop"
        ? {
            usage: {
              prompt_tokens: 8,
              completion_tokens: 3,
              total_tokens: 11,
            },
          }
        : {}),
    })}\n\n`
  return `${chunk({ role: "assistant" }, null)}${chunk({ content }, null)}${chunk({}, "stop")}data: [DONE]\n\n`
}

function openaiJson(content: string, model: string) {
  return {
    id: "chatcmpl_msw",
    object: "chat.completion",
    created: 1,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  }
}

const server = setupServer(
  http.post(`${llmOrigin}/v1/chat/completions`, async ({ request }) => {
    const body = (await request.json()) as {
      model?: string
      stream?: boolean
      messages?: Array<{ role?: string; content?: unknown }>
    }
    const user = lastUserText(body)
    const content = user.includes("ping-2")
      ? "pong-2"
      : user.includes("ping-1")
        ? "pong-1"
        : "pong-1"
    const model = body.model ?? "openai/gpt-5.6-terra"
    if (body.stream) {
      return new HttpResponse(openaiSse(content, model), {
        headers: { "content-type": "text/event-stream" },
      })
    }
    return HttpResponse.json(openaiJson(content, model))
  }),
)

function makeGitRepo(): { url: string; ref: string } {
  const dir = mkdtempSync(join(tmpdir(), "ws-multiturn-"))
  execSync("git init -b main", { cwd: dir })
  writeFileSync(join(dir, "README.md"), "live workspace\n")
  execSync(
    "git add README.md && git -c user.email=live@ctxpipe.test -c user.name=live commit -m init",
    { cwd: dir },
  )
  const sha = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim()
  return { url: dir, ref: sha }
}

function isolateHome(): void {
  const home = mkdtempSync(join(tmpdir(), "opencode-home-"))
  temporaryHomes.push(home)
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

const source = makeGitRepo()
const savedPort = process.env.PORT
const proxyApp = new OpenAPIHono<AppEnv>()
proxyApp.use(contextStorage())
proxyApp.use(withTestRequestLogger)
proxyApp.use("*", async (c, next) => {
  c.set("env", parseEnv(process.env))
  await next()
})
proxyApp.route(
  `/${org.slug}/api/v1/workspace-chat/openai`,
  workspaceChatOpenaiRoutes,
)
const proxy = createServer((request, response) => {
  void (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const result = await proxyApp.request(
      new URL(request.url ?? "/", "http://127.0.0.1"),
      {
        method: request.method,
        headers: request.headers as HeadersInit,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : Buffer.concat(chunks),
      },
    )
    response.writeHead(result.status, Object.fromEntries(result.headers))
    if (result.body) {
      for await (const chunk of result.body) response.write(chunk)
    }
    response.end()
  })().catch((error) => response.destroy(error))
})

describe("live two-turn workspace chat", () => {
  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "bypass" })
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
    const address = proxy.address()
    if (!address || typeof address === "string")
      throw new Error("Expected TCP proxy listener")
    process.env.PORT = String(address.port)
    initDb(databaseUrl)
    const now = new Date()
    const db = getSystemDb()
    await db.insert(users).values({
      id: userId,
      name: "Live chat user",
      email: `${runId}@ctxpipe.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    await db
      .insert(organizations)
      .values({ id: org.id, name: org.name, slug: org.slug, createdAt: now })
    await withOrgDbContext(org.id, async (db) => {
      await db.insert(workspaces).values({
        id: workspaceId,
        orgId: org.id,
        slug: `ws-${runId}`,
        displayName: "Live multi-turn workspace",
        workspaceRepositoryUrl: source.url,
        desiredSha: source.ref,
      })
      await db.insert(conversations).values({
        id: conversationId,
        orgId: org.id,
        userId,
        name: "Two-turn live chat",
        workspaceId,
      })
    })
  })

  afterAll(async () => {
    try {
      await withTestLogger(() =>
        withOrgIdContext(org, () =>
          destroySandboxesForConversation(conversationId),
        ),
      )
      await withOrgDbContext(org.id, async (db) => {
        await db
          .delete(workspaceSandboxInstances)
          .where(eq(workspaceSandboxInstances.workspaceId, workspaceId))
        await db
          .delete(conversations)
          .where(eq(conversations.id, conversationId))
        await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
      })
      const system = getSystemDb()
      await system.delete(organizations).where(eq(organizations.id, org.id))
      await system.delete(users).where(eq(users.id, userId))
    } finally {
      proxy.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      )
      server.close()
      if (savedPort === undefined) delete process.env.PORT
      else process.env.PORT = savedPort
      await closeDb()
      rmSync(source.url, { recursive: true, force: true })
      for (const home of temporaryHomes)
        rmSync(home, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    isolateHome()
    process.env.MODEL_PROVIDER = "openai-like"
    process.env.MODEL_PROVIDER_API_KEY = "sk-msw-chat"
    process.env.MODEL_PROVIDER_URL = `${llmOrigin}/v1`
    process.env.MODEL_FAST_NAME = "openai/gpt-5.6-terra"
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENROUTER_API_KEY
    delete process.env.SANDBOX_PROVIDER
  })

  afterEach(() => {
    server.resetHandlers()
    restoreHome()
  })

  async function collectTurn(
    prompt: string,
    extras?: {
      messages?: ModelMessage[]
      runId?: string
    },
  ) {
    const chunks: Array<{ type?: string; delta?: string; message?: string }> =
      []
    await withTestLogger(() =>
      withOrgIdContext({ id: org.id, slug: org.slug }, () =>
        withUserIdContext(userId, async () => {
          for await (const chunk of streamTanstackWorkspaceChat({
            conversationId,
            prompt,
            messages: extras?.messages,
            threadId: conversationId,
            runId: extras?.runId,
            orgId: org.id,
            orgSlug: org.slug,
            workspaceId,
            desiredUrl: source.url,
            desiredSha: source.ref,
            ref: source.ref,
            writeStatus: "read_only",
          })) {
            chunks.push(
              chunk as { type?: string; delta?: string; message?: string },
            )
          }
        }),
      ),
    )
    return chunks
  }

  function assistantText(
    chunks: Array<{ type?: string; delta?: string }>,
  ): string {
    return chunks
      .filter((chunk) => chunk.type === "TEXT_MESSAGE_CONTENT")
      .map((chunk) => chunk.delta ?? "")
      .join("")
  }

  it(
    "streams exact mocked replies across two live OpenCode turns",
    { timeout: 180_000 },
    async () => {
      const first = await collectTurn("ping-1")
      const firstErrors = first
        .filter((chunk) => chunk.type === "RUN_ERROR")
        .map((chunk) => chunk.message ?? "")
      expect(firstErrors).toEqual([])
      expect(first.some((chunk) => chunk.type === "RUN_FINISHED")).toBe(true)
      expect(assistantText(first)).toBe("pong-1")

      const persisted = await withOrgIdContext(org, () =>
        workspaceChatPersistence().stores.messages.loadThread(conversationId),
      )
      expect(JSON.stringify(persisted)).toContain("pong-1")
      const reconstructed = await withOrgIdContext(org, () =>
        reconstructChat(
          workspaceChatPersistence(),
          new Request(`http://127.0.0.1/chat?threadId=${conversationId}`),
          { authorize: async (threadId) => threadId === conversationId },
        ),
      )
      expect(reconstructed.status).toBe(200)
      expect(await reconstructed.text()).toContain("pong-1")

      const second = await collectTurn("ping-2", {
        messages: [...persisted, { role: "user", content: "ping-2" }],
        runId: "run_second",
      })
      const secondErrors = second
        .filter((chunk) => chunk.type === "RUN_ERROR")
        .map((chunk) => chunk.message ?? "")
      expect(secondErrors).toEqual([])
      expect(second.some((chunk) => chunk.type === "RUN_FINISHED")).toBe(true)
      expect(assistantText(second)).toBe("pong-2")

      const rows = await withOrgDbContext(org.id, async (db) =>
        db
          .select({ id: workspaceSandboxInstances.id })
          .from(workspaceSandboxInstances)
          .where(eq(workspaceSandboxInstances.conversationId, conversationId)),
      )
      expect(rows).toHaveLength(1)
      await withTestLogger(() =>
        withOrgIdContext(org, () =>
          destroySandboxesForConversation(conversationId),
        ),
      )
      const remaining = await withOrgDbContext(org.id, (db) =>
        db
          .select()
          .from(workspaceSandboxInstances)
          .where(eq(workspaceSandboxInstances.conversationId, conversationId)),
      )
      expect(remaining).toEqual([])
    },
  )
})
