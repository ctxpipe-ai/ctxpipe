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
import { mcpToolResult, mcpToolText } from "../../test/mcp-tool-result.js"
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

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
useMswServer(
  http.all("http://model.test/*", () =>
    HttpResponse.json(
      { error: { message: "nope", type: "invalid_request_error" } },
      { status: 400 },
    ),
  ),
)

describeWithDatabase("org-service ctx_advisor", () => {
  let seed: SeededOrg
  const workspaceId = generateObjectId("ws")

  beforeAll(async () => {
    seed = await seedOrg()
    vi.stubEnv("MODEL_PROVIDER", "openai-like")
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
    vi.stubEnv("MODEL_PROVIDER_URL", "http://model.test/v1")
    vi.stubEnv(
      "DOCKER_HOST",
      `unix:///tmp/ctxpipe-missing-docker-${Date.now()}.sock`,
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

  async function callAdvisor(headers: HeadersInit, orgSlug?: string) {
    const path = orgSlug ? `/mcp?orgSlug=${orgSlug}` : "/mcp"
    return createApp().request(path, {
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
          arguments: { prompt: "What ADRs apply?" },
        },
      }),
    })
  }

  it("org key without a Workspace fails without requiring a user", async () => {
    const response = await callAdvisor({ "x-api-key": seed.orgApiKey })
    expect(response.status).toBe(200)
    const result = mcpToolResult(await response.text())
    expect(result.isError).toBe(true)
    const text = mcpToolText(result)
    expect(text).toContain("Create a Workspace")
    expect(text).not.toContain("Missing user context")
  })

  it("persists an org-key ctx_advisor turn as a null-user MCP conversation", async () => {
    await withOrgDbContext(seed.orgId, (db) =>
      db.insert(workspaces).values({
        id: workspaceId,
        orgId: seed.orgId,
        slug: "context",
        displayName: "Context",
        workspaceRepositoryUrl: `/tmp/org-mcp-${seed.orgId}`,
        desiredDefaultBranch: "main",
        writeStatus: "read_only",
      }),
    )

    const response = await callAdvisor({ "x-api-key": seed.orgApiKey })
    expect(response.status).toBe(200)
    const result = mcpToolResult(await response.text())
    expect(mcpToolText(result)).not.toContain("Missing user context")

    const rows = await getSystemDb()
      .select({
        id: conversations.id,
        userId: conversations.userId,
        source: conversations.source,
        workspaceId: conversations.workspaceId,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.orgId, seed.orgId),
          isNull(conversations.userId),
          eq(conversations.source, "mcp"),
        ),
      )
    expect(rows).toEqual([
      expect.objectContaining({
        userId: null,
        source: "mcp",
        workspaceId,
      }),
    ])
    expect(rows[0]?.id.startsWith("conv_")).toBe(true)
  }, 20_000)

  it("keeps a personal API key conversation scoped to that user", async () => {
    const response = await callAdvisor(
      { "x-api-key": seed.personalApiKey },
      seed.orgSlug,
    )
    expect(response.status).toBe(200)
    const result = mcpToolResult(await response.text())
    expect(mcpToolText(result)).not.toContain("Missing user context")

    const rows = await getSystemDb()
      .select({
        userId: conversations.userId,
        source: conversations.source,
        workspaceId: conversations.workspaceId,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.orgId, seed.orgId),
          eq(conversations.userId, seed.userId),
          eq(conversations.source, "mcp"),
        ),
      )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: seed.userId,
          source: "mcp",
          workspaceId,
        }),
      ]),
    )
  }, 20_000)
})
