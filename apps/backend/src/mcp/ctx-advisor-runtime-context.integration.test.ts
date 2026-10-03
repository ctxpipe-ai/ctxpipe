import { rm } from "node:fs/promises"
import { eq } from "drizzle-orm"
import { HttpResponse, http, passthrough } from "msw"
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
import { withOrgDbContext } from "../db/client.js"
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
import { destroySandboxesForWorkspace } from "../domain/workspaces/workspace-sandbox-cleanup.js"
import { listSandboxInstances } from "../models/workspaces.js"
import { startMcpAdvisorHttpChat } from "../test/mcp-advisor-http-chat.js"
import { withTestLogger } from "../test/with-test-logger.js"
import { mcpAdvisorThreadId } from "./advisorThread.js"

const PROMPT = "Which environment tag identifies this preview?"
const PROJECT = "billing"
const SESSION = "runtime-context"

const modelRequests: Array<Record<string, unknown>> = []

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
useMswServer(
  http.all(/^http:\/\/127\.0\.0\.1:/, () => passthrough()),
  http.all("https://dash.better-auth.com/*", () => passthrough()),
  http.post("http://model.test/v1/chat/completions", async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>
    modelRequests.push(body)
    const chunks = [
      {
        index: 0,
        delta: { role: "assistant", content: "Runtime context received." },
        finish_reason: null,
      },
      { index: 0, delta: {}, finish_reason: "stop" },
    ]
    const stream = `${chunks
      .map(
        (choice) =>
          `data: ${JSON.stringify({
            id: `completion-${modelRequests.length}`,
            object: "chat.completion.chunk",
            created: 1,
            model: "openai/gpt-5.6-terra",
            choices: [choice],
          })}\n\n`,
      )
      .join("")}data: [DONE]\n\n`
    return new HttpResponse(stream, {
      headers: { "content-type": "text/event-stream" },
    })
  }),
  http.all("http://model.test/*", () =>
    HttpResponse.json({ object: "list", data: [] }),
  ),
)

describeWithDatabase("ctx_advisor runtime process context", () => {
  let seed: SeededOrg

  beforeAll(async () => {
    seed = await seedOrg()
    vi.stubEnv("MODEL_PROVIDER", "openai-like")
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
    vi.stubEnv("MODEL_PROVIDER_URL", "http://model.test/v1")
    vi.stubEnv("MODEL_FAST_NAME", "openai/gpt-5.6-terra")
    vi.stubEnv("SANDBOX_PROVIDER", "unsandboxed")
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "pr-19")
    vi.stubEnv("AUTH_BASE_URL", "https://advisor-pr-19.example.test")
  })

  afterAll(async () => {
    if (!seed) return
    await withOrgDbContext(seed.orgId, async (db) => {
      for (const table of [chatInterrupts, chatMetadata, chatRuns, chatThreads])
        await db.delete(table).where(eq(table.orgId, seed.orgId))
      await db.delete(conversations).where(eq(conversations.orgId, seed.orgId))
      await db.delete(workspaces).where(eq(workspaces.orgId, seed.orgId))
    })
    await cleanupSeededOrg(seed)
  })

  it(
    "includes this process environment and origin in the MCP model request",
    { timeout: 150_000 },
    async () => {
      const threadId = mcpAdvisorThreadId({
        orgId: seed.orgId,
        actor: { type: "user", userId: seed.userId },
        currentProjectName: PROJECT,
        conversationId: SESSION,
      })
      const chat = await startMcpAdvisorHttpChat({
        orgId: seed.orgId,
        orgSlug: seed.orgSlug,
      })
      modelRequests.length = 0
      workspaceChatDockerOwnership.reset()
      workspaceChatInstanceAccess.reset()
      const org = { id: seed.orgId, slug: seed.orgSlug }
      try {
        const response = await fetch(
          `${chat.origin}/mcp?orgSlug=${seed.orgSlug}`,
          {
            method: "POST",
            headers: {
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
              "x-api-key": seed.personalApiKey,
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name: "ctx_advisor",
                arguments: {
                  prompt: PROMPT,
                  conversationId: SESSION,
                  currentProjectName: PROJECT,
                },
              },
            }),
          },
        )
        const body = await response.text()
        expect(response.status).toBe(200)
        const result = mcpToolResult(body)
        expect(result.isError, mcpToolText(result)).not.toBe(true)
        expect(mcpToolText(result)).toContain("Runtime context received.")

        const outbound = modelRequests.find((request) =>
          JSON.stringify(request.messages ?? []).includes(PROMPT),
        )
        expect(outbound).toBeDefined()
        const sent = JSON.stringify(outbound?.messages ?? [])
        expect(sent).toContain("deployment.environment: pr-19")
        expect(sent).toContain(
          "public origin: https://advisor-pr-19.example.test",
        )
        expect(sent).toContain(
          "Retrieved documents may mention other environment ids or hosts",
        )
        expect(sent).not.toContain("s3cret")
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
          await chat.close()
          for (const thread of new Set([
            threadId,
            ...instances.flatMap((instance) =>
              instance.conversationId ? [instance.conversationId] : [],
            ),
          ])) {
            await rm(workspaceChatOpenCodeHomeDir(thread), {
              recursive: true,
              force: true,
            })
          }
        }
      }
    },
  )
})
