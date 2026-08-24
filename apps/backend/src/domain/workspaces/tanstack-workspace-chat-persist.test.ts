import { resolve } from "node:path"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
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

type SandboxStore = {
  upsert: (record: {
    key: string
    provider: string
    providerSandboxId: string
    threadId: string
    updatedAt: number
  }) => Promise<void>
}

const captured = vi.hoisted(() => ({
  instances: null as SandboxStore | null,
}))

const chatMock = vi.hoisted(() =>
  vi.fn(async function* (opts: { threadId: string }) {
    const key = `thread:${opts.threadId}`
    const store = captured.instances
    if (!store) throw new Error("withSandbox did not provide an instance store")
    await store.upsert({
      key,
      provider: "local-process",
      providerSandboxId: `/tmp/tanstack-ai-sandboxes/${key}`,
      threadId: opts.threadId,
      updatedAt: Date.now(),
    })
    yield { type: "TEXT_MESSAGE_CONTENT", delta: "pong" }
    yield { type: "RUN_FINISHED" }
  }),
)

vi.mock("@tanstack/ai", () => ({
  chat: chatMock,
  toServerSentEventsResponse: vi.fn(),
  toHttpResponse: vi.fn(),
}))
vi.mock("@tanstack/ai-opencode", () => ({
  opencodeText: vi.fn(() => "adapter"),
}))
vi.mock("@tanstack/ai-sandbox", () => ({
  defineSandbox: vi.fn((input: unknown) => input),
  defineWorkspace: vi.fn((input: unknown) => input),
  gitSource: vi.fn((input: unknown) => input),
  fileSkill: vi.fn((input: unknown) => input),
  createSecrets: vi.fn((values: Record<string, string>) => values),
  withSandbox: vi.fn((_def: unknown, opts: { instances: SandboxStore }) => {
    captured.instances = opts.instances
    return "mw"
  }),
}))
vi.mock("@tanstack/ai-sandbox-docker", () => ({
  dockerSandbox: vi.fn(() => "docker-provider"),
  sbxSandbox: vi.fn(() => "sbx-provider"),
}))
vi.mock("@tanstack/ai-sandbox-local-process", () => ({
  localProcessSandbox: vi.fn(() => "local-provider"),
}))
vi.mock("./workspace-chat-model-proxy.js", () => ({
  startWorkspaceChatModelProxy: vi.fn(async () => ({
    baseUrl: "http://127.0.0.1:18789",
    close: vi.fn(async () => {}),
  })),
}))
vi.mock("./workspace-chat-opencode-attach.js", () => ({
  streamAttachedOpenCodeTurn: vi.fn(async function* () {
    yield { type: "TEXT_MESSAGE_CONTENT", delta: "attached" }
  }),
  startConversationOpenCodeServe: vi.fn(async () => null),
}))
vi.mock("../../graphs/conversationGraph/nodes/conversationNaming.js", () => ({
  nameConversationIfUnnamed: vi.fn().mockResolvedValue(null),
}))

import { streamTanstackWorkspaceChat } from "./tanstack-workspace-chat.js"

const runId = `chattx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
const org = {
  id: `${runId}_org`,
  slug: `${runId}-org`,
  name: "Two-turn chat org",
}
const workspaceId = `ws_${runId}`
const conversationId = `conv_${runId}`
const desiredSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

beforeAll(async () => {
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
      displayName: "Two-turn workspace",
      workspaceRepositoryUrl: `https://github.com/ctxpipe-ai/${runId}`,
      desiredSha,
    })
    await db.insert(conversations).values({
      id: conversationId,
      orgId: org.id,
      name: "Two-turn conversation",
      workspaceId,
    })
  })
})

afterAll(async () => {
  try {
    await withOrgDbContext(org.id, async (db) => {
      await db
        .delete(workspaceSandboxInstances)
        .where(eq(workspaceSandboxInstances.workspaceId, workspaceId))
      await db
        .delete(conversationMessages)
        .where(eq(conversationMessages.conversationId, conversationId))
      await db.delete(conversations).where(eq(conversations.id, conversationId))
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
    })
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, org.id))
  } finally {
    await closeDb()
  }
})

beforeEach(async () => {
  captured.instances = null
  process.env.MODEL_PROVIDER = "openai-like"
  process.env.MODEL_PROVIDER_API_KEY = "sk-test-chat-persist"
  delete process.env.SANDBOX_PROVIDER
  const { resetWorkspaceChatConversationRuntimes } = await import(
    "./workspace-chat-conversation-runtime.js"
  )
  resetWorkspaceChatConversationRuntimes()
})

async function collectTurn(
  prompt: string,
  extras?: {
    messages?: Array<{ role: string; content: string }>
    runId?: string
  },
) {
  const chunks: Array<{ type?: string; delta?: string; runId?: string }> = []
  await withOrgIdContext({ id: org.id, slug: org.slug }, async () => {
    for await (const chunk of streamTanstackWorkspaceChat({
      conversationId,
      prompt,
      messages: extras?.messages,
      threadId: conversationId,
      runId: extras?.runId,
      orgId: org.id,
      workspaceId,
      desiredUrl: `https://github.com/ctxpipe-ai/${runId}`,
      desiredSha,
      ref: desiredSha,
      writeStatus: "writable",
    })) {
      chunks.push(chunk as { type?: string; delta?: string; runId?: string })
    }
  })
  return chunks
}

describe("two-turn workspace chat persist", () => {
  it("keeps one live sandbox and persists both turns on real Postgres", async () => {
    const first = await collectTurn("first question")
    const firstStarted = first.findIndex(
      (chunk) => chunk.type === "RUN_STARTED",
    )
    const firstDelta = first.findIndex(
      (chunk) =>
        chunk.type === "TEXT_MESSAGE_CONTENT" && chunk.delta === "pong",
    )
    const firstFinished = first.findIndex(
      (chunk) => chunk.type === "RUN_FINISHED",
    )
    expect(firstStarted).toBeGreaterThanOrEqual(0)
    expect(firstDelta).toBeGreaterThan(firstStarted)
    expect(firstFinished).toBeGreaterThan(firstDelta)

    const clientMessages = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "pong" },
      { role: "user", content: "second question" },
    ]
    const second = await collectTurn("second question", {
      messages: clientMessages,
      runId: "run_second",
    })
    expect(chatMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        threadId: conversationId,
        runId: "run_second",
        messages: clientMessages,
      }),
    )
    const secondStarted = second.findIndex(
      (chunk) => chunk.type === "RUN_STARTED",
    )
    expect(second[secondStarted]).toMatchObject({
      type: "RUN_STARTED",
      runId: "run_second",
    })
    const secondDelta = second.findIndex(
      (chunk) =>
        chunk.type === "TEXT_MESSAGE_CONTENT" && chunk.delta === "pong",
    )
    const secondFinished = second.findIndex(
      (chunk) => chunk.type === "RUN_FINISHED",
    )
    expect(secondStarted).toBeGreaterThanOrEqual(0)
    expect(secondDelta).toBeGreaterThan(secondStarted)
    expect(secondFinished).toBeGreaterThan(secondDelta)

    const [rows, turns] = await withOrgDbContext(org.id, async (db) => {
      const sandboxes = await db
        .select({
          id: workspaceSandboxInstances.id,
          state: workspaceSandboxInstances.state,
          kind: workspaceSandboxInstances.kind,
        })
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

    expect(rows).toEqual([
      { id: `thread:${conversationId}`, state: "live", kind: "chat" },
    ])
    expect(turns).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "pong" },
      { role: "user", content: "second question" },
      { role: "assistant", content: "pong" },
    ])
  })
})
