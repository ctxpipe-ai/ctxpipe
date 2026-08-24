import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
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
import { withUserIdContext } from "../../auth/context.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations, users } from "../../db/schema/auth.js"
import {
  conversationMessages,
  conversations,
} from "../../db/schema/conversations.js"
import {
  workspaceSandboxInstances,
  workspaces,
} from "../../db/schema/workspaces.js"
import { withTestLogger } from "../../test/with-test-logger.js"
import { streamTanstackWorkspaceChat } from "./tanstack-workspace-chat.js"

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
}

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
const live = process.env.OPENCODE_LIVE === "1"

describe.skipIf(!live)("live two-turn workspace chat", () => {
  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "bypass" })
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
    server.close()
    try {
      await withOrgDbContext(org.id, async (db) => {
        await db
          .delete(workspaceSandboxInstances)
          .where(eq(workspaceSandboxInstances.workspaceId, workspaceId))
        await db
          .delete(conversationMessages)
          .where(eq(conversationMessages.conversationId, conversationId))
        await db
          .delete(conversations)
          .where(eq(conversations.id, conversationId))
        await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
      })
      const system = getSystemDb()
      await system.delete(organizations).where(eq(organizations.id, org.id))
      await system.delete(users).where(eq(users.id, userId))
    } finally {
      await closeDb()
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
      messages?: Array<{ role: string; content: string }>
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
      expect(
        firstErrors.filter((message) =>
          /ServeError|EADDRINUSE|port \d+ still bound/i.test(message),
        ),
      ).toEqual([])

      const second = await collectTurn("ping-2", {
        messages: [
          { role: "user", content: "ping-1" },
          { role: "assistant", content: "pong-1" },
          { role: "user", content: "ping-2" },
        ],
        runId: "run_second",
      })
      const secondErrors = second
        .filter((chunk) => chunk.type === "RUN_ERROR")
        .map((chunk) => chunk.message ?? "")
      expect(
        secondErrors.filter((message) =>
          /ServeError|EADDRINUSE|port \d+ still bound/i.test(message),
        ),
      ).toEqual([])

      const [rows, turns] = await withOrgDbContext(org.id, async (db) => {
        const sandboxes = await db
          .select({ id: workspaceSandboxInstances.id })
          .from(workspaceSandboxInstances)
          .where(eq(workspaceSandboxInstances.conversationId, conversationId))
        const messages = await db
          .select({
            role: conversationMessages.role,
            content: conversationMessages.content,
          })
          .from(conversationMessages)
          .where(eq(conversationMessages.conversationId, conversationId))
          .orderBy(conversationMessages.seq)
        return [sandboxes, messages] as const
      })
      expect(rows).toHaveLength(1)

      expect(turns.filter((turn) => turn.role === "user")).toEqual([
        { role: "user", content: "ping-1" },
        { role: "user", content: "ping-2" },
      ])
      const assistants = turns.filter((turn) => turn.role === "assistant")
      for (const turn of assistants) {
        expect(["pong-1", "pong-2"]).toContain(turn.content)
      }
      const firstText = assistantText(first)
      const secondText = assistantText(second)
      if (
        first.some((chunk) => chunk.type === "RUN_FINISHED") &&
        second.some((chunk) => chunk.type === "RUN_FINISHED") &&
        firstText === "pong-1" &&
        secondText === "pong-2"
      ) {
        expect(assistants).toEqual([
          { role: "assistant", content: "pong-1" },
          { role: "assistant", content: "pong-2" },
        ])
      }
    },
  )
})
