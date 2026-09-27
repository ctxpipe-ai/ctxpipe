import { rm } from "node:fs/promises"
import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import {
  cleanupSeededOrg,
  describeWithDatabase,
  type SeededOrg,
  seedOrg,
} from "../../test/db.js"
import { mcpToolResult, mcpToolText } from "../../test/mcp-tool-result.js"
import { useMswServer } from "../../test/msw.js"
import { withOrgIdContext } from "../auth/withAuth.js"
import { getSystemDb, withOrgDbContext } from "../db/client.js"
import {
  chatInterrupts,
  chatMetadata,
  chatRuns,
  chatThreads,
} from "../db/schema/chat-persistence.js"
import { conversations } from "../db/schema/conversations.js"
import { orgFirstWorkspaces, workspaces } from "../db/schema/workspaces.js"
import { workspaceChatInstanceAccess } from "../domain/workspaces/sandbox-instance-store.js"
import { workspaceChatDockerOwnership } from "../domain/workspaces/tanstack-workspace-chat.js"
import { workspaceChatOpenCodeHomeDir } from "../domain/workspaces/workspace-chat-opencode-contract.js"
import { messagesForOpenCodeChat } from "../domain/workspaces/workspace-chat-opencode-messages.js"
import { workspaceChatPersistence } from "../domain/workspaces/workspace-chat-persistence.js"
import { destroySandboxesForWorkspace } from "../domain/workspaces/workspace-sandbox-cleanup.js"
import { listSandboxInstances } from "../models/workspaces.js"
import { startMcpAdvisorHttpChat } from "../test/mcp-advisor-http-chat.js"
import { withTestLogger } from "../test/with-test-logger.js"
import { mcpAdvisorThreadId } from "./advisorThread.js"

const FIRST_USER = "Remember the marble token for billing."
const FIRST_ASSISTANT = "First advisor reply: marble token noted."
const SECOND_USER = "What token should billing use?"
const SECOND_ASSISTANT = "Second advisor reply: still marble."
const PROJECT = "billing"
const SESSION = "session-replay"

const modelRequests: Array<Record<string, unknown>> = []

function openaiCompatibleChatResponse(input: {
  content: string
  stream?: boolean
}) {
  const model = "openai/gpt-5.6-terra"
  if (input.stream) {
    const chunks = [
      {
        index: 0,
        delta: { role: "assistant", content: input.content },
        finish_reason: null,
      },
      { index: 0, delta: {}, finish_reason: "stop" },
    ]
    const body = `${chunks
      .map(
        (choice) =>
          `data: ${JSON.stringify({
            id: `completion-${modelRequests.length}`,
            object: "chat.completion.chunk",
            created: 1,
            model,
            choices: [choice],
          })}\n\n`,
      )
      .join("")}data: [DONE]\n\n`
    return new HttpResponse(body, {
      headers: { "content-type": "text/event-stream" },
    })
  }
  return HttpResponse.json({
    id: `completion-${modelRequests.length}`,
    object: "chat.completion",
    created: 1,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: input.content },
        finish_reason: "stop",
      },
    ],
  })
}

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
useMswServer(
  http.post("http://model.test/v1/chat/completions", async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>
    modelRequests.push(body)
    const serialized = JSON.stringify(body.messages ?? [])
    const content = serialized.includes(SECOND_USER)
      ? SECOND_ASSISTANT
      : serialized.includes(FIRST_USER)
        ? FIRST_ASSISTANT
        : "Billing thread"
    return openaiCompatibleChatResponse({
      content,
      stream: Boolean(body.stream),
    })
  }),
  http.all("http://model.test/*", () =>
    HttpResponse.json({ object: "list", data: [] }),
  ),
)

describeWithDatabase("ctx_advisor persisted turn replay", () => {
  let seed: SeededOrg

  beforeAll(async () => {
    seed = await seedOrg()
    vi.stubEnv("MODEL_PROVIDER", "openai-like")
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
    vi.stubEnv("MODEL_PROVIDER_URL", "http://model.test/v1")
    vi.stubEnv("MODEL_FAST_NAME", "openai/gpt-5.6-terra")
    vi.stubEnv("SANDBOX_PROVIDER", "unsandboxed")
    vi.stubEnv("AUTH_BASE_URL", "http://127.0.0.1")
  })

  afterAll(async () => {
    if (!seed) return
    await getSystemDb()
      .delete(conversations)
      .where(eq(conversations.orgId, seed.orgId))
    await getSystemDb()
      .delete(workspaces)
      .where(eq(workspaces.orgId, seed.orgId))
    await cleanupSeededOrg(seed)
  })

  function orgThreadId(conversationId: string) {
    return mcpAdvisorThreadId({
      orgId: seed.orgId,
      actor: { type: "org-service", orgId: seed.orgId },
      currentProjectName: PROJECT,
      conversationId,
    })
  }

  it("replays persisted first-turn messages into the OpenCode list for the same advisor thread", async () => {
    const threadId = orgThreadId("session-persisted")
    const firstUser = `Project: ${PROJECT}\n\n${FIRST_USER}`
    const secondUser = `Project: ${PROJECT}\n\n${SECOND_USER}`
    await withOrgIdContext({ id: seed.orgId, slug: seed.orgSlug }, async () => {
      const persistence = workspaceChatPersistence()
      await persistence.stores.messages.saveThread(threadId, [
        { role: "user", content: firstUser },
        { role: "assistant", content: FIRST_ASSISTANT },
      ])
      const loaded = await persistence.stores.messages.loadThread(threadId)
      const replayed = messagesForOpenCodeChat(loaded, secondUser)
      expect(replayed).toEqual([
        { role: "user", content: firstUser },
        { role: "assistant", content: FIRST_ASSISTANT },
        { role: "user", content: secondUser },
      ])
    })
  })

  it(
    "includes first user and assistant turns on the second successful MCP HTTP call",
    { timeout: 150_000 },
    async () => {
      const threadId = orgThreadId(SESSION)
      expect(threadId).toBe(`${seed.orgId}_org_${PROJECT}_${SESSION}`)
      const chat = await startMcpAdvisorHttpChat({
        orgId: seed.orgId,
        orgSlug: seed.orgSlug,
      })
      modelRequests.length = 0
      workspaceChatDockerOwnership.reset()
      workspaceChatInstanceAccess.reset()
      const org = { id: seed.orgId, slug: seed.orgSlug }
      try {
        const callAdvisor = async (prompt: string) => {
          const response = await fetch(`${chat.origin}/mcp`, {
            method: "POST",
            headers: {
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
              "x-api-key": seed.orgApiKey,
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name: "ctx_advisor",
                arguments: {
                  prompt,
                  conversationId: SESSION,
                  currentProjectName: PROJECT,
                },
              },
            }),
          })
          const body = await response.text()
          return { status: response.status, result: mcpToolResult(body) }
        }

        const first = await callAdvisor(FIRST_USER)
        expect(first.status).toBe(200)
        expect(first.result.isError).not.toBe(true)
        expect(mcpToolText(first.result)).toContain(FIRST_ASSISTANT)

        const created = await conversationRow(threadId)
        expect(created).toMatchObject({
          id: threadId,
          userId: null,
          source: "mcp",
        })

        const second = await callAdvisor(SECOND_USER)
        expect(second.status).toBe(200)
        expect(second.result.isError).not.toBe(true)
        expect(mcpToolText(second.result)).toContain(SECOND_ASSISTANT)

        const resumed = await conversationRow(threadId)
        expect(resumed?.id).toBe(threadId)
        expect(resumed?.createdAt).toEqual(created?.createdAt)

        const chatTurns = modelRequests.filter((request) => {
          const serialized = JSON.stringify(request.messages ?? [])
          return (
            serialized.includes(FIRST_USER) || serialized.includes(SECOND_USER)
          )
        })
        expect(chatTurns.length).toBeGreaterThanOrEqual(2)
        const secondOutbound = chatTurns.find((request) =>
          JSON.stringify(request.messages ?? []).includes(SECOND_USER),
        )
        expect(secondOutbound).toBeDefined()
        const secondMessages = JSON.stringify(secondOutbound?.messages ?? [])
        expect(secondMessages).toContain(FIRST_USER)
        expect(secondMessages).toContain(FIRST_ASSISTANT)
        expect(secondMessages).toContain(SECOND_USER)
      } finally {
        let instances: Awaited<ReturnType<typeof listSandboxInstances>> = []
        try {
          instances = await withOrgDbContext(seed.orgId, () =>
            listSandboxInstances({ workspaceId: chat.workspaceId }),
          )
          await withOrgIdContext(org, () =>
            withTestLogger(() =>
              destroySandboxesForWorkspace(chat.workspaceId),
            ),
          )
          await withOrgDbContext(seed.orgId, async (db) => {
            for (const table of [
              chatInterrupts,
              chatMetadata,
              chatRuns,
              chatThreads,
            ]) {
              await db.delete(table).where(eq(table.orgId, seed.orgId))
            }
            await db
              .delete(conversations)
              .where(eq(conversations.orgId, seed.orgId))
            await db
              .delete(orgFirstWorkspaces)
              .where(eq(orgFirstWorkspaces.orgId, seed.orgId))
            await db
              .delete(workspaces)
              .where(eq(workspaces.id, chat.workspaceId))
          })
        } finally {
          try {
            await chat.close()
          } finally {
            for (const thread of new Set([
              threadId,
              ...instances.flatMap((instance) =>
                instance.conversationId ? [instance.conversationId] : [],
              ),
            ])) {
              await rmOpenCodeHome(thread)
            }
          }
        }
      }
    },
  )
})

async function conversationRow(id: string) {
  const [row] = await getSystemDb()
    .select({
      id: conversations.id,
      userId: conversations.userId,
      source: conversations.source,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1)
  return row
}

async function rmOpenCodeHome(threadId: string) {
  await rm(workspaceChatOpenCodeHomeDir(threadId), {
    recursive: true,
    force: true,
  })
}
