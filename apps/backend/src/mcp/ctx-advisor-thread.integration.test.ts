import { and, eq, isNull } from "drizzle-orm"
import { evlog } from "evlog/hono"
import { Hono } from "hono"
import { contextStorage } from "hono/context-storage"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, expect, it, vi } from "vitest"
import {
  cleanupSeededOrg,
  describeWithDatabase,
  type SeededOrg,
  seedOrg,
} from "../../test/db.js"
import { useMswServer } from "../../test/msw.js"
import type { AppEnv } from "../app/env.js"
import { parseEnv } from "../config/env.js"
import { getSystemDb, withOrgDbContext } from "../db/client.js"
import { conversations } from "../db/schema/conversations.js"
import { workspaces } from "../db/schema/workspaces.js"
import { generateObjectId } from "../lib/id.js"
import { backendOtelMiddleware } from "../observability/http.js"
import { registerMcpRoutes } from "../routes/mcp.js"
import { withTestRequestLogger } from "../test/hono-test-logger.js"
import { mcpAdvisorThreadId } from "./advisorThread.js"

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
useMswServer(
  http.all("http://model.test/*", () =>
    HttpResponse.json(
      { error: { message: "nope", type: "invalid_request_error" } },
      { status: 400 },
    ),
  ),
)

describeWithDatabase("ctx_advisor conversation continuity", () => {
  let seed: SeededOrg
  const workspaceId = generateObjectId("ws")
  const project = "billing"
  const sessionA = "session-a"
  const sessionB = "session-b"

  beforeAll(async () => {
    seed = await seedOrg()
    vi.stubEnv("MODEL_PROVIDER", "openai-like")
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
    vi.stubEnv("MODEL_PROVIDER_URL", "http://model.test/v1")
    vi.stubEnv(
      "DOCKER_HOST",
      `unix:///tmp/ctxpipe-missing-docker-${Date.now()}.sock`,
    )
    await withOrgDbContext(seed.orgId, (db) =>
      db.insert(workspaces).values({
        id: workspaceId,
        orgId: seed.orgId,
        slug: "context",
        displayName: "Context",
        workspaceRepositoryUrl: `/tmp/mcp-thread-${seed.orgId}`,
        desiredDefaultBranch: "main",
        writeStatus: "read_only",
      }),
    )
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
      currentProjectName: project,
      conversationId,
    })
  }

  function userThreadId(conversationId: string) {
    return mcpAdvisorThreadId({
      orgId: seed.orgId,
      actor: { type: "user", userId: seed.userId },
      currentProjectName: project,
      conversationId,
    })
  }

  function createApp() {
    const app = new Hono<AppEnv>()
    app.use(contextStorage())
    app.use(withTestRequestLogger)
    app.use("*", backendOtelMiddleware())
    app.use(evlog())
    app.use("*", async (c, next) => {
      c.set("env", parseEnv(process.env as Record<string, string | undefined>))
      c.set("user", null)
      c.set("session", null)
      c.set("oauthOrganizationId", null)
      c.set("oauthClientId", null)
      c.set("orgApiKey", null)
      c.set("personalApiKeyId", null)
      c.set("orgSlug", null)
      c.set("orgId", null)
      await next()
    })
    registerMcpRoutes(app)
    return app
  }

  async function callAdvisor(
    headers: HeadersInit,
    args: Record<string, unknown>,
    orgSlug?: string,
  ) {
    const path = orgSlug ? `/mcp?orgSlug=${orgSlug}` : "/mcp"
    const response = await createApp().request(path, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "ctx_advisor",
          arguments: { prompt: "What ADRs apply?", ...args },
        },
      }),
    })
    // Streamable HTTP can return headers before the tool persists.
    await response.text()
    return response
  }

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

  it("resumes the same org-service conversation when conversationId repeats", async () => {
    const id = orgThreadId(sessionA)
    expect(id).toBe(`${seed.orgId}_org_${project}_${sessionA}`)
    const first = await callAdvisor(
      { "x-api-key": seed.orgApiKey },
      { conversationId: sessionA, currentProjectName: project },
    )
    expect(first.status).toBe(200)
    const created = await conversationRow(id)
    expect(created).toMatchObject({
      id,
      userId: null,
      source: "mcp",
    })

    const second = await callAdvisor(
      { "x-api-key": seed.orgApiKey },
      { conversationId: sessionA, currentProjectName: project },
    )
    expect(second.status).toBe(200)
    const resumed = await conversationRow(id)
    expect(resumed?.id).toBe(id)
    expect(resumed?.createdAt).toEqual(created?.createdAt)

    const orgServiceRows = await getSystemDb()
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.orgId, seed.orgId),
          isNull(conversations.userId),
          eq(conversations.source, "mcp"),
          eq(conversations.id, id),
        ),
      )
    expect(orgServiceRows).toHaveLength(1)
  }, 20_000)

  it("separates org-service conversations when conversationId changes", async () => {
    const idA = orgThreadId(sessionA)
    const idB = orgThreadId(sessionB)
    const response = await callAdvisor(
      { "x-api-key": seed.orgApiKey },
      { conversationId: sessionB, currentProjectName: project },
    )
    expect(response.status).toBe(200)
    expect(idA).not.toBe(idB)
    expect(await conversationRow(idA)).toMatchObject({ id: idA, userId: null })
    expect(await conversationRow(idB)).toMatchObject({ id: idB, userId: null })
  }, 20_000)

  it("resumes the same member conversation when conversationId repeats", async () => {
    const id = userThreadId(sessionA)
    expect(id).toBe(`${seed.orgId}_${seed.userId}_${project}_${sessionA}`)
    await callAdvisor(
      { "x-api-key": seed.personalApiKey },
      { conversationId: sessionA, currentProjectName: project },
      seed.orgSlug,
    )
    const created = await conversationRow(id)
    expect(created).toMatchObject({
      id,
      userId: seed.userId,
      source: "mcp",
    })

    await callAdvisor(
      { "x-api-key": seed.personalApiKey },
      { conversationId: sessionA, currentProjectName: project },
      seed.orgSlug,
    )
    const resumed = await conversationRow(id)
    expect(resumed?.createdAt).toEqual(created?.createdAt)
  }, 20_000)

  it("keeps org-service and member threads apart for the same client conversationId", async () => {
    const shared = "session-shared"
    const orgId = orgThreadId(shared)
    const userId = userThreadId(shared)
    await callAdvisor(
      { "x-api-key": seed.orgApiKey },
      { conversationId: shared, currentProjectName: project },
    )
    await callAdvisor(
      { "x-api-key": seed.personalApiKey },
      { conversationId: shared, currentProjectName: project },
      seed.orgSlug,
    )
    expect(orgId).not.toBe(userId)
    expect(await conversationRow(orgId)).toMatchObject({
      id: orgId,
      userId: null,
    })
    expect(await conversationRow(userId)).toMatchObject({
      id: userId,
      userId: seed.userId,
    })
  }, 20_000)

  it("creates a new random conversation when conversationId is omitted", async () => {
    await callAdvisor({ "x-api-key": seed.orgApiKey }, {})
    await callAdvisor({ "x-api-key": seed.orgApiKey }, {})
    const rows = await getSystemDb()
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.orgId, seed.orgId),
          isNull(conversations.userId),
          eq(conversations.source, "mcp"),
        ),
      )
    const randomIds = rows
      .map((row) => row.id)
      .filter((id) => id.startsWith("conv_"))
    expect(randomIds.length).toBeGreaterThanOrEqual(2)
    expect(new Set(randomIds).size).toBe(randomIds.length)
  }, 20_000)
})
