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
import { organizations } from "../../db/schema/auth.js"
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

/** Same gate as tanstack-workspace-chat.live.test.ts — default CI has no OpenCode CLI. */
const live = process.env.OPENCODE_LIVE === "1"
const databaseUrl = process.env.DATABASE_URL
if (live && !databaseUrl) {
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
const workspaceId = `ws_${runId}`
const conversationId = `conv_${runId}`
const userId = `user_${runId}`
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

const source = live ? makeGitRepo() : { url: "", ref: "" }

describe.skipIf(!live)("live two-turn workspace chat", () => {
  beforeAll(async () => {
    server.listen({
      onUnhandledRequest: (req) => {
        if (req.url.startsWith(llmOrigin)) {
          throw new Error(`unhandled LLM request ${req.method} ${req.url}`)
        }
      },
    })
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for OPENCODE_LIVE")
    }
    initDb(databaseUrl)
    const now = new Date()
    await getSystemDb()
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
      await getSystemDb()
        .delete(organizations)
        .where(eq(organizations.id, org.id))
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
      expect(
        first
          .filter((chunk) => chunk.type === "RUN_ERROR")
          .map((chunk) => chunk.message),
      ).toEqual([])
      expect(first.some((chunk) => chunk.type === "RUN_FINISHED")).toBe(true)
      expect(assistantText(first)).toBe("pong-1")

      const second = await collectTurn("ping-2", {
        messages: [
          { role: "user", content: "ping-1" },
          { role: "assistant", content: "pong-1" },
          { role: "user", content: "ping-2" },
        ],
        runId: "run_second",
      })
      expect(
        second
          .filter((chunk) => chunk.type === "RUN_ERROR")
          .map((chunk) => chunk.message),
      ).toEqual([])
      expect(second.some((chunk) => chunk.type === "RUN_FINISHED")).toBe(true)
      expect(assistantText(second)).toBe("pong-2")

      const turns = await withOrgDbContext(org.id, async (db) =>
        db
          .select({
            role: conversationMessages.role,
            content: conversationMessages.content,
          })
          .from(conversationMessages)
          .where(eq(conversationMessages.conversationId, conversationId))
          .orderBy(conversationMessages.seq),
      )
      expect(turns).toEqual([
        { role: "user", content: "ping-1" },
        { role: "assistant", content: "pong-1" },
        { role: "user", content: "ping-2" },
        { role: "assistant", content: "pong-2" },
      ])
    },
  )
})
